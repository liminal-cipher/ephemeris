import Dexie from 'dexie';

export const db = new Dexie('NotionCloneDB');

db.version(1).stores({
  pages: '++id, title, parentId, createdAt, updatedAt' // Only index fields we query by
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
