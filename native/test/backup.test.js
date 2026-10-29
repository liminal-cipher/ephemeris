import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import * as Y from 'yjs'
import { NativeVault } from '../vault.js'
import { verifyBackup, restoreNativeBackup } from '../backup.js'
import { digest } from '../validation.js'
import { browserBackup } from './fixtures.js'

function setup(t) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'ephemeris-backup-'))
  const source = path.join(root, 'source'), backup = path.join(root, 'backup'), restored = path.join(root, 'restored')
  const vault = NativeVault.create(source)
  const handles = [vault]
  t.after(() => { handles.forEach(handle => handle.close()); rmSync(root, { recursive: true, force: true }) })
  return { root, source, backup, restored, vault, track: v => { handles.push(v); return v } }
}

test('export includes committed WAL, exact native data, attachments, tombstones and recovery archives', async t => {
  const { vault, backup, restored, track } = setup(t)
  const { text } = await browserBackup()
  await vault.importBackup(text)
  vault.putAttachment('parent', { id: 'image', bytes: new Uint8Array([0, 255, 1]) }, vault.read('parent'))
  const before = vault.list({ includeDeleted: true, includeRecovery: true })
  const manifest = await vault.exportBackup(backup)
  assert.deepEqual(await verifyBackup(backup), manifest)
  await restoreNativeBackup(backup, restored)
  const recovered = track(NativeVault.open(restored))
  assert.deepEqual(recovered.list({ includeDeleted: true, includeRecovery: true }), before)
  assert.deepEqual(recovered.changes(), vault.changes())
  assert.deepEqual(recovered.readAttachment('parent', 'image'), vault.readAttachment('parent', 'image'))
  assert.equal(recovered.readImport(JSON.parse(text).sha256), text)
  assert.deepEqual(recovered.verify(), vault.verify())
  recovered.close()
  assert.deepEqual(track(NativeVault.open(restored)).verify(), vault.verify())
  await assert.rejects(vault.exportBackup(backup), /EEXIST/)
  await assert.rejects(restoreNativeBackup(backup, restored), /EEXIST/)
})

test('snapshot remains internally consistent while another connection commits writes', async t => {
  const { vault, source, backup, restored, track } = setup(t)
  const bytes = generation => { const doc = new Y.Doc(); doc.getText('body').insert(0, String(generation)); const result = Y.encodeStateAsUpdate(doc); doc.destroy(); return result }
  let note = vault.create({ id: 'counter', metadata: { generation: 0 }, document: bytes(0) })
  note = vault.putAttachment(note.id, { id: 'large', bytes: new Uint8Array(5 * 1024 * 1024) }, note)
  const other = track(NativeVault.open(source))
  let writes = 0
  const interval = setInterval(() => {
    if (writes >= 5) return
    writes++
    note = other.update(note.id, { metadata: { generation: writes }, document: bytes(writes) }, note)
  }, 1)
  try { await vault.exportBackup(backup) } finally { clearInterval(interval) }
  assert.ok(writes > 0)
  await restoreNativeBackup(backup, restored)
  const saved = track(NativeVault.open(restored)).read('counter')
  const doc = new Y.Doc(); Y.applyUpdate(doc, saved.document)
  assert.equal(doc.getText('body').toString(), String(saved.metadata.generation)); doc.destroy()
})

test('corrupt checksum, incompatible format and corrupt attachment are rejected before restore publication', async t => {
  const { vault, backup, restored } = setup(t)
  const note = vault.create({ id: 'one' })
  vault.putAttachment(note.id, { id: 'blob', bytes: new Uint8Array([1]) }, note)
  await vault.exportBackup(backup)
  const file = path.join(backup, 'manifest.json'), original = readFileSync(file, 'utf8')
  writeFileSync(file, original.replace('"version":1', '"version":999'))
  await assert.rejects(restoreNativeBackup(backup, restored), /Incompatible/)
  assert.equal(existsSync(restored), false)
  writeFileSync(file, original)
  const snapshot = path.join(backup, 'snapshot.sqlite')
  const sidecar = snapshot + '-wal'
  writeFileSync(sidecar, 'untrusted sidecar')
  await assert.rejects(verifyBackup(backup), /sidecars/)
  rmSync(sidecar)
  const db = new DatabaseSync(snapshot)
  db.exec("UPDATE attachments SET bytes=X'02'"); db.close()
  await assert.rejects(verifyBackup(backup), /checksum/)
  const manifest = JSON.parse(original); manifest.sha256 = digest(readFileSync(snapshot))
  writeFileSync(file, JSON.stringify(manifest))
  await assert.rejects(restoreNativeBackup(backup, restored), /Attachment integrity/)
  assert.equal(existsSync(restored), false)
})

test('cancelled and process-interrupted operations never publish a partial backup or restored Vault', async t => {
  const { root, source, vault, backup, restored } = setup(t)
  vault.create({ id: 'one' })
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(vault.exportBackup(backup, { signal: aborted.signal }), /abort/i)
  assert.equal(existsSync(backup), false)
  const worker = path.join(import.meta.dirname, 'backup-worker.js')
  assert.equal(spawnSync(process.execPath, [worker, 'export', source, backup]).status, 18)
  await assert.rejects(verifyBackup(backup))
  const good = path.join(root, 'good')
  await vault.exportBackup(good)
  assert.equal(spawnSync(process.execPath, [worker, 'restore', good, restored]).status, 19)
  assert.throws(() => NativeVault.open(restored), /Incomplete restore/)
  assert.equal(vault.list().length, 1)
})

test('CLI export, verify and restore use the native snapshot format', async t => {
  const { source, vault, backup, restored, track } = setup(t)
  vault.create({ id: 'cli' })
  const cli = (...args) => spawnSync(process.execPath, ['native/cli.js', ...args], { encoding: 'utf8' })
  for (const args of [['export', source, backup], ['verify', backup], ['restore', backup, restored]]) {
    const result = cli(...args)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).format, 'ephemeris-native-snapshot')
  }
  assert.equal(track(NativeVault.open(restored)).read('cli').id, 'cli')
})
