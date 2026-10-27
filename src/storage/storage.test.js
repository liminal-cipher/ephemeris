import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { BrowserVault } from './browserVault'
import { LocalDocument } from './localDocument'
import { createBackup, parseBackup, restoreBackup } from './backup'
import { createPage, updatePage, deletePage, readPages, restorePage } from './workspaceModel'
import { initializeLegacyContent, readContent } from './noteContent'
import { bootstrapWorkspace } from './bootstrapWorkspace'

const opened = []
const openVault = async (prefix = `test-${crypto.randomUUID()}`) => {
  const vault = new BrowserVault({ prefix, broadcast: false })
  opened.push(vault)
  await vault.ready
  return vault
}
const content = text => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
afterEach(async () => {
  await Promise.all(opened.splice(0).map(vault => vault.close().catch(() => {})))
  vi.restoreAllMocks()
})

describe('local persistence and legacy recovery', () => {
  it('bootstraps legacy metadata once and never resurrects a historically empty workspace', async () => {
    const legacy = { pages: { toArray: async () => [{ id: 1, title: 'Legacy', content: 'untouched' }] } }
    const vault = await openVault()
    await bootstrapWorkspace(vault, legacy)
    expect(vault.list()[0]).toMatchObject({ id: '1', title: 'Legacy' })
    await vault.delete('1')
    await bootstrapWorkspace(vault, legacy)
    expect(vault.list()).toEqual([])
    const historical = await openVault()
    historical.workspace.doc.getMap('pages').set('1', { title: 'Old deleted page' })
    historical.workspace.doc.getMap('pages').delete('1')
    await bootstrapWorkspace(historical, legacy)
    expect(historical.list()).toEqual([])
  })
  it('reopens offline content, IDs, metadata and deletion records after a restart', async () => {
    const vault = await openVault()
    const id = vault.create(null, { title: 'Offline' })
    await initializeLegacyContent(vault.openDocument(id), { content: JSON.stringify(content('Persist me')) })
    vault.update(id, { title: 'Renamed' })
    await vault.flush()
    const reopened = await openVault(vault.prefix)
    expect(reopened.list()[0]).toMatchObject({ id, title: 'Renamed' })
    const document = reopened.openDocument(id)
    await document.ready
    expect(readContent(document.doc).content[0].content[0].text).toBe('Persist me')
    await reopened.delete(id)
    await reopened.flush()
    const third = await openVault(vault.prefix)
    expect(third.list()).toEqual([])
    await third.restore(id)
    expect(third.list()[0].id).toBe(id)
  })

  it('reads the existing y-indexeddb wire format without changing its database', async () => {
    const name = `test-${crypto.randomUUID()}`
    const original = new Y.Doc()
    const persistence = new IndexeddbPersistence(name, original)
    await persistence.whenSynced
    original.getText('test').insert(0, 'Old persisted data')
    await persistence.set('barrier', 'saved')
    await persistence.destroy()
    original.destroy()
    const local = new LocalDocument(name, { broadcast: false })
    await local.ready
    expect(local.doc.getText('test').toString()).toBe('Old persisted data')
    local.doc.getText('test').insert(18, '!')
    await local.close()
    const rollbackDoc = new Y.Doc()
    const rollbackPersistence = new IndexeddbPersistence(name, rollbackDoc)
    await rollbackPersistence.whenSynced
    expect(rollbackDoc.getText('test').toString()).toContain('!')
    await rollbackPersistence.destroy()
    rollbackDoc.destroy()
  })

  it('uses identical seed updates for concurrent legacy initialisation', async () => {
    const first = await openVault()
    const second = await openVault(first.prefix)
    const a = first.openDocument('legacy')
    const b = second.openDocument('legacy')
    await Promise.all([a.ready, b.ready])
    await Promise.all([a, b].map(document => initializeLegacyContent(document, { content: JSON.stringify(content('Only once')) })))
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc))
    expect(readContent(a.doc).content).toHaveLength(1)
  })

  it('does not restore stale legacy content after deliberate deletion of text', async () => {
    const vault = await openVault()
    const document = vault.openDocument('empty')
    await initializeLegacyContent(document, { content: JSON.stringify(content('Old')) })
    document.doc.getXmlFragment('default').delete(0, 1)
    await initializeLegacyContent(document, { content: JSON.stringify(content('Old')) })
    expect(readContent(document.doc).content).toEqual([])
  })

  it('rejects unsupported legacy nodes without changing their original content', async () => {
    const vault = await openVault()
    const document = vault.openDocument('unsupported')
    const legacy = { content: JSON.stringify({ type: 'doc', content: [{ type: 'futureWidget' }] }) }
    await expect(initializeLegacyContent(document, legacy)).rejects.toThrow()
    expect(document.doc.getXmlFragment('default').length).toBe(0)
    expect(legacy.content).toContain('futureWidget')
  })

  it('reports failed saves instead of acknowledging them', async () => {
    const vault = await openVault()
    vi.spyOn(vault.workspace, 'append').mockRejectedValue(new Error('Quota exceeded'))
    vault.create(null, { title: 'Unsaved' })
    await expect(vault.flush()).rejects.toThrow('Quota exceeded')
    expect(vault.workspace.status).toBe('error')
    expect(vault.list()[0].title).toBe('Unsaved')
  })

  it('does not hide a page when the durable deletion transaction fails', async () => {
    const vault = await openVault()
    const id = vault.create(null, { title: 'Still here' })
    await vault.flush()
    vi.spyOn(vault.workspace, 'append').mockRejectedValue(new Error('Disk full'))
    await expect(vault.delete(id)).rejects.toThrow('Disk full')
    expect(vault.list()[0].id).toBe(id)
    expect(vault.workspace.doc.getMap('deletedPages').has(id)).toBe(false)
  })
})

