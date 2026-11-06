import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { NativeDocument, retainedDrafts, editableDocument, encodeDocument } from './nativeDocument'

const vaultId = 'a'.repeat(64)
function note() {
  const doc = new Y.Doc(), bytes = Y.encodeStateAsUpdate(doc); doc.destroy()
  return { id: 'note', version: 1, contentHash: 'b'.repeat(64), metadata: { title: 'Original', parentId: null }, document: encodeDocument(bytes), deleted: null, recovery: false, contentState: 'native' }
}
afterEach(() => localStorage.clear())

describe('native pending write recovery', () => {
  it('waits for the recovery transaction before sending or claiming retention', async () => {
    let unblock, blocked = false, writes = 0
    const storage = { setItem: async (key, value) => {
      if (blocked) { blocked = false; await new Promise(resolve => { unblock = resolve }) }
      localStorage.setItem(key, value)
    }, removeItem: key => localStorage.removeItem(key) }
    const client = { write: async (_, body) => { writes++; return { ...note(), ...body, version: 2 } } }
    const model = new NativeDocument(client, vaultId, note(), { storage })
    await model.ready; blocked = true
    model.setMetadata({ title: 'Durable before sending' })
    const saving = model.flush()
    while (!unblock) await new Promise(resolve => setTimeout(resolve, 0))
    expect(model.status).toBe('journaling'); expect(writes).toBe(0)
    unblock(); expect(await saving).toBe(true)
    expect(writes).toBe(1); expect(model.status).toBe('saved')
    model.dispose()
  })
  it('recovers the last acknowledged write after a response is lost without duplicating it', async () => {
    let saved = note(), writes = 0
    const client = { get: async () => saved, write: async (_, body) => {
      writes++; saved = { ...saved, ...body, version: saved.version + 1 }; throw new TypeError('connection lost')
    } }
    const first = new NativeDocument(client, vaultId, saved, { storage: localStorage })
    first.setMetadata({ title: '한국어 retained' })
    expect(await first.flush()).toBe(false)
    expect(first.status).toBe('offline')
    const draft = (await retainedDrafts(vaultId, localStorage))[0]
    expect(draft.metadata.title).toBe('한국어 retained')
    first.dispose()
    const recovered = new NativeDocument(client, vaultId, saved, { draft, storage: localStorage })
    await recovered.ready
    expect(recovered.status).toBe('saved')
    expect(await recovered.flush()).toBe(true)
    expect(writes).toBe(1)
    expect((await retainedDrafts(vaultId, localStorage))).toHaveLength(0)
    recovered.dispose()
  })
  it('retains independent tab drafts and rejects a conflicting saved version', async () => {
    const saved = note(), first = new NativeDocument({}, vaultId, saved, { storage: localStorage }), second = new NativeDocument({}, vaultId, saved, { storage: localStorage })
    await Promise.all([first.ready, second.ready])
    first.setMetadata({ title: 'First tab' }); second.setMetadata({ title: 'Second tab' })
    await Promise.all([first.journal, second.journal])
    expect((await retainedDrafts(vaultId, localStorage))).toHaveLength(2)
    const draft = (await retainedDrafts(vaultId, localStorage)).find(item => item.metadata.title === 'First tab')
    const recovered = new NativeDocument({}, vaultId, { ...saved, version: 2, metadata: { title: 'Someone else' } }, { draft, storage: localStorage })
    await recovered.ready
    expect(recovered.status).toBe('conflict')
    expect(recovered.metadata.title).toBe('First tab')
    expect((await retainedDrafts('c'.repeat(64), localStorage))).toHaveLength(0)
    first.dispose(); second.dispose(); recovered.dispose()
  })
  it('preserves edits made while a previous version is in flight', async () => {
    let saved = note(), acknowledge, writes = 0
    const client = { write: async (_, body) => {
      writes++
      if (writes === 1) await new Promise(resolve => { acknowledge = resolve })
      saved = { ...saved, ...structuredClone(body), version: saved.version + 1 }
      return saved
    } }
    const model = new NativeDocument(client, vaultId, saved, { storage: localStorage })
    await model.ready
    model.setMetadata({ title: 'First' }); const saving = model.flush()
    while (!acknowledge) await new Promise(resolve => setTimeout(resolve, 0))
    model.setMetadata({ title: 'Second' }); acknowledge(); await saving
    expect(saved.metadata.title).toBe('Second')
    expect(writes).toBe(2)
    expect(model.status).toBe('saved')
    expect((await retainedDrafts(vaultId, localStorage))).toHaveLength(0)
    model.dispose()
  })
  it('keeps unsupported rich-text source unchanged and refuses editing', () => {
    const doc = new Y.Doc(), unknown = new Y.XmlElement('unknownEmbed')
    unknown.setAttribute('source', 'retained'); doc.getXmlFragment('default').insert(0, [unknown])
    const original = encodeDocument(Y.encodeStateAsUpdate(doc))
    expect(() => editableDocument({ ...note(), document: original })).toThrow(/Unsupported/)
    expect(encodeDocument(Y.encodeStateAsUpdate(doc))).toBe(original)
    doc.destroy()
  })
  it('does not claim saved when browser recovery storage becomes unavailable', async () => {
    let failing = false
    const storage = { setItem: (...args) => { if (failing) throw new Error('quota'); localStorage.setItem(...args) }, removeItem: key => localStorage.removeItem(key) }
    const model = new NativeDocument({}, vaultId, note(), { storage })
    await model.ready
    failing = true; model.setMetadata({ title: 'Must export' })
    await model.journal.catch(() => {})
    expect(model.status).toBe('storage-error')
    expect(await model.flush()).toBe(false)
    expect(model.snapshot().metadata.title).toBe('Must export')
    model.dispose()
  })
})
