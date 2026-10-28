import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdirSync, lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { identifier, metadata, jsonValue, nativeUpdate, emptyUpdate, digest, MAX_BYTES } from './validation.js'

const APPLICATION_ID = 1162889293
const ACCESS = Symbol('Vault construction')

// The caller selects a trusted local directory. IDs never become file paths.
function directoryPath(directory, create) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || [...directory].some(char => char.charCodeAt(0) < 32) || directory.split(/[\\/]/).includes('..')) throw new Error('Expected an absolute Vault directory without traversal')
  const resolved = path.resolve(directory)
  if (resolved === path.parse(resolved).root || (process.platform === 'win32' && (resolved.startsWith('\\\\') || resolved.slice(2).includes(':')))) throw new Error('Invalid Vault directory')
  let current = path.parse(resolved).root
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    if (create && current === resolved) break
    const stat = lstatSync(current)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Vault paths must be real local directories')
  }
  if (create) mkdirSync(resolved, { mode: 0o700 }) // Exclusive; never reuse a destination.
  return realpathSync(resolved)
}

export class ConflictError extends Error {
  constructor() { super('Stale note version or content hash'); this.name = 'ConflictError' }
}

export class NativeVault {
  #db
  #closed = false

  static create(directory) { return new NativeVault(ACCESS, directory, true) }
  static open(directory) { return new NativeVault(ACCESS, directory, false) }

