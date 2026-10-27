import { useMemo } from 'react'
import { create } from 'zustand'
import { db } from '../db/db'
import { BrowserVault } from '../storage/browserVault'
import { readPages } from '../storage/workspaceModel'
import { maintainIndex } from '../storage/noteIndex'
import { bootstrapWorkspace } from '../storage/bootstrapWorkspace'

export const vault = new BrowserVault()
export const workspaceDoc = vault.workspace.doc
export const workspacePages = workspaceDoc.getMap('pages')

export const useWorkspaceStore = create(() => ({ pages: {}, isSynced: false, error: null, status: 'loading' }))
const refresh = () => useWorkspaceStore.setState({ pages: readPages(workspaceDoc) })
vault.subscribe(refresh)
vault.workspace.subscribe(({ error, status }) => {
  useWorkspaceStore.setState({ status, error: error?.message || null })
})

export const workspaceReady = vault.ready.then(async () => {
  await bootstrapWorkspace(vault, db)
  refresh()
  useWorkspaceStore.setState({ isSynced: true })
  return vault
})
workspaceReady.catch(error => useWorkspaceStore.setState({ error: error.message }))
workspaceReady.then(() => maintainIndex(vault, db)).catch(() => {})

export const usePagesList = () => {
  const pages = useWorkspaceStore(state => state.pages)
  return useMemo(() => Object.entries(pages).map(([id, page]) => ({ ...page, id })), [pages])
}

export const createWorkspacePage = (parentId = null) => vault.create(parentId)
export const updateWorkspacePage = (id, changes) => vault.update(id, changes)
export const deleteWorkspacePage = id => vault.delete(id)
