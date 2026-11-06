import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NativeVault } from '../vault.js'
import { validateProperties, validateView } from '../knowledge.js'
import { writeNote, WRITE_PERMISSIONS } from '../companion-operations.js'

test('views filter and sort canonical metadata with bounded pages, preserving note bytes', t => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'ephemeris-knowledge-')), vault = NativeVault.create(path.join(root, 'vault'))
  t.after(() => { vault.close(); rmSync(root, { recursive: true, force: true }) })
  const a = vault.create({ id: 'a', metadata: { title: 'Alpha', tags: ['한국어', 'work'], project: 'Ephemeris', status: 'todo', dueDate: '2026-11-09', favorite: true } })
  vault.create({ id: 'b', metadata: { title: 'Beta', tags: ['work'], status: 'doing', dueDate: '2026-11-08' } })
  vault.create({ id: 'c', metadata: { title: 'Gamma', tags: ['한국어'], project: 'Ephemeris', status: 'done' } })
  vault.create({ id: 'view', metadata: { title: 'My work', kind: 'workspace-view', view: { tag: 'work', layout: 'board' } } })
  assert.deepEqual(vault.queryNotes({ tag: '한국어', project: 'Ephemeris', status: 'todo' }).rows.map(row => row.id), ['a'])
  assert.deepEqual(vault.queryNotes({ favorite: true }).rows.map(row => row.id), ['a'])
  assert.deepEqual(vault.queryNotes({ sort: 'due' }).rows.map(row => row.id), ['b', 'a', 'c'])
  assert.equal(vault.queryNotes({ limit: 1, offset: 1 }).rows[0].id, 'b')
  assert.equal(vault.queryNotes({ limit: 1 }).total, 3)
  assert.equal(vault.queryNotes({ definitions: true }).rows[0].id, 'view')
  assert.equal(vault.queryNotes({ tag: "' OR 1=1 --" }).total, 0)
  for (const options of [{ limit: 101 }, { offset: -1 }, { sort: 'DROP TABLE notes' }, { sql: 'SELECT 1' }]) assert.throws(() => vault.queryNotes(options), /Invalid/)
  assert.deepEqual(vault.read('a'), a)
  const first = vault.queryNotes({ favorite: true }).rows[0]
  writeNote(vault, 'update', { id: first.id, expected: { version: first.version, contentHash: first.contentHash }, metadata: { status: 'doing' } }, WRITE_PERMISSIONS)
  assert.equal(vault.read('a').metadata.status, 'doing')
  assert.equal(vault.queryNotes({ sort: 'recent' }).rows[0].id, 'a')
  assert.deepEqual(vault.read('a').document, a.document)
  assert.throws(() => writeNote(vault, 'update', { id: first.id, expected: { version: first.version, contentHash: first.contentHash }, metadata: { status: 'done' } }, WRITE_PERMISSIONS), /Stale/)
})

test('typed properties reject invalid edits while retaining unchanged legacy properties', () => {
  for (const fields of [{ dueDate: '2026-02-30' }, { tags: ['a', 'a'] }, { tags: [1] }, { favorite: 'true' }, { project: {} }]) assert.throws(() => validateProperties(fields), /Invalid/)
  validateProperties({ dueDate: '2028-02-29', tags: ['한국어'], favorite: false, project: 'Local' })
  validateProperties({ title: 'Updated', tags: { unknown: 'preserved' } }, { tags: { unknown: 'preserved' } })
  assert.throws(() => validateView({ file: '/private' }), /Invalid/)
  assert.throws(() => validateView({ layout: 'execute' }), /Invalid/)
})
