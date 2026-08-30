import React, { useMemo } from 'react'
import * as Y from 'yjs'
import { WebrtcProvider } from 'y-webrtc'
import { IndexeddbPersistence } from 'y-indexeddb'
import { create } from 'zustand'
import { db } from '../db/db'

export const workspaceDoc = new Y.Doc()
export const workspacePages = workspaceDoc.getMap('pages')

// Local persistence for the workspace
export const workspacePersistence = new IndexeddbPersistence('ephemeris-workspace', workspaceDoc)

// WebRTC sync
export const workspaceProvider = new WebrtcProvider('ephemeris-workspace-room', workspaceDoc, {
  signaling: ['wss://signaling.yjs.dev', 'wss://y-webrtc-signaling-eu.herokuapp.com']
})

export const useWorkspaceStore = create((set) => ({
  pages: {},
  isSynced: false,
  setPages: (pages) => set({ pages }),
  setIsSynced: (isSynced) => set({ isSynced })
}))

// Custom hook to reactively subscribe to the list of pages
export const usePagesList = () => {
  const pagesObj = useWorkspaceStore(state => state.pages)
  return useMemo(() => {
    return Object.keys(pagesObj || {}).map(id => ({
      id,
      ...pagesObj[id]
    }))
  }, [pagesObj])
}

// Observe changes and update React state
workspacePages.observe(() => {
  useWorkspaceStore.getState().setPages(workspacePages.toJSON())
})

workspacePersistence.on('synced', async () => {
  useWorkspaceStore.getState().setIsSynced(true)
  useWorkspaceStore.getState().setPages(workspacePages.toJSON())

  // Migration from Dexie to Yjs (run once if Yjs is empty)
  if (Array.from(workspacePages.keys()).length === 0) {
    try {
      const dexiePages = await db.pages.toArray()
      if (dexiePages.length > 0) {
        workspaceDoc.transact(() => {
          dexiePages.forEach(page => {
            const pageId = page.id.toString()
            workspacePages.set(pageId, {
              title: page.title || '',
              emoji: page.emoji || '',
              coverImage: page.coverImage || '',
              parentId: page.parentId ? page.parentId.toString() : null,
              createdAt: page.createdAt,
              updatedAt: page.updatedAt
            })
          })
        })
        console.log(`Migrated ${dexiePages.length} pages to Y.Map workspace`)
      }
    } catch (e) {
      console.error('Failed to migrate Dexie pages to Yjs', e)
    }
  }
})

// Helper functions to mutate workspace pages
export const createWorkspacePage = (parentId = null) => {
  const id = crypto.randomUUID()
  workspacePages.set(id, {
    title: '',
    emoji: '',
    coverImage: '',
    parentId,
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  return id
}

export const updateWorkspacePage = (id, changes) => {
  const existing = workspacePages.get(id.toString())
  if (existing) {
    workspacePages.set(id.toString(), {
      ...existing,
      ...changes,
      updatedAt: Date.now()
    })
  }
}

export const deleteWorkspacePage = (id) => {
  workspacePages.delete(id.toString())
  
  // Cascade delete children
  const keys = Array.from(workspacePages.keys())
  keys.forEach(key => {
    const page = workspacePages.get(key)
    if (page && page.parentId === id.toString()) {
      deleteWorkspacePage(key)
    }
  })
}
