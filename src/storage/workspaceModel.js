import * as Y from 'yjs'

export function readPages(doc, includeDeleted = false) {
  const pages = Object.fromEntries([...doc.getMap('pages')].map(([id, value]) => {
    if (['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('Invalid page identifier')
    return [id, structuredClone(value)]
  }))
  for (const [key, value] of doc.getMap('pageFields')) {
    const parts = JSON.parse(key)
    if (!Array.isArray(parts) || parts.length !== 2 || parts.some(part => typeof part !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(part))) throw new Error('Invalid metadata patch')
    const [id, field] = parts
    if (pages[id]) pages[id][field] = value
  }
  if (!includeDeleted) for (const id of doc.getMap('deletedPages').keys()) delete pages[id]
  // Concurrent moves can form a cycle despite local validation. Expose a
  // deterministic root, retaining the original relationships in native backups.
  for (const id of Object.keys(pages).sort()) {
    const path = []
    let current = id
    while (current != null && pages[current]) {
      if (path.includes(current)) {
        const root = path.slice(path.indexOf(current)).sort()[0]
        pages[root].recoveredParentId = pages[root].parentId
        pages[root].parentId = null
        pages[root].hierarchyIssue = true
        break
      }
      path.push(current)
      const parent = pages[current].parentId
      if (parent != null && !pages[parent]) {
        pages[current].recoveredParentId = parent
        pages[current].parentId = null
        pages[current].hierarchyIssue = true
      }
      current = pages[current].parentId
    }
  }
  return pages
}

export function createPage(doc, parentId = null, metadata = {}, id = crypto.randomUUID()) {
  const pages = readPages(doc)
  if (parentId !== null && !pages[parentId]) throw new Error('Parent page does not exist')
  if (doc.getMap('pages').has(id) || doc.getMap('deletedPages').has(id)) throw new Error('Page already exists')
  doc.getMap('pages').set(id, {
    title: '', emoji: '', coverImage: '', createdAt: Date.now(), updatedAt: Date.now(),
    ...metadata, parentId,
  })
  return id
}

export function updatePage(doc, id, changes) {
  id = String(id)
  const pages = readPages(doc)
  if (!pages[id]) throw new Error('Page does not exist or has been deleted')
  if (Object.keys(changes).some(field => ['__proto__', 'constructor', 'prototype', 'id'].includes(field))) throw new Error('Invalid metadata field')
  if ('parentId' in changes) {
    const seen = new Set([id])
    let parent = changes.parentId
    while (parent !== null) {
      if (seen.has(parent) || !pages[parent]) throw new Error('Invalid page hierarchy')
      seen.add(parent)
      parent = pages[parent].parentId ?? null
    }
  }
  doc.transact(() => {
    for (const [field, value] of Object.entries({ ...changes, updatedAt: Date.now() })) {
      doc.getMap('pageFields').set(JSON.stringify([id, field]), value)
    }
  })
}

export function deletePage(doc, id) {
  const pages = readPages(doc)
  const pending = [String(id)]
  const visited = new Set()
  doc.transact(() => {
    while (pending.length) {
      const current = pending.pop()
      if (visited.has(current)) continue
      visited.add(current)
      if (pages[current]) {
        doc.getMap('deletedPages').set(current, { deletedAt: Date.now(), metadata: pages[current] })
        // Keep document content and original metadata available for recovery.
        for (const [child, page] of Object.entries(pages)) if (page.parentId === current) pending.push(child)
      }
    }
  })
}

export function restorePage(doc, id) {
  id = String(id)
  if (!doc.getMap('deletedPages').has(id)) throw new Error('Deleted page not found')
  doc.transact(() => {
    doc.getMap('deletedPages').delete(id)
    doc.getMap('pageFields').set(JSON.stringify([id, 'parentId']), null)
  })
}

export function cloneDocument(update) {
  const doc = new Y.Doc()
  try { Y.applyUpdate(doc, update); return doc } catch (error) { doc.destroy(); throw error }
}
