import * as Y from 'yjs'
import { readContent, validateContent } from './noteContent'
import { nativeDraftJournal } from './nativeDraftJournal'

const PREFIX = 'ephemeris.native-draft.'
const MAX_DRAFT = 2 * 1024 * 1024
export const decodeDocument = value => Uint8Array.from(atob(value), char => char.charCodeAt(0))
export function encodeDocument(bytes) {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return btoa(binary)
}
const expected = note => ({ version: note.version, contentHash: note.contentHash })
const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const sameContent = (note, change) => note.deleted === null && note.document === change.document && stable(note.metadata) === stable(change.metadata)

export function editableDocument(note) {
  if (note.deleted !== null || note.recovery || note.contentState !== 'native') throw new Error('This note is available for recovery, not rich-text editing.')
  if (note.document.length > MAX_DRAFT / 2) throw new Error('This document exceeds the browser editing recovery limit. Use the native backup tools.')
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, decodeDocument(note.document))
    if (doc.store.pendingStructs || doc.store.pendingDs) throw new Error('Incomplete document')
    for (const key of doc.share.keys()) if (!['default', 'ephemeris', 'attachments'].includes(key)) throw new Error(`Unsupported document root: ${key}`)
    if (doc.getXmlFragment('default')._map.size) throw new Error('Unsupported document attributes')
    const content = readContent(doc)
    if (content.content?.length) validateContent(content)
    return doc
  } catch (error) { doc.destroy(); throw error }
}

export async function retainedDrafts(vaultId, storage = nativeDraftJournal) {
  const drafts = []
  const prefix = `${PREFIX}${vaultId}.`
  const entries = storage.entries ? await storage.entries(prefix) : Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(key => key.startsWith(prefix)).map(key => [key, storage.getItem(key)])
  for (const [key, raw] of entries) {
    if (key.endsWith('.probe')) continue
    if (raw.length > MAX_DRAFT) throw new Error('A retained draft is too large. Export browser data before recovery.')
    const draft = JSON.parse(raw)
    if (draft.format !== 'ephemeris-native-draft' || draft.version !== 1 || draft.vaultId !== vaultId || typeof draft.id !== 'string' || !draft.expected || typeof draft.document !== 'string') throw new Error('Invalid retained draft; original browser storage was retained.')
    drafts.push({ ...draft, key })
  }
  return drafts.sort((a, b) => b.updatedAt - a.updatedAt)
}

