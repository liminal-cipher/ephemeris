import { useState, useEffect } from 'react'
import * as Y from 'yjs'
import { WebrtcProvider } from 'y-webrtc'
import { IndexeddbPersistence } from 'y-indexeddb'

export function useEditorSync(activePageId) {
  const [ydoc, setYdoc] = useState(null)
  const [provider, setProvider] = useState(null)
  const [isSynced, setIsSynced] = useState(false)

  useEffect(() => {
    setIsSynced(false)
    if (!activePageId) {
      setProvider(null)
      setYdoc(null)
      return
    }

    const doc = new Y.Doc()
    
    // Offline persistence
    const persistence = new IndexeddbPersistence(`ephemeris-page-${activePageId}`, doc)
    
    persistence.on('synced', () => {
      setIsSynced(true)
    })
    
    // P2P sync for the page rich text
    const webrtcProvider = new WebrtcProvider(`ephemeris-room-${activePageId}`, doc, {
      signaling: ['wss://signaling.yjs.dev', 'wss://y-webrtc-signaling-eu.herokuapp.com']
    })

    const colors = ['#958DF1', '#F98181', '#FBCE76', '#8B5CF6', '#3B82F6', '#10B981']
    webrtcProvider.awareness.setLocalStateField('user', {
      name: `User ${Math.floor(Math.random() * 1000)}`,
      color: colors[Math.floor(Math.random() * colors.length)],
    })

    setYdoc(doc)
    setProvider(webrtcProvider)

    return () => {
      webrtcProvider?.destroy()
      doc.destroy()
    }
  }, [activePageId])

  return { ydoc, provider, isSynced }
}
