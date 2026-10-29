import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { lstatSync, existsSync } from 'node:fs'
import path from 'node:path'
import { identifier, metadata, jsonValue, nativeUpdate, emptyUpdate, digest, MAX_BYTES } from './validation.js'
import { directoryPath } from './paths.js'
import { APPLICATION_ID, verifyDatabase } from './integrity.js'
import { exportSnapshot } from './backup.js'
import { projectText, searchProjection, pageOptions } from './textProjection.js'
import { convertPlainLegacy } from './legacyCodec.js'
import { SyncStore, migrateSync } from './sync/store.js'
import { snapshot, decode, equal } from './sync/protocol.js'

const ACCESS = Symbol('Vault construction')

export class ConflictError extends Error {
  constructor() { super('Stale note version or content hash'); this.name = 'ConflictError' }
}

export class NativeVault {
  #db
  #closed = false
  #backups = 0
  #readOnly = false
  #applyingSync = false

  static create(directory) { return new NativeVault(ACCESS, directory, true) }
  static open(directory, { readOnly = false } = {}) { return new NativeVault(ACCESS, directory, false, readOnly) }

  constructor(access, directory, create, readOnly = false) {
    if (access !== ACCESS) throw new Error('Use NativeVault.create or NativeVault.open')
    const [major, minor] = process.versions.node.split('.').map(Number)
    if (major < 24 || (major === 24 && minor < 15)) throw new Error('Native Vault requires Node >=24.15')
    const root = directoryPath(directory, create)
    if (existsSync(path.join(root, '.restoring'))) throw new Error('Incomplete restore; Vault is not published')
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
      this.#readOnly = readOnly
      this.#db = new DatabaseSync(file, { readOnly, timeout: 5000, enableForeignKeyConstraints: true, allowExtension: false })
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
            ![1,2].includes(this.#db.prepare('PRAGMA user_version').get().user_version)) throw new Error('Unsupported Vault schema')
        if (this.#db.prepare('PRAGMA quick_check').get().quick_check !== 'ok' || this.#db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Corrupt Vault')
        // Fail closed on incomplete schemas before accepting writes.
        for (const table of ['notes', 'attachments', 'changes', 'imports']) this.#db.prepare(`SELECT * FROM ${table} LIMIT 0`).all()
        if (!readOnly) this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL')
      }
      if (!readOnly && !this.#db.prepare("SELECT name FROM sqlite_schema WHERE name='search_fts'").get()) this.rebuildSearch()
    } catch (error) { this.#db?.close(); throw error }
  }

  #transaction(operation) {
    if (this.#closed) throw new Error('Vault is closed')
    if (this.#readOnly) throw new Error('Vault is read-only')
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
    const result = this.#db.prepare('INSERT INTO changes(note_id,version,kind,content_hash,recorded_at) VALUES(?,?,?,?,?)')
      .run(id, version, kind, hash, new Date().toISOString())
    this.#index(id)
    if (!this.#applyingSync && this.#db.prepare('PRAGMA user_version').get().user_version === 2) this.#sync().record(id, Number(result.lastInsertRowid))
  }

  #index(id) {
    const note = this.read(id), projection = searchProjection(note)
    this.#db.prepare('DELETE FROM search_fts WHERE note_id=?').run(id)
    this.#db.prepare('INSERT INTO search_fts(note_id,text,coverage,reasons,version) VALUES(?,?,?,?,?)')
      .run(id, projection.indexedText, projection.coverage, JSON.stringify(projection.reasons), note.version)
  }

  rebuildSearch() {
    return this.#transaction(() => {
      this.#db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(note_id UNINDEXED,text,coverage UNINDEXED,reasons UNINDEXED,version UNINDEXED,tokenize='trigram')")
      this.#db.exec('DELETE FROM search_fts')
      for (const { id } of this.#db.prepare('SELECT id FROM notes ORDER BY id').all()) this.#index(id)
      return this.#db.prepare('SELECT count(*) AS count FROM search_fts').get().count
    })
  }

  verifySearch() {
    return this.#transaction(() => {
      this.#db.exec("INSERT INTO search_fts(search_fts) VALUES('integrity-check')")
      const rows = this.#db.prepare('SELECT * FROM search_fts ORDER BY note_id').all()
      const notes = this.list({ includeDeleted: true, includeRecovery: true })
      if (rows.length !== notes.length) throw new Error('Search index mismatch; rebuild required')
      for (let i = 0; i < notes.length; i++) {
        const note = notes[i], row = rows[i], expected = searchProjection(note)
        if (row.note_id !== note.id || Number(row.version) !== note.version || row.text !== expected.indexedText || row.coverage !== expected.coverage || row.reasons !== JSON.stringify(expected.reasons)) throw new Error('Search index mismatch; rebuild required')
      }
      return { count: rows.length }
    })
  }

  preview(id) {
    const note = this.read(id)
    return projectText(note.document, note.contentState)
  }

  listPage(options = {}) {
    const { limit, offset } = pageOptions(options)
    return this.#db.prepare('SELECT id,metadata,version,content_state FROM notes WHERE deleted IS NULL AND recovery=0 ORDER BY id LIMIT ? OFFSET ?')
      .all(limit, offset).map(row => ({ id: row.id, metadata: JSON.parse(row.metadata), version: row.version, contentState: row.content_state }))
  }

