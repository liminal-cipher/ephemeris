import * as Y from 'yjs'

const CONTAINERS = new Set(['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'codeBlock'])
const ATTRIBUTES = { heading: ['level'], orderedList: ['start'], codeBlock: ['language'], mention: ['id', 'label'] }
const MARKS = new Set(['bold', 'italic', 'strike', 'underline', 'code', 'link'])
const MAX_TEXT = 1024 * 1024

// Read-only projection: unknown content is retained, never rewritten or passed
// through an editor codec. Coverage accompanies every preview/search result.
export function projectText(document, contentState = 'native') {
  if (contentState === 'legacy-only') return { text: '', coverage: 'unsupported', reasons: ['legacy-only'] }
  const doc = new Y.Doc(), parts = [], reasons = new Set()
  let length = 0
  const append = text => {
    if (typeof text !== 'string') return
    if (length + text.length > MAX_TEXT) reasons.add('text-limit')
    const part = text.slice(0, Math.max(0, MAX_TEXT - length))
    parts.push(part); length += part.length
  }
  const visit = (node, depth = 0) => {
    if (depth > 100) { reasons.add('nesting-limit'); return }
    if (node instanceof Y.XmlText || node instanceof Y.Text) {
      for (const delta of node.toDelta()) {
        for (const mark of Object.keys(delta.attributes || {})) if (!MARKS.has(mark)) reasons.add(`mark:${mark}`)
        if (typeof delta.insert === 'string') append(delta.insert)
        else reasons.add('embedded-object')
      }
    } else if (node instanceof Y.XmlElement) {
      for (const attribute of Object.keys(node.getAttributes())) if (!(ATTRIBUTES[node.nodeName] || []).includes(attribute)) reasons.add(`attribute:${node.nodeName}.${attribute}`)
      if (node.nodeName === 'mention') {
        const label = node.getAttribute('label') || node.getAttribute('id')
        if (typeof label === 'string' || typeof label === 'number') append(String(label))
        else reasons.add('invalid-mention-label')
      }
      else if (node.nodeName === 'hardBreak' || node.nodeName === 'horizontalRule') append('\n')
      else if (!CONTAINERS.has(node.nodeName)) reasons.add(`node:${node.nodeName}`)
      node.toArray().forEach(child => visit(child, depth + 1))
      if (CONTAINERS.has(node.nodeName)) append('\n')
    } else reasons.add('unknown-shared-type')
  }
  try {
    Y.applyUpdate(doc, document)
    for (const key of doc.share.keys()) {
      if (key === 'default') {
        const fragment = doc.getXmlFragment(key)
        if (fragment._map.size) reasons.add('unsupported-default-map')
        fragment.toArray().forEach(node => visit(node))
      } else if (key === 'body') {
        const body = doc.getText(key)
        if (body._map.size) reasons.add('unsupported-body-map')
        visit(body)
      }
      else if (!['ephemeris', 'attachments'].includes(key)) reasons.add(`root:${key}`)
    }
  } catch { reasons.add('unsupported-document-structure') }
  finally { doc.destroy() }
  const text = parts.join('').trim()
  return { text, coverage: reasons.size ? (text ? 'partial' : 'unsupported') : 'complete', reasons: [...reasons].sort() }
}

export function searchProjection(note) {
  const projection = projectText(note.document, note.contentState)
  const fields = []
  const collect = (value, depth = 0) => {
    if (depth > 100) return
    if (typeof value === 'string' && !value.startsWith('data:')) fields.push(value)
    else if (typeof value === 'number' || typeof value === 'boolean') fields.push(String(value))
    else if (value && typeof value === 'object') Object.values(value).forEach(child => collect(child, depth + 1))
  }
  collect(note.metadata)
  const combined = [...fields, projection.text].join('\n')
  if (combined.length > MAX_TEXT && !projection.reasons.includes('text-limit')) {
    projection.reasons.push('text-limit')
    if (projection.coverage === 'complete') projection.coverage = 'partial'
  }
  return { ...projection, indexedText: combined.slice(0, MAX_TEXT).normalize('NFC').toLowerCase() }
}

export function pageOptions({ limit = 50, offset = 0 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000) throw new Error('Invalid pagination')
  return { limit, offset }
}
