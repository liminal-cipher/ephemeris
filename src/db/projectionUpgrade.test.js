import { it, expect } from 'vitest'
import Dexie from 'dexie'

it('adds the projection table without rewriting numeric or string legacy rows', async () => {
  const original = new Dexie('ephemeris')
  original.version(1).stores({ pages: '++id, title, parentId, createdAt, updatedAt' })
  const rows = [{ id: 7, title: 'Numeric original', content: 'raw legacy', extra: { retained: true } },
    { id: '7', content: 'pre-existing projection' }]
  await original.pages.bulkPut(rows)
  original.close()
  const { db } = await import('./db')
  try {
    await db.open()
    expect(await db.pages.toArray()).toEqual(rows)
    expect(await db.searchProjection.toArray()).toEqual([])
    await db.searchProjection.put({ id: '7', content: 'new projection' })
    expect(await db.pages.toArray()).toEqual(rows)
  } finally { await db.delete() }
})
