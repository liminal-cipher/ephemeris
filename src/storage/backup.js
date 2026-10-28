import * as Y from 'yjs'
import { parseBackup } from './backupFormat.js'
import { remapLinks } from './noteContent'
export { createBackup, parseBackup, PRESENTATION_KEYS } from './backupFormat.js'

function remapXml(node, mapping) {
  if (node instanceof Y.XmlElement) {
    const id = node.getAttribute('id')
    if (mapping.has(String(id))) node.setAttribute('id', mapping.get(String(id)))
  }
  if (node instanceof Y.XmlFragment) node.toArray().forEach(child => remapXml(child, mapping))
}

export async function restoreBackup(vault, text) {
  const backup = await parseBackup(text) // Validate everything before any write.
  await vault.ready
  const mapping = new Map(backup.documents.map(({ id }) => [id, crypto.randomUUID()]))
  const batchId = crypto.randomUUID()
  // Stage native documents first. A crash cannot overwrite or expose a partial
  // note. Failed staging may leave unreachable databases, retained for recovery.
  for (const entry of backup.documents) {
    const document = vault.openDocument(mapping.get(entry.id))
    await document.ready
    Y.applyUpdate(document.doc, entry.update)
    const hadNativeHistory = document.doc.store.clients.size > 0
    remapXml(document.doc.getXmlFragment('default'), mapping)
    const row = backup.legacy.find(page => String(page.id) === entry.id)
    if (row) {
      const imported = { ...row, id: mapping.get(entry.id) }
      if (row.content) {
        try { imported.content = JSON.stringify(remapLinks(JSON.parse(row.content), mapping)) } catch { /* Raw legacy text remains recoverable. */ }
      }
      document.doc.getMap('ephemeris').set('legacyRecord', imported)
      // A historically empty Yjs document is authoritative. Its stale Dexie
      // projection must not become a new legacy seed after restoration.
      if (hadNativeHistory) document.doc.getMap('ephemeris').set('initialized', true)
    }
    await document.flush()
  }
  await vault.workspace.commit(workspace => {
    for (const [oldId, page] of Object.entries(backup.pages)) {
      const id = mapping.get(oldId)
      workspace.getMap('pages').set(id, { ...page,
        parentId: page.parentId == null ? null : mapping.get(page.parentId),
        importedAt: Date.now(), importBatch: batchId,
      })
      if (backup.deleted[oldId]) workspace.getMap('deletedPages').set(id, { ...backup.deleted[oldId], originalId: oldId })
    }
    for (const [oldId, id] of mapping) if (!backup.pages[oldId]) workspace.getMap('recoveryDocuments').set(id, { originalId: oldId, importBatch: batchId })
    workspace.getMap('importArchives').set(batchId, {
      workspace: backup.originalWorkspace || null, legacy: backup.legacy,
      settings: backup.settings, mapping: Object.fromEntries(mapping),
    })
  })
  return { count: Object.keys(backup.pages).filter(id => !backup.deleted[id]).length, mapping, settings: backup.settings }
}
