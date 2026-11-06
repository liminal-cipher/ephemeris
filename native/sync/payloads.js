import { createHash } from 'node:crypto'
import { digest, MAX_BYTES } from '../validation.js'
import { migrateResources, checkResources, resourceLimits } from './resources.js'

export const CHUNK_BYTES = 256 * 1024
export const PAYLOAD_TABLES = ['sync_chunks', 'sync_content', 'sync_resource_limits']
export function contentHash(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid content hash')
  return value
}
export function validateContent(content) {
  if (!content || Object.keys(content).sort().join(',') !== 'chunks,size' ||
      !Number.isSafeInteger(content.size) || content.size < 0 || content.size > MAX_BYTES ||
      !Array.isArray(content.chunks) || content.chunks.length !== Math.ceil(content.size / CHUNK_BYTES)) throw new Error('Invalid content manifest')
  content.chunks.forEach(contentHash)
  return content
}
export function chunkIds(operation) {
  return [...new Set(operation.snapshot.attachments.flatMap(a => a.content?.chunks ?? []))]
}
export function readChunk(db, sha256) {
  contentHash(sha256)
  const row = db.prepare('SELECT bytes FROM sync_chunks WHERE sha256=?').get(sha256)
  if (!row) throw new Error('Missing content chunk')
  if (row.bytes.length > CHUNK_BYTES || digest(row.bytes) !== sha256) throw new Error('Content chunk integrity failure')
  return row.bytes
}
export function putChunk(db, sha256, bytes) {
  contentHash(sha256)
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > CHUNK_BYTES || digest(bytes) !== sha256) throw new Error('Content chunk integrity failure')
  const old = db.prepare('SELECT length(bytes) AS size FROM sync_chunks WHERE sha256=?').get(sha256)
  if (old) { readChunk(db, sha256); return false }
  checkResources(db,{chunkBytes:bytes.length,chunks:1})
  db.prepare('INSERT INTO sync_chunks VALUES(?,?)').run(sha256, bytes)
  return true
}
export function verifyContent(content, sha256, getChunk) {
  validateContent(content); contentHash(sha256)
  const hash = createHash('sha256')
  for (let i = 0; i < content.chunks.length; i++) {
    const bytes = getChunk(content.chunks[i])
    if (bytes.length !== Math.min(CHUNK_BYTES, content.size - i * CHUNK_BYTES) || digest(bytes) !== content.chunks[i]) throw new Error('Content chunk integrity failure')
    hash.update(bytes)
  }
  if (hash.digest('hex') !== sha256) throw new Error('Attachment integrity failure')
}
export function retainContent(db, content, sha256) {
  validateContent(content);contentHash(sha256)
  const text = JSON.stringify({size:content.size,chunks:content.chunks}), old = db.prepare('SELECT manifest FROM sync_content WHERE sha256=?').get(sha256)
  if (old && old.manifest !== text) throw new Error('Content identity reused')
  if (old) return
  verifyContent(content, sha256, hash => readChunk(db, hash))
  db.prepare('INSERT OR IGNORE INTO sync_content VALUES(?,?)').run(sha256, text)
}
export function contentFromBytes(db, bytes, sha256) {
  contentHash(sha256)
  if(!(bytes instanceof Uint8Array)||bytes.length>MAX_BYTES)throw new Error('Invalid content bytes')
  const content = { size:bytes.length, chunks:[] }
  for(let offset=0;offset<bytes.length;offset+=CHUNK_BYTES) {
    const chunk=bytes.subarray(offset,offset+CHUNK_BYTES),hash=digest(chunk)
    putChunk(db,hash,chunk);content.chunks.push(hash)
  }
  retainContent(db,content,sha256)
  return content
}
export function attachmentContent(db, noteId, id, sha256) {
  const old = db.prepare('SELECT manifest FROM sync_content WHERE sha256=?').get(sha256)
  if (old) return validateContent(JSON.parse(old.manifest))
  const { size } = db.prepare('SELECT length(bytes) AS size FROM attachments WHERE note_id=? AND id=?').get(noteId, id)
  const content = { size, chunks: [] }
  // SQLite substr reads one bounded BLOB slice. A rename never reloads the BLOB.
  for (let offset = 0; offset < size; offset += CHUNK_BYTES) {
    const { bytes } = db.prepare('SELECT substr(bytes,?,?) AS bytes FROM attachments WHERE note_id=? AND id=?').get(offset + 1, CHUNK_BYTES, noteId, id)
    const hash = digest(bytes)
    putChunk(db, hash, bytes); content.chunks.push(hash)
  }
  retainContent(db, content, sha256)
  return content
}
export function materializeContent(db, content, sha256) {
  retainContent(db, content, sha256)
  const bytes = Buffer.allocUnsafe(content.size)
  content.chunks.forEach((hash, i) => bytes.set(readChunk(db, hash), i * CHUNK_BYTES))
  return bytes
}
export function migratePayloads(db) {
  db.exec(`
    CREATE TABLE sync_chunks (sha256 TEXT PRIMARY KEY, bytes BLOB NOT NULL) STRICT;
    CREATE TABLE sync_content (sha256 TEXT PRIMARY KEY, manifest TEXT NOT NULL) STRICT;
    PRAGMA user_version=4;
  `)
  migrateResources(db)
  for (const row of db.prepare('SELECT note_id,id,sha256 FROM attachments').iterate()) attachmentContent(db, row.note_id, row.id, row.sha256)
  checkResources(db)
}
export function verifyPayloads(db, add) {
  resourceLimits(db);checkResources(db)
  for(const row of db.prepare('SELECT * FROM sync_resource_limits ORDER BY singleton').iterate())add(row)
  for (const row of db.prepare('SELECT * FROM sync_chunks ORDER BY sha256').iterate()) {
    readChunk(db, row.sha256); add(row)
  }
  for (const row of db.prepare('SELECT * FROM sync_content ORDER BY sha256').iterate()) {
    verifyContent(JSON.parse(row.manifest), row.sha256, hash => readChunk(db, hash)); add(row)
  }
}
