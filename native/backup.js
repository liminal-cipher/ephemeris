import { DatabaseSync, backup } from 'node:sqlite'
import { createReadStream } from 'node:fs'
import { readFileSync, writeFileSync, renameSync, unlinkSync, openSync, fsyncSync, closeSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { directoryPath, regularFile } from './paths.js'
import { verifyDatabase } from './integrity.js'

const FORMAT = 'ephemeris-native-snapshot'

async function fileHash(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

function syncFile(file) {
  const fd = openSync(file, 'r+')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function syncDirectory(directory) {
  // Windows does not support fsync on a directory handle through this API.
  if (process.platform === 'win32') return
  const fd = openSync(directory, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function openSnapshot(file) {
  regularFile(file)
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false, timeout: 5000 })
  db.exec('PRAGMA trusted_schema=OFF')
  return db
}

// Called only with a NativeVault-owned connection. No arbitrary SQL is exposed.
export async function exportSnapshot(db, destination, { signal } = {}) {
  signal?.throwIfAborted()
  const root = directoryPath(destination, true)
  syncDirectory(path.dirname(root))
  const partial = path.join(root, 'snapshot.partial')
  await backup(db, partial, { rate: 32 })
  signal?.throwIfAborted()
  const snapshot = new DatabaseSync(partial, { allowExtension: false })
  let verified
  try {
    // Seal a self-contained image; a portable backup never relies on sidecars.
    snapshot.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF')
    verified = verifyDatabase(snapshot)
  } finally { snapshot.close() }
  syncFile(partial)
  const sha256 = await fileHash(partial)
  const manifest = { format: FORMAT, version: 1, schemaVersion: 1, file: 'snapshot.sqlite', sha256, ...verified }
  renameSync(partial, path.join(root, 'snapshot.sqlite'))
  signal?.throwIfAborted()
  const pending = path.join(root, 'manifest.partial')
  writeFileSync(pending, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 })
  syncFile(pending)
  renameSync(pending, path.join(root, 'manifest.json')) // Publication marker, last.
  syncDirectory(root)
  return manifest
}

async function validatedSnapshot(directory) {
  const root = directoryPath(directory)
  const manifestFile = path.join(root, 'manifest.json')
  if (regularFile(manifestFile).size > 4096) throw new Error('Invalid backup manifest')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  if (manifest.format !== FORMAT || manifest.version !== 1 || manifest.schemaVersion !== 1 || manifest.file !== 'snapshot.sqlite' || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error('Incompatible native backup')
  const file = path.join(root, 'snapshot.sqlite')
  for (const suffix of ['-wal', '-shm', '-journal']) if (existsSync(file + suffix)) throw new Error('Portable backup must not have SQLite sidecars')
  regularFile(file)
  if (await fileHash(file) !== manifest.sha256) throw new Error('Backup checksum mismatch')
  const db = openSnapshot(file)
  try {
    const verified = verifyDatabase(db)
    if (verified.contentHash !== manifest.contentHash || verified.notes !== manifest.notes || verified.attachments !== manifest.attachments) throw new Error('Backup content mismatch')
    return { db, manifest }
  } catch (error) { db.close(); throw error }
}

export async function verifyBackup(directory) {
  const { db, manifest } = await validatedSnapshot(directory)
  db.close()
  return manifest
}

export async function restoreNativeBackup(source, destination, { signal } = {}) {
  signal?.throwIfAborted()
  const { db, manifest } = await validatedSnapshot(source)
  try {
    signal?.throwIfAborted()
    const root = directoryPath(destination, true)
    syncDirectory(path.dirname(root))
    const marker = path.join(root, '.restoring')
    writeFileSync(marker, 'Incomplete restore: retain this directory and retry into a new destination.\n', { flag: 'wx', mode: 0o600 })
    syncFile(marker)
    syncDirectory(root)
    const file = path.join(root, 'vault.sqlite')
    await backup(db, file, { rate: 32 })
    signal?.throwIfAborted()
    const restored = openSnapshot(file)
    try {
      if (verifyDatabase(restored).contentHash !== manifest.contentHash) throw new Error('Restored content mismatch')
    } finally { restored.close() }
    syncFile(file)
    signal?.throwIfAborted()
    unlinkSync(marker) // NativeVault.open refuses the directory until this point.
    syncDirectory(root)
    return manifest
  } finally { db.close() }
}
