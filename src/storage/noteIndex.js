import { initializeLegacyContent, readContent, validateContent } from './noteContent'

// Rebuildable projection. One observer per open document is owned by the Vault
// session, so navigating away cannot leave search stale or cancel an index write.
export function prepareNote(vault, database, id) {
  id = String(id)
  const document = vault.openDocument(id)
  if (!document.preparation) {
    document.preparation = (async () => {
      const legacy = await database.pages.get(id) || (/^\d+$/.test(id) ? await database.pages.get(Number(id)) : null)
      await initializeLegacyContent(document, legacy)
      const project = () => {
        try {
          const json = readContent(document.doc)
          if (json.content?.length) validateContent(json)
          document.indexPending = database.searchProjection.put({ id, content: JSON.stringify(json), updatedAt: Date.now() })
          document.indexPending.catch(error => { document.cacheError = error.message })
        } catch (error) { document.cacheError = error.message }
      }
      const json = readContent(document.doc)
      if (json.content?.length) validateContent(json)
      document.doc.on('update', project)
      project()
      return document
    })()
  }
  return document.preparation
}

export function maintainIndex(vault, database) {
  const refresh = () => {
    for (const page of vault.list()) {
      prepareNote(vault, database, page.id).catch(error => {
        // Unsupported legacy documents remain preserved and show an error when
        // selected. Do not replace them with a blank projection.
        vault.openDocument(page.id).cacheError = error.message
      })
    }
  }
  const unsubscribe = vault.subscribe(refresh)
  refresh()
  return unsubscribe
}
