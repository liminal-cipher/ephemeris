import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as Y from 'yjs'
import { NativeVault } from '../vault.js'
import { browserBackup } from './fixtures.js'

function setup(t) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'ephemeris-search-'))
  const directory = path.join(root, 'vault'), vault = NativeVault.create(directory)
  t.after(() => { vault.close(); rmSync(root, { recursive: true, force: true }) })
  return { vault, directory }
}
const bytes = text => {
  const doc = new Y.Doc(), paragraph = new Y.XmlElement('paragraph'), body = new Y.XmlText()
  body.insert(0, text); paragraph.insert(0, [body]); doc.getXmlFragment('default').insert(0, [paragraph])
  const result = Y.encodeStateAsUpdate(doc); doc.destroy(); return result
}

test('FTS5 trigram searches English, Korean, mixed text, metadata and short substrings', t => {
  const { vault } = setup(t)
  const note = vault.create({ id: 'text', metadata: { title: 'Research 계획', tags: ['중요한자료'] }, document: bytes('Hello 세계: 프로젝트 회의록과 SQLite storage') })
  for (const query of ['research', '계획', '중요한', 'hello', '프로젝트', '회의', '계', 'SQLite storage', 'hello 세계', '회의'.normalize('NFD')]) {
    assert.deepEqual(vault.search(query).map(result => result.id), [note.id], query)
  }
  assert.equal(vault.search('계획')[0].coverage, 'complete')
  assert.deepEqual(vault.search('NOT a query operator'), [])
  assert.deepEqual(vault.search('" OR *'), [])
  assert.equal(vault.verifySearch().count, 1)
})

test('edits, deletion, restoration and index rebuild remain atomic and preserve canonical bytes', t => {
  const { vault, directory } = setup(t)
  let note = vault.create({ id: 'a', document: bytes('original text') })
  note = vault.update(note.id, { document: bytes('revised text') }, note)
  assert.deepEqual(vault.search('original'), [])
  assert.equal(vault.search('revised').length, 1)
  note = vault.delete(note.id, note)
  assert.deepEqual(vault.search('revised'), [])
  note = vault.restore(note.id, note)
  assert.equal(vault.search('revised').length, 1)
  const before = vault.verify()
  const db = new DatabaseSync(path.join(directory, 'vault.sqlite'))
  try { db.exec('DELETE FROM search_fts') } finally { db.close() }
  assert.throws(() => vault.search('revised'), /stale/)
  assert.throws(() => vault.verifySearch(), /mismatch/)
  assert.throws(() => vault.verify(), /Search projection integrity/)
  assert.equal(vault.rebuildSearch(), 1)
  assert.equal(vault.search('revised').length, 1)
  assert.deepEqual(vault.verify(), before)
  assert.deepEqual(vault.read(note.id), note)
})

test('partial and unsupported text has explicit coverage and raw recovery access', async t => {
  const { vault } = setup(t)
  const { text } = await browserBackup()
  await vault.importBackup(text)
  assert.equal(vault.search('Parent')[0].coverage, 'partial')
  assert.ok(vault.preview('parent').reasons.includes('node:future-widget'))
  assert.equal(vault.search('Legacy')[0].coverage, 'unsupported')
  assert.equal(vault.read('legacy').legacyRecords[0].content, '{"type":"future-unsupported"}')
  assert.deepEqual(vault.search('orphan'), [])
  assert.deepEqual(vault.search('Child'), [])
  assert.throws(() => vault.update('legacy', { document: bytes('replace') }, vault.read('legacy')), /lossless/)
})

test('stable ordering, bounded pagination and read-only handles', t => {
  const { vault, directory } = setup(t)
  for (const id of ['z', 'a', 'b']) vault.create({ id, document: bytes('common') })
  assert.deepEqual(vault.search('common', { limit: 1, offset: 1 }).map(row => row.id), ['b'])
  for (const options of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 10001 }]) assert.throws(() => vault.search('common', options), /pagination/)
  for (const query of ['', '\0', 'a'.repeat(201), null]) assert.throws(() => vault.search(query), /query/)
  const readOnly = NativeVault.open(directory, { readOnly: true })
  try {
    assert.deepEqual(readOnly.search('common'), vault.search('common'))
    assert.equal(readOnly.listPage({ limit: 1 })[0].id, 'a')
    assert.throws(() => readOnly.rename('a', 'forbidden', readOnly.read('a')), /read-only/)
    assert.throws(() => readOnly.rebuildSearch(), /read-only/)
  } finally { readOnly.close() }
})

test('a search write failure rolls back the note and journal', t => {
  const { vault, directory } = setup(t)
  const note = vault.create({ id: 'one', document: bytes('preserved') })
  const db = new DatabaseSync(path.join(directory, 'vault.sqlite'))
  try { db.exec('DROP TABLE search_fts') } finally { db.close() }
  assert.throws(() => vault.rename(note.id, 'Failed', note), /search_fts/)
  assert.deepEqual(vault.read(note.id), note)
  assert.equal(vault.changes().length, 1)
  vault.rebuildSearch()
  assert.equal(vault.search('preserved').length, 1)
})
