import * as Y from 'yjs'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Mention from '@tiptap/extension-mention'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import MathExtension from '@aarkue/tiptap-math-extension'
import { lowlight } from 'lowlight'
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from 'y-prosemirror'

// Legacy codec adapter, separate from the storage core and editor controls.
export const noteSchema = getSchema([
  StarterKit.configure({ history: false, codeBlock: false }), Underline,
  Mention, CodeBlockLowlight.configure({ lowlight }), MathExtension,
])

export function validateContent(json) {
  const inspect = (value, isMark = false) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid document node')
    const type = (isMark ? noteSchema.marks : noteSchema.nodes)[value.type]
    if (!type) throw new Error(`Unsupported document type: ${value.type}`)
    const allowed = isMark ? ['type', 'attrs'] : ['type', 'attrs', 'content', 'text', 'marks']
    if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unsupported document property; original data retained')
    if (value.attrs && Object.keys(value.attrs).some(key => !Object.hasOwn(type.attrs, key))) throw new Error('Unsupported document attribute; original data retained')
    value.content?.forEach(child => inspect(child))
    value.marks?.forEach(mark => inspect(mark, true))
  }
  inspect(json)
  const node = noteSchema.nodeFromJSON(json)
  node.check()
  if (node.type.name !== 'doc') throw new Error('Expected a document')
  return node
}

export function remapLinks(json, mapping) {
  if (!json || typeof json !== 'object') return json
  if (json.type === 'mention' && json.attrs && mapping.has(String(json.attrs.id))) json.attrs.id = mapping.get(String(json.attrs.id))
  if (Array.isArray(json.content)) json.content.forEach(child => remapLinks(child, mapping))
  return json
}

export async function initializeLegacyContent(document, legacy) {
  await document.ready
  const state = document.doc.getMap('ephemeris')
  if (state.has('initialized')) return
  legacy = state.get('legacyRecord') || legacy
  if (document.doc.getXmlFragment('default').length || (document.doc.store.clients.size > 0 && !state.has('legacyRecord'))) {
    state.set('initialized', true)
    await document.flush()
    return
  }
  if (legacy?.content) {
    const json = JSON.parse(legacy.content)
    validateContent(json)
    if (legacy.legacySource === 'NotionCloneDB') {
      const visit = node => {
        if (node.type === 'mention' && node.attrs?.id != null) node.attrs.id = `notion-${node.attrs.id}`
        node.content?.forEach(visit)
      }
      visit(json)
    }
    // Identical initial updates prevent duplicate paragraphs when tabs race.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${document.name}:${legacy.content}`))
    const seeded = prosemirrorJSONToYDoc(noteSchema, json, 'default')
    const deterministic = new Y.Doc()
    deterministic.clientID = new DataView(digest).getUint32(0)
    deterministic.getXmlFragment('default').insert(0, seeded.getXmlFragment('default').toArray().map(node => node.clone()))
    deterministic.getMap('ephemeris').set('legacyContent', legacy.content)
    deterministic.getMap('ephemeris').set('initialized', true)
    Y.applyUpdate(document.doc, Y.encodeStateAsUpdate(deterministic))
    seeded.destroy()
    deterministic.destroy()
  } else {
    state.set('initialized', true)
  }
  await document.flush()
}

export function readContent(doc) { return yDocToProsemirrorJSON(doc, 'default') }
