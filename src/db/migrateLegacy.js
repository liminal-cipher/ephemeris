import Dexie from 'dexie'

export async function migrateLegacy(destination, sourceName = 'NotionCloneDB') {
  if (!(await Dexie.exists(sourceName))) return
  const source = new Dexie(sourceName)
  source.version(1).stores({ pages: '++id, title, parentId, createdAt, updatedAt' })
  try {
    await source.open()
    const pages = await source.pages.toArray()
    await destination.transaction('rw', destination.pages, async () => {
      for (const page of pages) {
        const id = `notion-${page.id}`
        if (!(await destination.pages.get(id))) {
          await destination.pages.add({ ...page, id,
            parentId: page.parentId == null ? null : `notion-${page.parentId}`,
            legacySource: 'NotionCloneDB', legacyId: page.id })
        }
      }
    })
  } finally { source.close() }
}
