import * as Y from 'yjs'

// Deliberately narrow codec: only plain paragraphs/text, and only when the
// original JSON structure can be reconstructed exactly. Raw input is retained.
export function convertPlainLegacy(note) {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, note.document)
    const state = doc.getMap('ephemeris')
    const contents = [...note.legacyRecords, state.get('legacyRecord')].filter(Boolean).map(row => row.content).filter(Boolean)
    if (!contents.length || new Set(contents).size !== 1) throw new Error('Missing or ambiguous legacy content')
    if (doc.getXmlFragment('default').length) throw new Error('Existing native content prevents conversion')
    const raw = contents[0], json = JSON.parse(raw)
    const exactKeys = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key))
    if (!exactKeys(json, ['type', 'content']) || json.type !== 'doc' || !Array.isArray(json.content) || !json.content.length) throw new Error('Unsupported legacy structure')
    const roundTrip = { type: 'doc', content: [] }
    for (const paragraph of json.content) {
      if (!exactKeys(paragraph, ['type', 'content']) || paragraph.type !== 'paragraph' || !Array.isArray(paragraph.content)) throw new Error('Unsupported legacy paragraph')
      const element = new Y.XmlElement('paragraph')
      doc.getXmlFragment('default').insert(doc.getXmlFragment('default').length, [element])
      for (const text of paragraph.content) {
        if (!exactKeys(text, ['type', 'text']) || text.type !== 'text' || typeof text.text !== 'string' || !text.text) throw new Error('Unsupported legacy text')
        const node = new Y.XmlText(); node.insert(0, text.text); element.insert(element.length, [node])
      }
      roundTrip.content.push({ type: 'paragraph', content: element.toArray().map(node => ({ type: 'text', text: node.toString() })) })
    }
    // Compare structure independent of object key order, but never drop fields.
    if (JSON.stringify(json.content.map(p => p.content.map(t => t.text))) !== JSON.stringify(roundTrip.content.map(p => p.content.map(t => t.text)))) throw new Error('Legacy round-trip mismatch')
    state.set('legacyNativeUpdate', Buffer.from(note.document).toString('base64'))
    state.set('legacyContent', raw)
    state.set('initialized', true)
    return Y.encodeStateAsUpdate(doc)
  } finally { doc.destroy() }
}
