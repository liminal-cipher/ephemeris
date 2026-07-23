import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { useStore } from '../store/useStore'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Image as ImageIcon, Smile, Menu } from 'lucide-react'
import './PageEditor.css'

export default function PageEditor({ onToggleSidebar, sidebarOpen }) {
  const { activePageId } = useStore()
  
  const page = useLiveQuery(
    () => activePageId ? db.pages.get(activePageId) : null,
    [activePageId]
  )

  const [title, setTitle] = useState('')
  const [emoji, setEmoji] = useState('')
  const [coverImage, setCoverImage] = useState('')

  const editor = useEditor({
    extensions: [StarterKit],
    content: '',
    onUpdate: ({ editor }) => {
      if (activePageId) {
        db.pages.update(activePageId, { 
          content: JSON.stringify(editor.getJSON()),
          updatedAt: Date.now()
        })
      }
    }
  })

  useEffect(() => {
    if (page) {
      setTitle(page.title || '')
      setEmoji(page.emoji || '')
      setCoverImage(page.coverImage || '')
      if (editor && page.content) {
        const currentContent = JSON.stringify(editor.getJSON())
        if (currentContent !== page.content) {
          try {
            editor.commands.setContent(JSON.parse(page.content))
          } catch(e) {
            editor.commands.setContent(page.content)
          }
        }
      } else if (editor && !page.content) {
        editor.commands.setContent('')
      }
    }
  }, [page, editor])

  const updatePage = (changes) => {
    if (activePageId) {
      db.pages.update(activePageId, { ...changes, updatedAt: Date.now() })
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

  if (!page) {
    return <div className="empty-state">Select or create a page</div>
  }

  return (
    <div className="page-editor-wrapper">
      <div className="top-nav">
        {!sidebarOpen && (
          <button className="icon-btn" onClick={onToggleSidebar}>
            <Menu size={20} />
          </button>
        )}
        <div className="breadcrumbs">{page.title || 'Untitled'}</div>
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
                <button className="page-action-btn" onClick={() => updatePage({ emoji: '📄' })}>
                  <Smile size={16} /> Add icon
                </button>
              )}
            </div>
          )}

          <div className="page-header">
            {emoji && (
              <div className="page-emoji" onClick={() => {
                const newEmoji = prompt("Enter an emoji:", emoji);
                if (newEmoji) updatePage({ emoji: newEmoji })
              }}>
                {emoji}
              </div>
            )}
            <input 
              className="page-title-input" 
              value={title} 
              onChange={(e) => {
                setTitle(e.target.value)
                updatePage({ title: e.target.value })
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
