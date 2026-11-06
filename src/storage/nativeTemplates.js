import * as Y from 'yjs'
import { encodeDocument } from './nativeDocument'

export function localDay(date = new Date()) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
}

export function nativeTemplate(kind = 'note', date = new Date()) {
  const day = localDay(date), doc = new Y.Doc()
  const blocks = kind === 'meeting' ? [['heading', 'Meeting · ' + day], ['paragraph', 'Participants: '], ['heading', 'Notes'], ['paragraph', ''], ['heading', 'Next actions'], ['paragraph', '[ ] ']] : kind === 'daily' ? [['heading', day], ['paragraph', '']] : []
  for (const [type, text] of blocks) {
    const block = new Y.XmlElement(type)
    if (type === 'heading') block.setAttribute('level', 2)
    if (text) { const value = new Y.XmlText(); value.insert(0, text); block.insert(0, [value]) }
    doc.getXmlFragment('default').push([block])
  }
  const document = encodeDocument(Y.encodeStateAsUpdate(doc)); doc.destroy()
  return { id: kind === 'daily' ? 'daily:' + day : crypto.randomUUID(), document,
    metadata: { title: kind === 'daily' ? day : kind === 'capture' ? 'Inbox capture' : kind === 'meeting' ? 'Meeting · ' + day : 'Untitled',
      parentId: null, kind, date: day, tags: kind === 'capture' ? ['inbox'] : [], status: 'todo' } }
}