  search(query, options = {}) {
    const { limit, offset } = pageOptions(options)
    if (typeof query !== 'string' || !query.trim() || [...query].length > 200 || query.includes('\0')) throw new Error('Invalid search query')
    const value = query.trim().normalize('NFC').toLowerCase()
    if (this.#db.prepare('SELECT n.id FROM notes n LEFT JOIN search_fts s ON s.note_id=n.id WHERE s.note_id IS NULL OR s.version != n.version LIMIT 1').get()) throw new Error('Search index is stale; rebuild required')
    const short = [...value].length < 3
    const clause = short ? 'instr(s.text, ?) > 0' : 'search_fts MATCH ?'
    const rows = this.#db.prepare(`SELECT n.id,n.metadata,n.version,s.coverage,s.reasons FROM search_fts s JOIN notes n ON n.id=s.note_id WHERE ${clause} AND n.deleted IS NULL AND n.recovery=0 ORDER BY n.id LIMIT ? OFFSET ?`)
      .all(short ? value : '"' + value.replaceAll('"', '""') + '"', limit, offset)
    return rows.map(row => ({ id: row.id, metadata: JSON.parse(row.metadata), version: row.version,
      coverage: row.coverage, reasons: JSON.parse(row.reasons) }))
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
      this.#db.prepare('UPDATE notes SET metadata=?,document=?,content_hash=?,version=version+1,deleted=?,content_state=? WHERE id=?')
        .run(encoded, bytes, hash, next.deleted === null ? null : jsonValue(next.deleted), next.contentState, id)
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
  convertLegacy(id, expected) {
    return this.#change(id, expected, 'legacy-convert', next => {
      if (next.contentState !== 'legacy-only' || next.deleted !== null || next.recovery) throw new Error('Expected a live legacy-only note')
      next.document = convertPlainLegacy(next)
      next.contentState = 'native'
    })
  }
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

  recentChanges({ limit = 50 } = {}) {
    pageOptions({ limit })
    return this.#db.prepare('SELECT * FROM changes ORDER BY sequence DESC LIMIT ?').all(limit).map(row => ({ ...row }))
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

  #syncSnapshot(id) { return snapshot(this.read(id), this.listAttachments(id).map(a => this.readAttachment(id,a.id))) }

  #sync() {
    if (this.#db.prepare('PRAGMA user_version').get().user_version !== 2) throw new Error('Synchronisation is not enabled')
    return new SyncStore(this.#db, id => this.#syncSnapshot(id), value => this.#applySync(value))
  }

  #applySync(value) {
    const exists = this.#db.prepare('SELECT id FROM notes WHERE id=?').get(value.id)
    if (exists && equal(this.#syncSnapshot(value.id),value)) return
    // Cross-note hierarchy violations stop the page transaction. They never
    // bypass the same hierarchy checks used by local moves.
    if (value.deleted === null && !value.recovery) this.#parent(value.id,value.metadata.parentId)
    this.#applyingSync = true
    try {
      const bytes=decode(value.document), hash=digest(bytes)
      if (!exists) this.#insert({ ...value, document:bytes }, 'sync')
      else this.#db.prepare('UPDATE notes SET metadata=?,document=?,content_hash=?,version=version+1,deleted=?,recovery=?,legacy=?,content_state=? WHERE id=?')
        .run(metadata(value.metadata),bytes,hash,value.deleted===null?null:jsonValue(value.deleted),Number(value.recovery),jsonValue(value.legacyRecords),value.contentState,value.id)
      for (const a of value.attachments) this.#db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?) ON CONFLICT(note_id,id) DO UPDATE SET metadata=excluded.metadata,bytes=excluded.bytes,sha256=excluded.sha256')
        .run(value.id,a.id,jsonValue(a.metadata),decode(a.bytes),a.sha256)
      if (exists) this.#journal(value.id,this.read(value.id).version,'sync',hash)
    } finally { this.#applyingSync = false }
  }

  enableSync() {
    return this.#transaction(() => {
      if (this.#db.prepare('PRAGMA user_version').get().user_version === 1) {
        migrateSync(this.#db)
        for (const {id} of this.#db.prepare('SELECT id FROM notes ORDER BY id').all()) {
          const {sequence}=this.#db.prepare('SELECT max(sequence) AS sequence FROM changes WHERE note_id=?').get(id)
          this.#sync().record(id,sequence)
        }
      }
      return this.#sync().identity()
    })
  }

  syncIdentity() { return this.#sync().identity() }
  forkSyncClient() { return this.#transaction(() => this.#sync().forkClient()) }
  connectSync(target,epoch) { return this.#transaction(() => this.#sync().connect(target,epoch)) }
  pendingSync(target,{now=Date.now(),limit=100}={}) { return this.#sync().pending(target,now,limit) }
  acknowledgeSync(target,id,sha256) { return this.#transaction(() => this.#sync().acknowledge(target,id,sha256)) }
  retrySync(target,id,now=Date.now()) { return this.#transaction(() => this.#sync().retry(target,id,now)) }
  receiveSync(target,cursor,page) { return this.#transaction(() => this.#sync().receive(target,cursor,page)) }
  syncStatus(target) { return this.#sync().status(target) }
  syncConflicts(noteId) { return this.#sync().conflicts(noteId) }
  retainedSyncOperation(id) { return this.#sync().retained(id) }

  verify() {
    this.#db.exec('BEGIN')
    try { const result = verifyDatabase(this.#db); this.#db.exec('COMMIT'); return result }
    catch (error) { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); throw error }
  }

  async exportBackup(destination, options) {
    if (this.#closed) throw new Error('Vault is closed')
    this.#backups++
    try { return await exportSnapshot(this.#db, destination, options) }
    finally { this.#backups-- }
  }

  close() {
    if (this.#backups) throw new Error('Wait for the active backup before closing')
    if (!this.#closed) { this.#db.close(); this.#closed = true }
  }
}
