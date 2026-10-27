import { useState, useEffect } from 'react'
import { db } from '../../db/db'
import { vault, workspaceReady } from '../../store/workspace'
import { prepareNote } from '../../storage/noteIndex'
import { connectDocument, useCollaboration } from '../../sync/collaboration'

export function useEditorSync(activePageId) {
  const [state, setState] = useState({ id: null })
  const { enabled, generation } = useCollaboration()

  useEffect(() => {
    if (!activePageId) return
    let cancelled = false
    let unsubscribe
    let document
    async function open() {
      try {
        await workspaceReady
        document = await prepareNote(vault, db, activePageId)
        if (cancelled) return
        const report = () => {
          if (!cancelled) setState(previous => ({ ...previous, id: activePageId, ydoc: document.doc,
            isSynced: true, status: document.status, error: document.error?.message, cacheError: document.cacheError }))
        }
        unsubscribe = document.subscribe(report)
        report()
        // Network setup is independent of loading and editing local content.
        const provider = await connectDocument(activePageId, document)
        if (!cancelled) setState(previous => ({ ...previous, provider }))
      } catch (error) {
        if (!cancelled) setState({ id: activePageId, error: error.message })
      }
    }
    open()
    return () => {
      cancelled = true
      unsubscribe?.()
      // The Vault owns the document for the session, including pending writes.
    }
  }, [activePageId, enabled, generation])

  return state.id === activePageId ? state : { isSynced: false }
}
