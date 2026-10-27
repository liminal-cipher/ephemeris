import Dexie from 'dexie'
import { it, expect } from 'vitest'
import { migrateLegacy } from './migrateLegacy'

it('retains a single destination note and the source database; retries add no duplicates', async () => {
  const source = new Dexie(`legacy-${crypto.randomUUID()}`)
  const destination = new Dexie(`destination-${crypto.randomUUID()}`)
  for (const database of [source, destination]) database.version(1).stores({ pages: '++id, title, parentId, createdAt, updatedAt' })
  try {
    await source.pages.bulkAdd([{ id: 1, title: 'Parent', content: 'original bytes' }, { id: 2, title: 'Child', parentId: 1 }])
    await destination.pages.add({ id: 1, title: 'Real user note', content: 'Do not clear' })
    await migrateLegacy(destination, source.name)
    await migrateLegacy(destination, source.name)
    expect(await destination.pages.count()).toBe(3)
    expect(await destination.pages.get(1)).toMatchObject({ content: 'Do not clear' })
    expect(await destination.pages.get('notion-2')).toMatchObject({ parentId: 'notion-1' })
    expect(await source.pages.get(1)).toMatchObject({ content: 'original bytes' })
    expect(await Dexie.exists(source.name)).toBe(true)
  } finally {
    await source.delete()
    await destination.delete()
  }
})
