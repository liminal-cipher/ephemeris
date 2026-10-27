import { LocalDocument } from './localDocument'
import { createPage, updatePage, deletePage, restorePage, readPages } from './workspaceModel'

// This is the browser storage boundary. It has no React or Tiptap dependency.
// Rich text is accessed as a native Yjs document, not a second writable JSON copy.
export class BrowserVault {
  constructor({ prefix = 'ephemeris', broadcast = true } = {}) {
    this.prefix = prefix
    this.options = { broadcast }
    this.workspace = new LocalDocument(`${prefix}-workspace`, this.options)
    this.documents = new Map()
    this.ready = this.workspace.ready
  }

  list({ includeDeleted = false } = {}) {
    return Object.entries(readPages(this.workspace.doc, includeDeleted)).map(([id, page]) => ({ ...page, id }))
  }

  create(parentId = null, metadata = {}) { return createPage(this.workspace.doc, parentId, metadata) }
  update(id, changes) { updatePage(this.workspace.doc, id, changes) }
  delete(id) { return this.workspace.commit(doc => deletePage(doc, id)) }
  restore(id) { return this.workspace.commit(doc => restorePage(doc, id)) }

  openDocument(id) {
    id = String(id)
    if (!id || id.length > 200 || [...id].some(char => char.charCodeAt(0) < 32 || char === '/' || char === '\\')) throw new Error('Invalid document identifier')
    if (!this.documents.has(id)) this.documents.set(id, new LocalDocument(`${this.prefix}-page-${id}`, this.options))
    return this.documents.get(id)
  }

  subscribe(listener) {
    this.workspace.doc.on('update', listener)
    return () => this.workspace.doc.off('update', listener)
  }

  async flush() {
    await this.workspace.flush()
    await Promise.all([...this.documents.values()].map(document => document.flush()))
  }

  async close() {
    await Promise.all([this.workspace, ...this.documents.values()].map(document => document.close()))
  }
}
