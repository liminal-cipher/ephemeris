import { it, expect } from 'vitest'
import Dexie from 'dexie'
import * as Y from 'yjs'
import { BrowserVault } from './browserVault'
import { prepareNote } from './noteIndex'
import { createBackup } from './backup'

it.each([7, '7'])('indexing preserves the original legacy row with ID %s', async id => {
  const database = new Dexie(`projection-${crypto.randomUUID()}`)
  database.version(1).stores({ pages: '++id', searchProjection: 'id' })
  const vault = new BrowserVault({ prefix: `projection-${crypto.randomUUID()}`, broadcast: false })
  const row = { id, title: 'Original', custom: { retained: true }, content: '{"type":"doc","content":[{"type":"paragraph"}]}' }
  try {
    await database.pages.put(row)
    await vault.ready
    vault.workspace.doc.getMap('pages').set('7', { title: 'Native', parentId: null })
    const document = await prepareNote(vault, database, '7')
    const paragraph = new Y.XmlElement('paragraph')
    const text = new Y.XmlText()
    text.insert(0, 'New native content')
    paragraph.insert(0, [text])
    document.doc.getXmlFragment('default').insert(1, [paragraph])
    await document.indexPending
    await vault.delete('7')
    const before = Y.encodeStateAsUpdate(document.doc)
    const backup = await createBackup(vault, await database.pages.toArray())
    expect(await database.pages.toArray()).toEqual([row])
    expect(backup.payload.legacy).toEqual([row])
    expect(Y.encodeStateAsUpdate(document.doc)).toEqual(before)
    expect(vault.workspace.doc.getMap('deletedPages').has('7')).toBe(true)
    expect(await database.searchProjection.get('7')).toHaveProperty('content')
    expect((await database.searchProjection.get('7')).content).toContain('New native content')
    expect(backup.payload.documents[0].update).toBe(btoa(String.fromCharCode(...before)))
  } finally { await vault.close(); await database.delete() }
})
