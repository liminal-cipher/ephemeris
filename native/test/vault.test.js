import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fork, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import * as Y from 'yjs'
import { NativeVault, ConflictError } from '../vault.js'
import { importBackupToVault } from '../importBackup.js'
import { digest } from '../validation.js'
import { browserBackup, documentBytes, rehash } from './fixtures.js'

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'ephemeris-native-'))
  const directory = path.join(root, 'vault')
  const vault = NativeVault.create(directory)
  const handles = [vault]
  t.after(() => { handles.forEach(handle => handle.close()); rmSync(root, { recursive: true, force: true }) })
  return { root, directory, vault, track: handle => { handles.push(handle); return handle },
    open: () => { const next = NativeVault.open(directory); handles.push(next); return next } }
}

function worker(args) {
  return fork(new URL('./process-worker.js', import.meta.url), args, { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
}

test('native content, metadata, attachments and changes survive close/reopen and a new process', async t => {
  const { vault, directory, open } = fixture(t)
  const document = documentBytes()
  let note = vault.create({ id: 'stable', metadata: { title: 'First', custom: { tags: ['one'] } }, document })
  note = vault.putAttachment(note.id, { id: 'image', bytes: Buffer.from('attachment'), metadata: { name: '../display-only.png' } }, note)
  note = vault.rename(note.id, 'Renamed', note)
  assert.equal(note.version, 3)
  vault.close(); vault.close()
  assert.throws(() => vault.read(note.id), /closed/)
  const reopened = open()
  assert.deepEqual(reopened.read(note.id), note)
  assert.deepEqual(reopened.readAttachment(note.id, 'image').bytes, Uint8Array.from(Buffer.from('attachment')))
  assert.equal(reopened.listAttachments(note.id)[0].size, 10)
  assert.equal(reopened.changes().length, 3)
  assert.equal(reopened.changes({ after: 2 })[0].kind, 'update')
  const child = worker(['read', directory, note.id])
  const exit = once(child, 'exit')
  const [read] = await once(child, 'message')
  assert.equal(read.metadata.title, 'Renamed')
  assert.equal(read.contentHash, digest(document))
  assert.equal((await exit)[0], 0)
})

test('optimistic versions cover metadata, content, deletion and attachment writes', t => {
  const { vault, open } = fixture(t)
  const other = open()
  const first = vault.create({ id: 'one' })
  const second = other.update(first.id, { document: documentBytes('changed') }, first)
  for (const write of [() => vault.rename(first.id, 'stale', first), () => vault.delete(first.id, first),
    () => vault.putAttachment(first.id, { bytes: new Uint8Array([1]) }, first),
    () => vault.rename(first.id, 'missing', {}),
    () => vault.rename(first.id, 'hash', { version: second.version, contentHash: first.contentHash })]) assert.throws(write, ConflictError)
  assert.deepEqual(vault.read(first.id), second)
})

for (const rival of ['rename', 'move', 'delete']) test(`independent processes race rename versus ${rival}`, async t => {
  const { vault, directory } = fixture(t)
  const note = vault.create({ id: 'one' })
  vault.create({ id: 'parent' })
  const a = worker(['rename', directory, note.id, '1', 'winner'])
  const b = worker([rival, directory, note.id, '1', rival === 'move' ? 'parent' : 'other'])
  const exits = [once(a, 'exit'), once(b, 'exit')]
  t.after(() => { a.kill(); b.kill() })
  await Promise.all([once(a, 'message'), once(b, 'message')])
  const messages = [once(a, 'message'), once(b, 'message')]
  a.send('go'); b.send('go')
  const results = (await Promise.all(messages)).map(([message]) => message).sort()
  assert.deepEqual(results, ['ConflictError', 'committed'])
  await Promise.all(exits)
  assert.equal(vault.read(note.id).version, 2)
  assert.equal(vault.changes().length, 3)
})

test('hierarchy cycles are rejected and deleted parents do not erase children', t => {
  const { vault, open } = fixture(t)
  const a = vault.create({ id: 'a' }), b = vault.create({ id: 'b' })
  const other = open()
  const moved = vault.move(a.id, b.id, a)
  assert.throws(() => other.move(b.id, a.id, b), /hierarchy/)
  const deleted = vault.delete(b.id, b)
  assert.equal(vault.list().length, 1)
  assert.equal(vault.read(a.id).metadata.parentId, b.id)
  assert.throws(() => vault.move(a.id, b.id, moved), /deleted/)
  assert.equal(vault.rename(a.id, 'Still editable', moved).metadata.title, 'Still editable')
  const restored = vault.restore(b.id, deleted)
  assert.equal(restored.id, b.id)
  assert.equal(restored.metadata.parentId, null)
  assert.equal(vault.list().length, 2)
})

test('journal failure rolls back document, metadata, version and attachment insertion', t => {
  const { vault, directory, track } = fixture(t)
  const note = vault.create({ id: 'one' })
  const db = track(new DatabaseSync(path.join(directory, 'vault.sqlite')))
  db.exec("CREATE TRIGGER fail_journal BEFORE INSERT ON changes BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END")
  assert.throws(() => vault.update(note.id, { metadata: { title: 'Failed' }, document: documentBytes() }, note), /simulated/)
  assert.throws(() => vault.putAttachment(note.id, { id: 'failed', bytes: new Uint8Array([1]) }, note), /simulated/)
  assert.deepEqual(vault.read(note.id), note)
  assert.deepEqual(vault.listAttachments(note.id), [])
  assert.equal(vault.changes().length, 1)
  db.exec('DROP TRIGGER fail_journal')
  assert.equal(vault.rename(note.id, 'Works', note).version, 2)
})

test('invalid IDs, JSON data, updates and filesystem paths are rejected', t => {
  const { vault, root, directory } = fixture(t)
  for (const id of ['', '..', '../outside', 'a/b', 'a\\b', '\u0000', '__proto__', 7, 'a'.repeat(201)]) assert.throws(() => vault.create({ id }))
  for (const fields of [{ id: 'replace' }, { title: 7 }, { x: undefined }, { x: Infinity }, JSON.parse('{"__proto__":{}}')]) assert.throws(() => vault.create({ metadata: fields }))
  assert.throws(() => vault.create({ document: new Uint8Array([255]) }))
  const base = new Y.Doc(), edits = []
  base.on('update', update => edits.push(update))
  base.getText('text').insert(0, 'first'); base.getText('text').insert(5, 'second')
  assert.throws(() => vault.create({ document: edits[1] }), /Incomplete/)
  base.destroy()
  for (const invalid of ['relative', ':memory:', directory + '/../../outside', path.parse(root).root]) assert.throws(() => NativeVault.create(invalid))
  assert.throws(() => NativeVault.create(directory), /EEXIST/)
  assert.throws(() => NativeVault.open(path.join(root, 'missing')))
  assert.equal(vault.list().length, 0)
})

test('symlink directories are rejected', t => {
  const { root, directory } = fixture(t)
  const link = path.join(root, 'link')
  symlinkSync(directory, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => NativeVault.open(link), /real local directories/)
})

test('corrupt SQLite, foreign schemas and tampered BLOBs fail closed', t => {
  const { vault, root, directory, open } = fixture(t)
  const note = vault.create({ id: 'one' })
  vault.putAttachment(note.id, { id: 'blob', bytes: new Uint8Array([1]) }, note)
  const db = new DatabaseSync(path.join(directory, 'vault.sqlite'))
  db.exec("UPDATE attachments SET bytes=X'02'; UPDATE notes SET document=X'02'")
  assert.throws(() => vault.read('one'), /integrity/)
  db.prepare('UPDATE notes SET document=?').run(note.document)
  assert.throws(() => vault.readAttachment('one', 'blob'), /integrity/)
  db.exec('PRAGMA user_version=999'); db.close(); vault.close()
  assert.throws(open, /schema/)
  const corrupt = path.join(root, 'corrupt')
  const v = NativeVault.create(corrupt); v.close()
  writeFileSync(path.join(corrupt, 'vault.sqlite'), 'not SQLite')
  assert.throws(() => NativeVault.open(corrupt), /database/)
})

test('process termination rolls back an uncommitted transaction', async t => {
  const { vault, directory, open } = fixture(t)
  const note = vault.create({ id: 'one' })
  vault.close()
  const child = worker(['uncommitted', directory, note.id])
  t.after(() => child.kill())
  const exit = once(child, 'exit')
  await once(child, 'message')
  child.kill('SIGKILL'); await exit
  assert.deepEqual(open().read(note.id), note)
})

test('real BrowserVault v2 export imports losslessly with links, tombstones, legacy and archive', async t => {
  const { vault, open } = fixture(t)
  const { backup, text } = await browserBackup()
  const result = await vault.importBackup(text)
  assert.equal(result.count, 4)
  assert.equal(vault.list().length, 2)
  assert.equal(vault.list({ includeDeleted: true, includeRecovery: true }).length, 4)
  for (const entry of backup.payload.documents) {
    const note = vault.read(entry.id)
    assert.deepEqual(Buffer.from(note.document), Buffer.from(entry.update, 'base64'))
    assert.deepEqual(note.legacyRecords, backup.payload.legacy.filter(row => String(row.id) === entry.id))
  }
  assert.equal(vault.read('child').metadata.parentId, 'parent')
  assert.equal(vault.read('child').deleted.metadata.title, 'Child')
  assert.equal(vault.read('orphan').recovery, true)
  assert.equal(vault.read('legacy').contentState, 'legacy-only')
  assert.throws(() => vault.update('legacy', { document: documentBytes() }, vault.read('legacy')), /lossless conversion/)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, vault.read('parent').document)
  assert.equal(doc.getXmlFragment('default').get(0).nodeName, 'future-widget')
  assert.equal(doc.getXmlFragment('default').get(0).getAttribute('reference'), 'child')
  assert.equal(doc.getMap('attachments').get('image'), 'data:image/png;base64,aGVsbG8=')
  doc.destroy()
  assert.equal(vault.readImport(result.sha256), text)
  vault.close()
  assert.equal(open().readImport(result.sha256), text)
  assert.equal(JSON.stringify(backup), text)
})

test('repeat import is a no-op even after edits; a different backup requires another empty Vault', async t => {
  const { vault, root } = fixture(t)
  const { backup, text } = await browserBackup()
  await vault.importBackup(text)
  const note = vault.rename('parent', 'Local edit', vault.read('parent'))
  const before = vault.changes()
  assert.equal((await vault.importBackup(text)).imported, false)
  assert.deepEqual(vault.read('parent'), note)
  assert.deepEqual(vault.changes(), before)
  backup.payload.createdAt = 'different'
  await assert.rejects(vault.importBackup(rehash(backup)), /isolated/)
  const result = await importBackupToVault(path.join(root, 'second'), text)
  try { assert.equal(result.vault.read('parent').metadata.title, 'Parent') } finally { result.vault.close() }
})

test('invalid backups are rejected before creating a destination or publishing notes', async t => {
  const { vault, root } = fixture(t)
  const { text } = await browserBackup()
  const variants = [() => '[]', () => '{', b => { b.sha256 = 'damaged'; return JSON.stringify(b) },
    b => { b.version = 999; return rehash(b) },
    b => { b.payload.documents[0].id = '../escape'; return rehash(b) },
    b => { b.payload.documents[0].update = '!!!!'; return rehash(b) },
    b => { b.payload.documents.pop(); return rehash(b) },
    b => { b.payload.documents.push(b.payload.documents[0]); return rehash(b) }]
  for (const mutate of variants) {
    const input = mutate(JSON.parse(text))
    await assert.rejects(vault.importBackup(input))
    const target = path.join(root, 'invalid')
    await assert.rejects(importBackupToVault(target, input))
    assert.equal(existsSync(target), false)
    assert.deepEqual(vault.list({ includeDeleted: true, includeRecovery: true }), [])
  }
})

test('failure mid-import rolls back every note, journal row and recovery archive', async t => {
  const { vault, directory, track } = fixture(t)
  const { text, backup } = await browserBackup()
  const db = track(new DatabaseSync(path.join(directory, 'vault.sqlite')))
  db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON notes WHEN (SELECT count(*) FROM notes)>0 BEGIN SELECT RAISE(ABORT, 'interrupted import'); END")
  await assert.rejects(vault.importBackup(text), /interrupted/)
  assert.deepEqual(vault.list({ includeDeleted: true, includeRecovery: true }), [])
  assert.deepEqual(vault.changes(), [])
  assert.throws(() => vault.readImport(backup.sha256), /not found/)
  db.exec('DROP TRIGGER fail_import')
  assert.equal((await vault.importBackup(text)).imported, true)
})

test('process exit during migration leaves an empty Vault that can be imported again', async t => {
  const { vault, directory, root, open } = fixture(t)
  const { text } = await browserBackup()
  const input = path.join(root, 'synthetic-backup.json')
  writeFileSync(input, text)
  vault.close()
  const child = worker(['interrupted-import', directory, input])
  const [code] = await once(child, 'exit')
  assert.equal(code, 17)
  const recovered = open()
  assert.deepEqual(recovered.list({ includeDeleted: true, includeRecovery: true }), [])
  assert.equal((await recovered.importBackup(text)).imported, true)
})

test('attachments remain immutable and survive note deletion and restoration', t => {
  const { vault } = fixture(t)
  let note = vault.create({ id: 'one' })
  const bytes = new Uint8Array([0, 1, 255])
  note = vault.putAttachment(note.id, { id: 'blob', bytes }, note)
  assert.throws(() => vault.putAttachment(note.id, { id: 'blob', bytes: new Uint8Array([2]) }, note), /UNIQUE/)
  assert.equal(vault.read(note.id).version, 2)
  note = vault.delete(note.id, note)
  assert.deepEqual(vault.readAttachment(note.id, 'blob').bytes, bytes)
  note = vault.restore(note.id, note)
  assert.deepEqual(vault.readAttachment(note.id, 'blob').bytes, bytes)
  assert.equal(note.version, 4)
})

test('concurrent imports across connections publish once', async t => {
  const { vault, open } = fixture(t)
  const other = open()
  const { text } = await browserBackup()
  const results = await Promise.all([vault.importBackup(text), other.importBackup(text)])
  assert.deepEqual(results.map(result => result.imported).sort(), [false, true])
  assert.equal(vault.changes().length, 4)
})

test('CLI imports and inspects a synthetic backup without overwriting destinations', async t => {
  const { root } = fixture(t)
  const { text } = await browserBackup()
  const input = path.join(root, 'backup.json'), destination = path.join(root, 'cli-vault')
  writeFileSync(input, text)
  const cli = (...args) => spawnSync(process.execPath, ['native/cli.js', ...args], { encoding: 'utf8' })
  const imported = cli('import', input, destination)
  assert.equal(imported.status, 0, imported.stderr)
  assert.equal(JSON.parse(imported.stdout).count, 4)
  const inspected = cli('inspect', destination)
  assert.equal(inspected.status, 0, inspected.stderr)
  assert.deepEqual(JSON.parse(inspected.stdout), { notes: 4, deleted: 1, recoveryOnly: 1, legacyOnly: 1 })
  assert.equal(cli('import', input, destination).status, 1)
  assert.equal(cli('create', path.join(root, 'empty')).status, 0)
  assert.equal(cli('unknown').status, 1)
})
