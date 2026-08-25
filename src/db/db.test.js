import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { db } from './db';

describe('Database (Dexie)', () => {
  beforeEach(async () => {
    // Clear all pages before each test
    await db.pages.clear();
  });

  afterAll(async () => {
    await db.delete(); // cleanup fake indexeddb
  })

  it('should add and retrieve a page', async () => {
    const id = await db.pages.add({
      title: 'Test Page',
      parentId: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    
    expect(id).toBeDefined();
    
    const page = await db.pages.get(id);
    expect(page.title).toBe('Test Page');
  });

  it('should correctly query pages by parentId', async () => {
    const parentId = await db.pages.add({
      title: 'Parent',
      parentId: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    await db.pages.add({
      title: 'Child',
      parentId: parentId,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    const children = await db.pages.where('parentId').equals(parentId).toArray();
    expect(children.length).toBe(1);
    expect(children[0].title).toBe('Child');
  });
});