describe('backup and additive restoration', () => {
  it('does not revive a stale cache when restoring a historically emptied native document', async () => {
    const source = await openVault()
    const id = source.create()
    const document = source.openDocument(id)
    await document.ready
    document.doc.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')])
    document.doc.getXmlFragment('default').delete(0, 1)
    const backup = await createBackup(source, [{ id, content: JSON.stringify(content('Deleted text')) }])
    const destination = await openVault()
    const { mapping } = await restoreBackup(destination, JSON.stringify(backup))
    const restored = destination.openDocument(mapping.get(id))
    await initializeLegacyContent(restored)
    expect(readContent(restored.doc).content).toEqual([])
  })
  it('round trips unopened notes, rich text, attachments, metadata and tombstones', async () => {
    const source = await openVault()
    const image = 'data:image/png;base64,aGVsbG8='
    const parent = source.create(null, { title: 'Parent', emoji: image, coverImage: image, custom: { tags: ['one'] } })
    const child = source.create(parent, { title: 'Child' })
    const deleted = source.create(null, { title: 'Deleted' })
    await source.delete(deleted)
    const json = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: child, label: 'Child' } }, { type: 'text', text: ' Bold', marks: [{ type: 'bold' }] }] }] }
    await initializeLegacyContent(source.openDocument(parent), { content: JSON.stringify(json) })
    const backup = await createBackup(source, [], { ephemeris_custom_emojis: JSON.stringify([image]), password: 'excluded' })
    expect(backup.payload.documents).toHaveLength(3)
    expect(backup.payload.settings.password).toBeUndefined()
    const destination = await openVault()
    const existing = destination.create(null, { title: 'Keep me' })
    const result = await restoreBackup(destination, JSON.stringify(backup))
    expect(destination.list()).toHaveLength(3)
    expect(destination.list().find(page => page.id === existing).title).toBe('Keep me')
    expect(destination.list().find(page => page.title === 'Child').parentId).toBe(result.mapping.get(parent))
    expect(destination.list().find(page => page.title === 'Parent')).toMatchObject({ emoji: image, coverImage: image, custom: { tags: ['one'] } })
    const restored = destination.openDocument(result.mapping.get(parent))
    expect(readContent(restored.doc).content[0].content[0].attrs.id).toBe(result.mapping.get(child))
    expect(destination.workspace.doc.getMap('deletedPages').has(result.mapping.get(deleted))).toBe(true)
    const secondBackup = await createBackup(destination)
    await expect(parseBackup(JSON.stringify(secondBackup))).resolves.toBeDefined()
  })

  it('restores old array backups as new notes and remaps links without overwriting', async () => {
    const vault = await openVault()
    const current = vault.create(null, { title: 'Existing' })
    const old = [{ id: 1, title: 'Legacy parent', content: JSON.stringify(content('Old body')), parentId: null }, { id: 2, title: 'Legacy child', parentId: 1 }]
    const { mapping } = await restoreBackup(vault, JSON.stringify(old))
    const document = vault.openDocument(mapping.get('1'))
    await initializeLegacyContent(document)
    expect(readContent(document.doc).content[0].content[0].text).toBe('Old body')
    expect(vault.list().some(page => page.id === current)).toBe(true)
    expect(vault.list().find(page => page.title === 'Legacy child').parentId).toBe(mapping.get('1'))
  })

  it('validates a damaged backup before writing any destination data', async () => {
    const source = await openVault()
    source.create(null, { title: 'Exported' })
    const backup = await createBackup(source)
    backup.payload.documents[0].update = 'broken!'
    const destination = await openVault()
    await expect(restoreBackup(destination, JSON.stringify(backup))).rejects.toThrow()
    expect(destination.list()).toEqual([])
    expect(destination.documents.size).toBe(0)
  })

  it.each([
    '[{"id":"../outside"}]', '[{"title":"Missing ID"}]',
    '[{"id":"x","parentId":"x"}]', '[{"id":1},{"id":"1"}]',
    '[{"id":"x","__proto__":{"polluted":true}}]',
    '{"format":"ephemeris-workspace","version":999}',
  ])('rejects invalid input: %s', async input => {
    await expect(parseBackup(input)).rejects.toThrow()
  })

  it('keeps destination unchanged if staging is interrupted', async () => {
    const vault = await openVault()
    vault.create(null, { title: 'Keep' })
    await vault.flush()
    const open = vault.openDocument.bind(vault)
    vi.spyOn(vault, 'openDocument').mockImplementation(id => {
      const document = open(id)
      vi.spyOn(document, 'flush').mockRejectedValue(new Error('Interrupted'))
      return document
    })
    await expect(restoreBackup(vault, '[{"id":"legacy","title":"Imported"}]')).rejects.toThrow('Interrupted')
    expect(vault.list().map(page => page.title)).toEqual(['Keep'])
  })
})

