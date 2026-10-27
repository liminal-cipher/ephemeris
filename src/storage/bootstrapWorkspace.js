export async function bootstrapWorkspace(vault, database) {
  await vault.ready
  const doc = vault.workspace.doc
  const migrations = doc.getMap('migrations')
  if (migrations.has('dexie-v1')) return
  const hasHistory = doc.store.clients.size > 0
  const pages = await database.pages.toArray()
  doc.transact(() => {
    if (!hasHistory) {
      for (const page of pages) {
        const { id, content: _content, ...metadata } = page
        doc.getMap('pages').set(String(id), { ...metadata, parentId: page.parentId == null ? null : String(page.parentId) })
      }
    }
    migrations.set('dexie-v1', { completedAt: Date.now(), imported: !hasHistory })
  })
  await vault.workspace.flush()
}