// A durable pending write, not a second canonical Vault. Credentials never enter
// this journal. Each editor owns a unique key so competing tabs retain both drafts.
export class NativeDocument {
  constructor(client, vaultId, note, { storage = nativeDraftJournal, draft } = {}) {
    this.client = client; this.vaultId = vaultId; this.storage = storage
    this.id = note.id; this.base = draft?.expected || expected(note)
    this.metadata = structuredClone(draft?.metadata || note.metadata)
    this.doc = editableDocument(draft ? { ...note, document: draft.document } : note)
    this.key = draft?.key || `${PREFIX}${vaultId}.${crypto.randomUUID()}`
    this.listeners = new Set(); this.revision = 0; this.dirty = Boolean(draft); this.sent = draft?.sent || null
    this.status = 'initialising'; this.error = ''; this.closed = false
    this.onUpdate = () => this.changed()
    this.doc.on('update', this.onUpdate)
    // Probe storage before allowing edits, without persisting a note copy.
    const probe = `${this.key}.probe`
    this.journal = Promise.resolve().then(() => storage.setItem(probe, '1')).then(() => storage.removeItem(probe))
    this.ready = this.journal.then(async () => {
      if (draft) { this.status = 'retained'; await this.checkRemote(note) }
      else if (!this.dirty) this.status = 'saved'
      this.emit()
    }).catch(error => this.storageFailure(error))
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  emit() { if (!this.closed) this.listeners.forEach(listener => listener(this)) }
  snapshot() { return { id: this.id, expected: this.base, metadata: this.metadata, document: encodeDocument(Y.encodeStateAsUpdate(this.doc)) } }
  storageFailure(error) { this.status = 'storage-error'; this.error = error.message; this.emit() }
  enqueue(operation) {
    this.journal = this.journal.then(operation)
    this.journal.catch(error => this.storageFailure(error))
    return this.journal
  }
  persist() {
    const record = { format: 'ephemeris-native-draft', version: 1, vaultId: this.vaultId, ...this.snapshot(), sent: this.sent, updatedAt: Date.now() }
    const raw = JSON.stringify(record)
    if (raw.length > MAX_DRAFT) throw new Error('Draft recovery limit reached. Download this draft before continuing.')
    return this.enqueue(() => this.storage.setItem(this.key, raw))
  }
  changed() {
    this.revision++; this.dirty = true
    try {
      const revision = this.revision, writing = this.persist()
      if (this.status !== 'conflict') { this.status = 'journaling'; this.error = '' }
      writing.then(() => {
        if (revision === this.revision && !['conflict', 'storage-error', 'saving'].includes(this.status)) {
          this.status = 'queued'; clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 500); this.emit()
        }
      }).catch(() => {})
    } catch (error) { this.storageFailure(error) }
    this.emit()
  }
  setMetadata(fields) { this.metadata = { ...this.metadata, ...fields }; this.changed() }
  setComposing(value) { this.composing = value; if (!value) setTimeout(() => this.flush(), 0) }
  markExported() { this.exportedRevision = this.revision }
  async checkRemote(note) {
    if (note.version === this.base.version && note.contentHash === this.base.contentHash && note.deleted === null) return true
    if (this.sent && note.version === this.sent.expected.version + 1 && sameContent(note, this.sent)) {
      this.base = expected(note); this.sent = null
      const revision = this.revision
      if (sameContent(note, this.snapshot())) {
        await this.enqueue(() => this.storage.removeItem(this.key))
        if (revision === this.revision) { this.dirty = false; this.status = 'saved' }
      } else await this.persist()
      return true
    }
    this.remote = note; this.status = 'conflict'; this.error = 'The saved note changed. Your draft is retained; review both versions.'; this.emit()
    return false
  }
  async flush() {
    clearTimeout(this.timer)
    if (this.inFlight) return this.inFlight
    this.inFlight = (async () => {
      await this.ready
      try { await this.journal } catch { return false }
      if (!this.dirty || this.status === 'conflict' || this.status === 'storage-error' || this.closed || this.composing) return !this.dirty
      return this.save()
    })()
    try { return await this.inFlight } finally { this.inFlight = null }
  }
  async save() {
    try {
      // Resolve an ambiguous acknowledgement before attempting another CAS write.
      if (this.sent || this.status === 'retained' || this.status === 'offline') {
        if (!(await this.checkRemote(await this.client.get('note', { id: this.id })))) return false
      }
      while (this.dirty && !this.closed) {
        const revision = this.revision
        this.sent = structuredClone(this.snapshot()); await this.persist()
        this.status = 'saving'; this.error = ''; this.emit()
        const saved = await this.client.write('update', this.sent)
        this.base = expected(saved); this.sent = null
        if (revision === this.revision) {
          await this.enqueue(() => this.storage.removeItem(this.key))
          if (revision === this.revision) { this.dirty = false; this.status = 'saved' }
        } else await this.persist()
        this.emit()
      }
      return !this.dirty
    } catch (error) {
      if (this.status === 'storage-error') return false
      this.status = error.status === 409 ? 'conflict' : error.status === 400 || error.status === 413 ? 'error' : 'offline'
      this.error = error.status === 409 ? 'The saved note changed. Your draft is retained; review both versions.' : 'Not saved to the Vault. Your retained draft can be retried after reconnecting.'
      this.emit(); return false
    }
  }
  dispose() { this.closed = true; clearTimeout(this.timer); this.doc.off('update', this.onUpdate); this.doc.destroy(); this.listeners.clear() }
}
