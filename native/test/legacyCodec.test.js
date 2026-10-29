import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { NativeVault } from '../vault.js'
import { browserBackup, rehash } from './fixtures.js'

test('plain legacy conversion round trips text/structure and preserves the original bytes and native update', async () => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'ephemeris-codec-'))
  const vault = NativeVault.create(path.join(root, 'vault'))
  try {
    const { backup } = await browserBackup()
    const json = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '한글' }, { type: 'text', text: ' English' }] }, { type: 'paragraph', content: [] }] }
    const raw = JSON.stringify(json, null, 2)
    backup.payload.legacy.find(row => row.id === 'legacy').content = raw
    await vault.importBackup(rehash(backup))
    const original = vault.read('legacy')
    const converted = vault.convertLegacy('legacy', original)
    assert.equal(converted.contentState, 'native')
    assert.deepEqual(converted.legacyRecords, original.legacyRecords)
    const doc = new Y.Doc(); Y.applyUpdate(doc, converted.document)
    assert.equal(doc.getMap('ephemeris').get('legacyContent'), raw)
    assert.equal(doc.getMap('ephemeris').get('legacyNativeUpdate'), Buffer.from(original.document).toString('base64'))
    const recovered = { type: 'doc', content: doc.getXmlFragment('default').toArray().map(p => ({ type: p.nodeName, content: p.toArray().map(text => ({ type: 'text', text: text.toString() })) })) }
    assert.deepEqual(recovered, json)
    doc.destroy()
    assert.equal(vault.search('한글')[0].id, 'legacy')
    assert.throws(() => vault.convertLegacy('legacy', original), /Stale/)
  } finally { vault.close(); rmSync(root, { recursive: true, force: true }) }
})

test('unsupported legacy constructs fail without changing any canonical record', async () => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'ephemeris-codec-'))
  const vault = NativeVault.create(path.join(root, 'vault'))
  try {
    const { text } = await browserBackup()
    await vault.importBackup(text)
    const before = vault.verify(), note = vault.read('legacy')
    assert.throws(() => vault.convertLegacy(note.id, note), /Unsupported/)
    assert.deepEqual(vault.verify(), before)
  } finally { vault.close(); rmSync(root, { recursive: true, force: true }) }
})
