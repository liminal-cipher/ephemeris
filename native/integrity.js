import { createHash } from 'node:crypto'
import { identifier, jsonValue, metadata, nativeUpdate, digest } from './validation.js'
import { searchProjection } from './textProjection.js'
import { verifySync } from './sync/store.js'

export const APPLICATION_ID = 1162889293

// Digest canonical data; also validate any disposable search projection present.
// The caller holds a read transaction or owns an unpublished immutable snapshot.
export function verifyDatabase(db) {
  if (db.prepare('PRAGMA application_id').get().application_id !== APPLICATION_ID ||
      ![1,2,3].includes(db.prepare('PRAGMA user_version').get().user_version)) throw new Error('Unsupported Vault schema')
  const hasSearch = Boolean(db.prepare("SELECT name FROM sqlite_schema WHERE name='search_fts'").get())
  // Open the virtual-table cursor in this transaction before SQLite's FTS5
  // integrity callback, refreshing caches after another connection's commits.
  if (hasSearch) db.prepare('SELECT count(*) FROM search_fts').get()
  const integrity = db.prepare('PRAGMA integrity_check').all()
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all()
  if (integrity.some(row => row.integrity_check !== 'ok') || foreignKeys.length) throw new Error('Corrupt Vault database')
  if (db.prepare("SELECT name FROM sqlite_schema WHERE type IN ('trigger','view')").all().length) throw new Error('Unsupported executable schema')
  const hash = createHash('sha256')
  const add = row => hash.update(JSON.stringify(row, (_, value) => value instanceof Uint8Array ? Buffer.from(value).toString('base64') : value)).update('\n')
  let notes = 0, attachments = 0
  for (const row of db.prepare('SELECT * FROM notes ORDER BY id').iterate()) {
    identifier(row.id); metadata(JSON.parse(row.metadata)); nativeUpdate(row.document)
    if (digest(row.document) !== row.content_hash) throw new Error('Native document integrity failure')
    if (!Number.isSafeInteger(row.version) || row.version < 1 || ![0, 1].includes(row.recovery) || !['native', 'legacy-only'].includes(row.content_state)) throw new Error('Invalid note state')
    if (row.deleted !== null) {
      const deleted = JSON.parse(row.deleted)
      if (!deleted || typeof deleted !== 'object' || Array.isArray(deleted)) throw new Error('Invalid tombstone')
      jsonValue(deleted)
    }
    const legacy = JSON.parse(row.legacy)
    if (!Array.isArray(legacy)) throw new Error('Invalid legacy records')
    jsonValue(legacy)
    if (hasSearch) {
      const rows = db.prepare('SELECT * FROM search_fts WHERE note_id=?').all(row.id)
      const expected = searchProjection({ metadata: JSON.parse(row.metadata), document: row.document, contentState: row.content_state })
      if (rows.length !== 1 || Number(rows[0].version) !== row.version || rows[0].text !== expected.indexedText || rows[0].coverage !== expected.coverage || rows[0].reasons !== JSON.stringify(expected.reasons)) throw new Error('Search projection integrity failure; rebuild required')
    }
    const last = db.prepare('SELECT version,content_hash FROM changes WHERE note_id=? ORDER BY sequence DESC LIMIT 1').get(row.id)
    if (!last || last.version !== row.version || last.content_hash !== row.content_hash) throw new Error('Inconsistent change journal')
    add(row); notes++
  }
  for (const row of db.prepare('SELECT * FROM attachments ORDER BY note_id,id').iterate()) {
    identifier(row.id); jsonValue(JSON.parse(row.metadata))
    if (digest(row.bytes) !== row.sha256) throw new Error('Attachment integrity failure')
    add(row); attachments++
  }
  for (const row of db.prepare('SELECT * FROM changes ORDER BY sequence').iterate()) {
    if (!Number.isSafeInteger(row.sequence) || row.sequence < 1 || !Number.isSafeInteger(row.version) || row.version < 1 || !/^[a-f0-9]{64}$/.test(row.content_hash)) throw new Error('Invalid change record')
    add(row)
  }
  for (const row of db.prepare('SELECT * FROM imports ORDER BY sha256').iterate()) {
    const original = JSON.parse(row.original)
    jsonValue(original)
    if (original.format !== 'ephemeris-workspace' || original.version !== 2 || original.sha256 !== row.sha256 || digest(JSON.stringify(original.payload)) !== row.sha256) throw new Error('Import archive integrity failure')
    add(row)
  }
  if (hasSearch && db.prepare('SELECT count(*) AS count FROM search_fts').get().count !== notes) throw new Error('Search projection integrity failure; rebuild required')
  if (db.prepare('PRAGMA user_version').get().user_version >= 2) verifySync(db,add)
  return { notes, attachments, contentHash: hash.digest('hex') }
}
