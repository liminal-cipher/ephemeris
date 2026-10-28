import * as Y from 'yjs'
import { readPages, cloneDocument } from './workspaceModel.js'

const MAX_BYTES = 50 * 1024 * 1024
export const PRESENTATION_KEYS = ['ephemeris_custom_emojis', 'ephemeris_panels_position', 'ephemeris_show_details_panel']
const encode = bytes => {
  let result = ''
  for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(result)
}
const decode = value => {
  if (typeof value !== 'string' || value.length > MAX_BYTES || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid binary document')
  return Uint8Array.from(atob(value), char => char.charCodeAt(0))
}
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('')
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 200 && ![...id].some(char => char.charCodeAt(0) < 32 || char === '/' || char === '\\') && !['__proto__', 'constructor', 'prototype'].includes(id)

function validateTree(pages) {
  for (const [id, page] of Object.entries(pages)) {
    if (!validId(id) || !page || typeof page !== 'object' || Array.isArray(page)) throw new Error('Invalid page metadata')
    for (const field of ['title', 'emoji', 'coverImage']) if (page[field] != null && typeof page[field] !== 'string') throw new Error('Invalid page metadata')
    const seen = new Set([id])
    let parent = page.parentId
    while (parent != null) {
      if (!validId(parent) || seen.has(parent) || !pages[parent]) throw new Error('Invalid or cyclic page hierarchy')
      seen.add(parent)
      parent = pages[parent].parentId
    }
  }
}

export async function createBackup(vault, legacy = [], settings = {}) {
  await vault.ready
  await vault.flush()
  // Capture metadata first. Later edits belong to the next backup, not this one.
  const workspace = encode(Y.encodeStateAsUpdate(vault.workspace.doc))
  const captured = cloneDocument(decode(workspace))
  const ids = new Set([...Object.keys(readPages(captured, true)), ...legacy.map(page => String(page.id)), ...captured.getMap('recoveryDocuments').keys()])
  captured.destroy()
  if (ids.size > 10000) throw new Error('Backup supports at most 10,000 documents')
  const documents = []
  for (const id of ids) {
    const document = vault.openDocument(id)
    await document.flush()
    documents.push({ id, update: encode(Y.encodeStateAsUpdate(document.doc)) })
  }
  const safeSettings = Object.fromEntries(PRESENTATION_KEYS.filter(key => typeof settings[key] === 'string').map(key => [key, settings[key]]))
  const payload = { createdAt: new Date().toISOString(), workspace, documents, legacy, settings: safeSettings }
  const backup = { format: 'ephemeris-workspace', version: 2, payload, sha256: await hash(JSON.stringify(payload)) }
  if (new TextEncoder().encode(JSON.stringify(backup)).length > MAX_BYTES) throw new Error('Backup exceeds the supported 50 MiB limit; local data has not been changed')
  return backup
}

export async function parseBackup(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('Backup exceeds the 50 MiB limit')
  const data = JSON.parse(text, (key, value) => {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsafe backup property')
    return value
  })
  if (Array.isArray(data)) {
    if (data.length > 10000) throw new Error('Too many pages')
    const pages = Object.create(null)
    for (const row of data) {
      if (!row || !['string', 'number'].includes(typeof row.id) || !validId(String(row.id)) || pages[String(row.id)]) throw new Error('Invalid or duplicate legacy page')
      if (row.content != null && typeof row.content !== 'string') throw new Error('Invalid legacy content')
      const { id, content: _content, ...metadata } = row
      pages[String(id)] = { ...metadata, parentId: row.parentId == null ? null : String(row.parentId) }
    }
    validateTree(pages)
    return { pages, deleted: {}, documents: data.map(row => ({ id: String(row.id), update: Y.encodeStateAsUpdate(new Y.Doc()) })), legacy: data, settings: {} }
  }
  if (data?.format !== 'ephemeris-workspace' || data.version !== 2 || !data.payload || data.sha256 !== await hash(JSON.stringify(data.payload))) throw new Error('Unsupported or damaged backup')
  const payload = data.payload
  if (!Array.isArray(payload.documents) || payload.documents.length > 10000 || !Array.isArray(payload.legacy)) throw new Error('Invalid backup manifest')
  const workspace = cloneDocument(decode(payload.workspace))
  try {
    if (workspace.store.pendingStructs || workspace.store.pendingDs) throw new Error('Incomplete workspace update')
    const pages = readPages(workspace, true)
    validateTree(pages)
    const ids = new Set()
    const documents = payload.documents.map(entry => {
      if (!validId(entry.id) || ids.has(entry.id)) throw new Error('Invalid or duplicate document ID')
      ids.add(entry.id)
      const update = decode(entry.update)
      const decoded = cloneDocument(update)
      try {
        if (decoded.store.pendingStructs || decoded.store.pendingDs) throw new Error('Incomplete document update')
      } finally { decoded.destroy() }
      return { id: entry.id, update }
    })
    if (Object.keys(pages).some(id => !ids.has(id))) throw new Error('Backup is missing a document')
    if (payload.legacy.some(row => !row || !validId(String(row.id)) || !ids.has(String(row.id)) || (row.content != null && typeof row.content !== 'string'))) throw new Error('Invalid legacy recovery data')
    const settings = payload.settings || {}
    if (Object.entries(settings).some(([key, value]) => !PRESENTATION_KEYS.includes(key) || typeof value !== 'string')) throw new Error('Invalid presentation settings')
    if (settings.ephemeris_custom_emojis) {
      const icons = JSON.parse(settings.ephemeris_custom_emojis)
      if (!Array.isArray(icons) || icons.some(icon => typeof icon !== 'string')) throw new Error('Invalid icon library')
    }
    if (settings.ephemeris_panels_position && !['bottom', 'right'].includes(settings.ephemeris_panels_position)) throw new Error('Invalid panel position')
    if (settings.ephemeris_show_details_panel && !['true', 'false'].includes(settings.ephemeris_show_details_panel)) throw new Error('Invalid panel visibility')
    return { pages, deleted: workspace.getMap('deletedPages').toJSON(), documents, legacy: payload.legacy, settings, originalWorkspace: payload.workspace }
  } finally { workspace.destroy() }
}

