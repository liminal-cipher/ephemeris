import { parseBackup } from '../src/storage/backupFormat.js'
import { NativeVault } from './vault.js'
import * as Y from 'yjs'
import { identifier, jsonValue, metadata, nativeUpdate } from './validation.js'

export async function validateImport(text) {
  // Shared validation preserves the browser backup contract without importing
  // React, Tiptap, IndexedDB or a lossy rich-text codec.
  const parsed = await parseBackup(text)
  const envelope = JSON.parse(text)
  if (envelope.version !== 2 || envelope.format !== 'ephemeris-workspace') throw new Error('Native import requires a version 2 backup')
  jsonValue(envelope)
  const ids = new Set(parsed.documents.map(entry => identifier(entry.id)))
  const workspace = new Y.Doc()
  try {
    Y.applyUpdate(workspace, Buffer.from(envelope.payload.workspace, 'base64'))
    for (const id of workspace.getMap('recoveryDocuments').keys()) {
      if (!ids.has(id)) throw new Error('Backup is missing a recovery document')
    }
  } finally { workspace.destroy() }
  for (const [id, tombstone] of Object.entries(parsed.deleted)) {
    if (!ids.has(id) || !parsed.pages[id] || !tombstone || typeof tombstone !== 'object' || Array.isArray(tombstone)) throw new Error('Invalid deletion record')
  }
  const notes = parsed.documents.map(entry => {
    const fields = parsed.pages[entry.id] || { title: '', parentId: null }
    metadata(fields)
    const legacyRecords = parsed.legacy.filter(row => String(row.id) === entry.id)
    const doc = new Y.Doc()
    let contentState
    try {
      Y.applyUpdate(doc, entry.update)
      const state = doc.getMap('ephemeris')
      const pendingLegacy = state.has('legacyRecord') && !state.has('initialized') && !doc.getXmlFragment('default').length
      contentState = pendingLegacy || (!doc.store.clients.size && legacyRecords.some(row => row.content)) ? 'legacy-only' : 'native'
    } finally { doc.destroy() }
    return { id: entry.id, metadata: fields, document: nativeUpdate(entry.update),
      deleted: parsed.deleted[entry.id] ?? null, recovery: !Object.hasOwn(parsed.pages, entry.id), legacyRecords, contentState }
  })
  return { notes, sha256: envelope.sha256 }
}

export async function importBackupToVault(directory, text) {
  await validateImport(text) // Do not create a destination for invalid input.
  const vault = NativeVault.create(directory)
  try {
    const result = await vault.importBackup(text)
    return { vault, ...result }
  } catch (error) {
    // A failed import leaves an empty reusable Vault, never partial notes.
    // Do not delete files here: retain evidence of I/O failures for recovery.
    vault.close()
    throw error
  }
}
