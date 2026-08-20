import Dexie from 'dexie';

export const db = new Dexie('ephemeris');

db.version(1).stores({
  pages: '++id, title, parentId, createdAt, updatedAt' // Only index fields we query by
});

db.on('ready', async () => {
  try {
    const oldDbExists = await Dexie.exists('NotionCloneDB');
    if (oldDbExists) {
      const oldDb = new Dexie('NotionCloneDB');
      oldDb.version(1).stores({ pages: '++id, title, parentId, createdAt, updatedAt' });
      await oldDb.open();
      
      const oldPages = await oldDb.pages.toArray();
      if (oldPages.length > 0) {
        const currentPages = await db.pages.toArray();
        if (currentPages.length <= 1) {
          await db.pages.clear(); // Clear the default welcome page
          await db.pages.bulkAdd(oldPages);
          console.log(`Migrated ${oldPages.length} pages from NotionCloneDB.`);
          await oldDb.close();
          await Dexie.delete('NotionCloneDB');
        } else {
          oldDb.close();
        }
      } else {
        oldDb.close();
      }
    }
  } catch (error) {
    console.error("Migration failed:", error);
  }
});

// Seed initial page if empty
db.on('populate', () => {
  db.pages.add({
    title: 'Welcome to your Workspace',
    emoji: '👋',
    coverImage: '',
    content: JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'Welcome to your Workspace 👋' }]
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'This is a local-first Notion clone built with React, Vite, Dexie, and Tiptap.' }]
        }
      ]
    }),
    parentId: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
});