  constructor(access, directory, create) {
    if (access !== ACCESS) throw new Error('Use NativeVault.create or NativeVault.open')
    const [major, minor] = process.versions.node.split('.').map(Number)
    if (major < 24 || (major === 24 && minor < 15)) throw new Error('Native Vault requires Node >=24.15')
    const root = directoryPath(directory, create)
    this.directory = root
    const file = path.join(root, 'vault.sqlite')
    if (!create) {
      const stat = lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Invalid Vault database file')
    }
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try {
        const stat = lstatSync(file + suffix)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Invalid SQLite sidecar')
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    try {
      this.#db = new DatabaseSync(file, { timeout: 5000, enableForeignKeyConstraints: true, allowExtension: false })
      if (create) {
        this.#db.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA synchronous = FULL;
          BEGIN IMMEDIATE;
          PRAGMA application_id = ${APPLICATION_ID};
          PRAGMA user_version = 1;
          CREATE TABLE notes (
            id TEXT PRIMARY KEY, metadata TEXT NOT NULL, document BLOB NOT NULL,
            content_hash TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0),
            deleted TEXT, recovery INTEGER NOT NULL DEFAULT 0 CHECK(recovery IN (0,1)),
            legacy TEXT NOT NULL, content_state TEXT NOT NULL
          ) STRICT;
          CREATE TABLE attachments (
            note_id TEXT NOT NULL REFERENCES notes(id), id TEXT NOT NULL,
            metadata TEXT NOT NULL, bytes BLOB NOT NULL, sha256 TEXT NOT NULL,
            PRIMARY KEY(note_id, id)
          ) STRICT;
          CREATE TABLE changes (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT, note_id TEXT NOT NULL REFERENCES notes(id),
            version INTEGER NOT NULL, kind TEXT NOT NULL, content_hash TEXT NOT NULL,
            recorded_at TEXT NOT NULL
          ) STRICT;
          CREATE TABLE imports (sha256 TEXT PRIMARY KEY, original TEXT NOT NULL) STRICT;
          COMMIT;
        `)
      } else {
        if (this.#db.prepare('PRAGMA application_id').get().application_id !== APPLICATION_ID ||
            this.#db.prepare('PRAGMA user_version').get().user_version !== 1) throw new Error('Unsupported Vault schema')
        if (this.#db.prepare('PRAGMA quick_check').get().quick_check !== 'ok' || this.#db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Corrupt Vault')
        // Fail closed on incomplete schemas before accepting writes.
        for (const table of ['notes', 'attachments', 'changes', 'imports']) this.#db.prepare(`SELECT * FROM ${table} LIMIT 0`).all()
        this.#db.exec('PRAGMA synchronous = FULL')
      }
    } catch (error) { this.#db?.close(); throw error }
  }

  #transaction(operation) {
    if (this.#closed) throw new Error('Vault is closed')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      // SQLite can automatically roll back after an I/O error.
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK')
      throw error
    }
  }

  #row(id) {
    identifier(id)
    if (this.#closed) throw new Error('Vault is closed')
    const row = this.#db.prepare('SELECT * FROM notes WHERE id = ?').get(id)
    if (!row) throw new Error('Note not found')
    if (digest(row.document) !== row.content_hash) throw new Error('Native document integrity failure')
    return row
  }

  #view(row) {
    return { id: row.id, metadata: JSON.parse(row.metadata), document: Uint8Array.from(row.document),
      contentHash: row.content_hash, version: row.version, deleted: row.deleted === null ? null : JSON.parse(row.deleted),
      recovery: Boolean(row.recovery), legacyRecords: JSON.parse(row.legacy), contentState: row.content_state }
  }

  read(id) { return this.#view(this.#row(id)) }

  list({ includeDeleted = false, includeRecovery = false } = {}) {
    if (this.#closed) throw new Error('Vault is closed')
    return this.#db.prepare('SELECT id FROM notes WHERE (? OR deleted IS NULL) AND (? OR recovery = 0) ORDER BY id')
      .all(Number(includeDeleted), Number(includeRecovery)).map(({ id }) => this.read(id))
  }

  #parent(id, parentId) {
    const seen = new Set([id])
    while (parentId != null) {
      if (seen.has(parentId)) throw new Error('Invalid page hierarchy')
      seen.add(parentId)
      const parent = this.#row(parentId)
      if (parent.deleted !== null || parent.recovery) throw new Error('Parent is deleted or recovery-only')
      parentId = JSON.parse(parent.metadata).parentId
    }
  }

  #journal(id, version, kind, hash) {
    this.#db.prepare('INSERT INTO changes(note_id,version,kind,content_hash,recorded_at) VALUES(?,?,?,?,?)')
      .run(id, version, kind, hash, new Date().toISOString())
  }

  #insert({ id, metadata: fields, document, deleted = null, recovery = false, legacyRecords = [], contentState = 'native' }, kind) {
    identifier(id)
    const encoded = metadata(fields), bytes = nativeUpdate(document), hash = digest(bytes)
    this.#db.prepare('INSERT INTO notes(id,metadata,document,content_hash,version,deleted,recovery,legacy,content_state) VALUES(?,?,?,?,1,?,?,?,?)')
      .run(id, encoded, bytes, hash, deleted === null ? null : jsonValue(deleted), Number(recovery), jsonValue(legacyRecords), contentState)
    this.#journal(id, 1, kind, hash)
  }

  create({ id = randomUUID(), metadata: fields = {}, document = emptyUpdate() } = {}) {
    metadata(fields)
    return this.#transaction(() => {
      const values = { title: '', parentId: null, ...fields }
      this.#parent(id, values.parentId)
      this.#insert({ id, metadata: values, document }, 'create')
      return this.read(id)
    })
  }

  #expected(row, expected) {
    if (!expected || !Number.isSafeInteger(expected.version) || expected.version !== row.version ||
        (expected.contentHash !== undefined && expected.contentHash !== row.content_hash)) throw new ConflictError()
  }

  #change(id, expected, kind, mutate) {
    return this.#transaction(() => {
      const row = this.#row(id)
      this.#expected(row, expected)
      const next = this.#view(row)
      mutate(next)
      const encoded = metadata(next.metadata), bytes = nativeUpdate(next.document), hash = digest(bytes)
      this.#db.prepare('UPDATE notes SET metadata=?,document=?,content_hash=?,version=version+1,deleted=? WHERE id=?')
        .run(encoded, bytes, hash, next.deleted === null ? null : jsonValue(next.deleted), id)
      this.#journal(id, row.version + 1, kind, hash)
      return this.read(id)
    })
  }

  update(id, changes, expected) {
    if (!changes || Object.keys(changes).some(key => !['metadata', 'document'].includes(key))) throw new Error('Invalid note update')
    return this.#change(id, expected, 'update', next => {
      if (next.deleted !== null || next.recovery) throw new Error('Cannot edit a deleted or recovery-only note')
      if (changes.metadata !== undefined) {
        metadata(changes.metadata)
        next.metadata = { ...next.metadata, ...changes.metadata }
        if (Object.hasOwn(changes.metadata, 'parentId')) this.#parent(id, next.metadata.parentId)
      }
      if (changes.document !== undefined) {
        if (next.contentState !== 'native') throw new Error('Legacy-only content requires an explicit lossless conversion before editing')
        next.document = changes.document
      }
    })
  }

  rename(id, title, expected) { return this.update(id, { metadata: { title } }, expected) }
  move(id, parentId, expected) { return this.update(id, { metadata: { parentId } }, expected) }
  delete(id, expected) {
    return this.#change(id, expected, 'delete', next => {
      if (next.deleted !== null) throw new Error('Note already deleted')
      next.deleted = { deletedAt: Date.now(), metadata: next.metadata }
    })
  }
  restore(id, expected) {
    return this.#change(id, expected, 'restore', next => {
      if (next.deleted === null) throw new Error('Note is not deleted')
      next.deleted = null
      next.metadata.parentId = null
    })
  }

  putAttachment(noteId, { id = randomUUID(), bytes, metadata: fields = {} }, expected) {
    identifier(id)
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX_BYTES) throw new Error('Invalid attachment')
    const encoded = jsonValue(fields), copy = Buffer.from(bytes), hash = digest(copy)
    return this.#change(noteId, expected, 'attachment', next => {
      if (next.deleted !== null || next.recovery) throw new Error('Cannot attach to a deleted or recovery-only note')
      this.#db.prepare('INSERT INTO attachments(note_id,id,metadata,bytes,sha256) VALUES(?,?,?,?,?)')
        .run(noteId, id, encoded, copy, hash)
    })
  }

  readAttachment(noteId, id) {
    this.#row(noteId); identifier(id)
    const row = this.#db.prepare('SELECT * FROM attachments WHERE note_id=? AND id=?').get(noteId, id)
    if (!row) throw new Error('Attachment not found')
    if (digest(row.bytes) !== row.sha256) throw new Error('Attachment integrity failure')
    return { id, bytes: Uint8Array.from(row.bytes), metadata: JSON.parse(row.metadata), sha256: row.sha256 }
  }

  listAttachments(noteId) {
    this.#row(noteId)
    return this.#db.prepare('SELECT id,metadata,sha256,length(bytes) AS size FROM attachments WHERE note_id=? ORDER BY id')
      .all(noteId).map(row => ({ ...row, metadata: JSON.parse(row.metadata) }))
  }

  changes({ after = 0, limit = 1000 } = {}) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error('Invalid change cursor')
    return this.#db.prepare('SELECT * FROM changes WHERE sequence > ? ORDER BY sequence LIMIT ?').all(after, limit).map(row => ({ ...row }))
  }

  // An import is only allowed into an empty Vault. The validator is always run
  // here so future transports cannot bypass it with a fabricated parsed object.
  async importBackup(text) {
    const { validateImport } = await import('./importBackup.js')
    const { notes, sha256 } = await validateImport(text)
    return this.#transaction(() => {
      const previous = this.#db.prepare('SELECT original FROM imports WHERE sha256=?').get(sha256)
      if (previous) return { imported: false, sha256, count: notes.length }
      if (this.#db.prepare('SELECT count(*) AS count FROM notes').get().count || this.#db.prepare('SELECT count(*) AS count FROM imports').get().count) throw new Error('Import requires an empty isolated Vault')
      for (const note of notes) this.#insert(note, 'import')
      this.#db.prepare('INSERT INTO imports(sha256,original) VALUES(?,?)').run(sha256, text)
      return { imported: true, sha256, count: notes.length }
    })
  }

  readImport(sha256) {
    const row = this.#db.prepare('SELECT original FROM imports WHERE sha256=?').get(sha256)
    if (!row) throw new Error('Import archive not found')
    return row.original
  }

  close() {
    if (!this.#closed) { this.#db.close(); this.#closed = true }
  }
}