describe('independent Yjs clients (simulated transport)', () => {
  it('keeps pages reachable when concurrent moves form a cycle', () => {
    const a = new Y.Doc(), b = new Y.Doc()
    createPage(a, null, {}, 'a'); createPage(a, null, {}, 'b')
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    updatePage(a, 'a', { parentId: 'b' }); updatePage(b, 'b', { parentId: 'a' })
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b)); Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    expect(readPages(a)).toEqual(readPages(b))
    expect(readPages(a).a).toMatchObject({ parentId: null, recoveredParentId: 'b', hierarchyIssue: true })
    expect(a.getMap('pageFields').get('["a","parentId"]')).toBe('b')
    a.destroy(); b.destroy()
  })
  it('merges separate metadata fields; deletion wins over a concurrent modification', () => {
    const a = new Y.Doc(); const b = new Y.Doc()
    createPage(a, null, { title: 'Original', emoji: '' }, 'note')
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    updatePage(a, 'note', { title: 'New title' })
    updatePage(b, 'note', { emoji: '🌙' })
    const aUpdate = Y.encodeStateAsUpdate(a), bUpdate = Y.encodeStateAsUpdate(b)
    Y.applyUpdate(a, bUpdate); Y.applyUpdate(b, aUpdate)
    expect(readPages(a).note).toMatchObject({ title: 'New title', emoji: '🌙' })
    expect(readPages(b)).toEqual(readPages(a))
    deletePage(a, 'note'); updatePage(b, 'note', { title: 'Concurrent change' })
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b)); Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    expect(readPages(a)).toEqual({})
    restorePage(a, 'note')
    expect(readPages(a).note.title).toBe('Concurrent change')
    a.destroy(); b.destroy()
  })

  it('converges on same-section and different-section edits after duplicate and out-of-order delivery', () => {
    const a = new Y.Doc(), b = new Y.Doc()
    a.getText('first').insert(0, 'base')
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    const updatesA = [], updatesB = []
    a.on('update', update => updatesA.push(update)); b.on('update', update => updatesB.push(update))
    a.getText('first').insert(0, 'A'); a.getText('second').insert(0, 'section A')
    b.getText('first').insert(0, 'B'); b.getText('third').insert(0, 'section B')
    const incomingA = [...updatesB].reverse(), incomingB = [...updatesA].reverse()
    incomingA.forEach(update => { Y.applyUpdate(a, update); Y.applyUpdate(a, update) })
    incomingB.forEach(update => { Y.applyUpdate(b, update); Y.applyUpdate(b, update) })
    for (const section of ['first', 'second', 'third']) expect(a.getText(section).toString()).toBe(b.getText(section).toString())
    expect(a.getText('first').toString()).toContain('A'); expect(a.getText('first').toString()).toContain('B')
    a.destroy(); b.destroy()
  })

  it('rejects moves that introduce hierarchy cycles before mutation', () => {
    const doc = new Y.Doc()
    createPage(doc, null, {}, 'a'); createPage(doc, 'a', {}, 'b')
    expect(() => updatePage(doc, 'a', { parentId: 'b' })).toThrow('hierarchy')
    expect(readPages(doc).a.parentId).toBeNull()
    doc.destroy()
  })
})
