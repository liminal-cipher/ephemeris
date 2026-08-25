import { useEffect, useState, useRef } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { useStore } from '../store/useStore'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCursor from '@tiptap/extension-collaboration-cursor'
import * as Y from 'yjs'
import { WebrtcProvider } from 'y-webrtc'
import { IndexeddbPersistence } from 'y-indexeddb'
import { Image as ImageIcon, Smile, Menu, Trash2 } from 'lucide-react'
import './PageEditor.css'

export default function PageEditor({ onToggleSidebar, sidebarOpen }) {
  const { activePageId, setActivePageId } = useStore()
  
  const page = useLiveQuery(
    () => activePageId ? db.pages.get(activePageId) : null,
    [activePageId]
  )

  const [title, setTitle] = useState('')
  const [emoji, setEmoji] = useState('')
  const [coverImage, setCoverImage] = useState('')
  const titleInputRef = useRef(null)
  const editorTimeoutRef = useRef(null)

  const [ydoc, setYdoc] = useState(null)
  const [provider, setProvider] = useState(null)
  const [isSynced, setIsSynced] = useState(false)

  useEffect(() => {
    if (page && (page.title === '' || !page.title) && titleInputRef.current) {
      setTimeout(() => titleInputRef.current?.focus(), 50)
    }
  }, [activePageId, page?.title])

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
    
    // P2P sync
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
      webrtcProvider.destroy()
      doc.destroy()
    }
  }, [activePageId])

  const editor = useEditor({
    extensions: ydoc && provider ? [
      StarterKit.configure({
        history: false,
      }),
      Collaboration.configure({
        document: ydoc,
      }),
      CollaborationCursor.configure({
        provider: provider,
        user: provider.awareness.getLocalState().user,
      })
    ] : [],
    onUpdate: ({ editor }) => {
      if (activePageId) {
        if (editorTimeoutRef.current) {
          clearTimeout(editorTimeoutRef.current)
        }
        // Snapshot to Dexie for GraphView and local search
        const content = JSON.stringify(editor.getJSON())
        editorTimeoutRef.current = setTimeout(() => {
          db.pages.update(activePageId, { 
            content: content,
            updatedAt: Date.now()
          })
        }, 500)
      }
    }
  }, [ydoc, provider])

  useEffect(() => {
    if (page) {
      setTitle(page.title || '')
      setEmoji(page.emoji || '')
      setCoverImage(page.coverImage || '')
      
      // Legacy data migration: If Yjs doc is empty but Dexie has content
      if (editor && ydoc && isSynced && page.content) {
        const fragment = ydoc.getXmlFragment('default')
        if (fragment.length === 0) {
          try {
            const parsed = JSON.parse(page.content)
            if (parsed && parsed.content && parsed.content.length > 0) {
              editor.commands.setContent(parsed)
            }
          } catch(e) {
             editor.commands.setContent(page.content)
          }
        }
      }
    }
  }, [page, editor, ydoc])

  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const EMOJI_LIST = ['📄', '💡', '📝', '🚀', '⭐️', '📌', '📚', '🛠️', '👋', '🎯', '✨', '🔥']

  const updatePage = (changes) => {
    if (activePageId) {
      db.pages.update(activePageId, { ...changes, updatedAt: Date.now() })
    }
  }

  const handleDeletePage = async () => {
    if (window.confirm('Are you sure you want to delete this page?')) {
      await db.pages.delete(activePageId)
      setActivePageId(null)
    }
  }

  const handleCoverUpload = (e) => {
    const file = e.target.files[0]
    if (file) {
      const reader = new FileReader()
      reader.onloadend = () => {
        const base64 = reader.result
        updatePage({ coverImage: base64 })
      }
      reader.readAsDataURL(file)
    }
  }

  if (!page || !editor) {
    return <div className="empty-state">Select or create a page</div>
  }

  return (
    <div className="page-editor-wrapper">
      <div className="top-nav" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {!sidebarOpen && (
            <button className="icon-btn" onClick={onToggleSidebar}>
              <Menu size={20} />
            </button>
          )}
          <div className="breadcrumbs">{page.title || 'Untitled'}</div>
        </div>
        <button className="icon-btn" onClick={handleDeletePage} title="Delete Page" style={{ color: 'var(--text-secondary)' }}>
          <Trash2 size={16} />
        </button>
      </div>

      <div className="editor-container">
        {coverImage && (
          <div className="cover-image-container">
            <img src={coverImage} alt="Cover" className="cover-image" />
            <button className="change-cover-btn" onClick={() => updatePage({coverImage: ''})}>Remove Cover</button>
          </div>
        )}
        
        <div className="page-content">
          {!coverImage && (
            <div className="page-actions-top">
              <label className="page-action-btn">
                <ImageIcon size={16} /> Add cover
                <input type="file" accept="image/*" hidden onChange={handleCoverUpload} />
              </label>
              {!emoji && (
                <button className="page-action-btn" onClick={() => setShowEmojiPicker(true)}>
                  <Smile size={16} /> Add icon
                </button>
              )}
            </div>
          )}

          <div className="page-header" style={{ position: 'relative' }}>
            {emoji && (
              <div className="page-emoji" onClick={() => setShowEmojiPicker(!showEmojiPicker)}>
                {emoji}
              </div>
            )}
            {showEmojiPicker && (
              <div className="emoji-picker-popover">
                <div className="emoji-grid">
                  {EMOJI_LIST.map(em => (
                    <button key={em} className="emoji-btn" onClick={() => { updatePage({ emoji: em }); setShowEmojiPicker(false); }}>
                      {em}
                    </button>
                  ))}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '8px', borderTop: '1px solid var(--border-color)', paddingTop: '8px' }}>
                  <button className="emoji-picker-action" onClick={() => { updatePage({ emoji: '' }); setShowEmojiPicker(false); }}>Remove</button>
                  <button className="emoji-picker-action" onClick={() => setShowEmojiPicker(false)}>Close</button>
                </div>
              </div>
            )}
            <input 
              ref={titleInputRef}
              className="page-title-input" 
              value={title} 
              onChange={(e) => {
                setTitle(e.target.value)
                updatePage({ title: e.target.value })
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (editor) {
                    editor.commands.focus()
                  }
                }
              }}
              placeholder="Untitled"
            />
          </div>

          <EditorContent editor={editor} className="tiptap-editor" />
        </div>
      </div>
    </div>
  )
}
