import { useEffect, useRef, useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { useStore } from '../store/useStore'
import { usePagesList, deleteWorkspacePage } from '../store/workspace'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCursor from '@tiptap/extension-collaboration-cursor'
import Mention from '@tiptap/extension-mention'
import Underline from '@tiptap/extension-underline'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { lowlight } from 'lowlight'
import MathExtension from '@aarkue/tiptap-math-extension'
import slashCommand from './editor/slashExtension'
import TrimSelectionExtension from './editor/trimSelectionExtension'
import { Menu, Trash2 } from 'lucide-react'
import suggestion from './editor/suggestion'
import slashSuggestion from './editor/slashSuggestion'
import 'katex/dist/katex.min.css'
import './PageEditor.css'

import { useEditorSync } from './editor/useEditorSync'
import PageHeader from './editor/PageHeader'
import BacklinksPanel from './editor/BacklinksPanel'
import EditorToolbar from './editor/EditorToolbar'
import SubPagesPanel from './editor/SubPagesPanel'

import PageIcon from './common/PageIcon'

export default function PageEditor({ onToggleSidebar, sidebarOpen }) {
  const { activePageId, setActivePageId } = useStore()
  const allPages = usePagesList()
  
  const page = useMemo(() => {
    return allPages ? allPages.find(p => p.id === activePageId) : null
  }, [allPages, activePageId])

  // Compute hierarchical breadcrumbs chain
  const breadcrumbs = useMemo(() => {
    if (!page || !allPages) return []
    const trail = []
    let curr = page
    while (curr) {
      trail.unshift(curr)
      curr = curr.parentId ? allPages.find(p => p.id === curr.parentId) : null
    }
    return trail
  }, [page, allPages])

  // Get content from Dexie for legacy fallback and backlinks
  const dexiePages = useLiveQuery(() => db.pages.toArray(), [])

  const titleInputRef = useRef(null)
  const editorTimeoutRef = useRef(null)

  const { ydoc, provider, isSynced } = useEditorSync(activePageId)

  useEffect(() => {
    if (page && (page.title === '' || !page.title) && titleInputRef.current) {
      setTimeout(() => titleInputRef.current?.focus(), 50)
    }
  }, [activePageId, page?.title])

  const baseExtensions = [
    StarterKit.configure({
      history: false,
      codeBlock: false, // disable default codeBlock to use lowlight
    }),
    Underline,
    CodeBlockLowlight.configure({
      lowlight,
    }),
    MathExtension.configure({
      evaluation: true,
    }),
    Mention.configure({
      HTMLAttributes: {
        class: 'wiki-link',
      },
      suggestion,
    }),
    slashCommand.configure({
      suggestion: slashSuggestion,
    }),
    TrimSelectionExtension
  ];

  const editor = useEditor({
    extensions: ydoc ? [
      ...baseExtensions,
      Collaboration.configure({
        document: ydoc,
      }),
      ...(provider ? [
        CollaborationCursor.configure({
          provider: provider,
          user: {
            name: 'Anonymous User',
            color: '#ffcc00',
          },
        })
      ] : [])
    ] : baseExtensions,
  }, [ydoc, provider])

  // Auto-save plain content to Dexie for backlinks and offline fallback
  useEffect(() => {
    if (ydoc && provider) {
      const fragment = ydoc.getXmlFragment('default')
      fragment.observeDeep(() => {
        if (editorTimeoutRef.current) {
          clearTimeout(editorTimeoutRef.current)
        }
        editorTimeoutRef.current = setTimeout(async () => {
          if (editor && activePageId) {
            const json = editor.getJSON()
            const content = JSON.stringify(json)
            const numUpdated = await db.pages.update(activePageId, {
              content,
              updatedAt: Date.now()
            })
            if (numUpdated === 0) {
              await db.pages.add({ id: activePageId, content, updatedAt: Date.now() })
            }
          }
        }, 500)
      })

      return () => {
        if (editorTimeoutRef.current) {
          clearTimeout(editorTimeoutRef.current)
        }
      }
    }
  }, [ydoc, provider, editor, activePageId])

  const migratedPageIdsRef = useRef(new Set())

  useEffect(() => {
    if (page && editor && ydoc && isSynced) {
      if (migratedPageIdsRef.current.has(activePageId)) {
        return
      }

      const dexiePage = dexiePages?.find(p => p.id === activePageId || p.id === Number(activePageId))
      if (dexiePage && dexiePage.content) {
        const fragment = ydoc.getXmlFragment('default')
        if (fragment.length === 0) {
          try {
            const parsed = JSON.parse(dexiePage.content)
            const hasMeaningfulContent = parsed && Array.isArray(parsed.content) && parsed.content.some(block => {
              if (block.type !== 'paragraph') return true
              return Array.isArray(block.content) && block.content.length > 0
            })

            if (hasMeaningfulContent) {
              editor.commands.setContent(parsed, false)
            }
            migratedPageIdsRef.current.add(activePageId)
          } catch (e) {
            console.error('Failed to parse legacy page content:', e)
          }
        } else {
          migratedPageIdsRef.current.add(activePageId)
        }
      }
    }
  }, [page, editor, ydoc, isSynced, dexiePages, activePageId])

  const handleDeletePage = () => {
    if (window.confirm('Are you sure you want to delete this page?')) {
      deleteWorkspacePage(activePageId)
      setActivePageId(null)
    }
  }

  // Handle editor click for wiki-links
  const handleEditorClick = (e) => {
    const target = e.target;
    if (target.classList.contains('wiki-link')) {
      const id = target.getAttribute('data-id');
      if (id) {
        setActivePageId(id);
      }
    }
  };

  if (!page || !editor) {
    return <div className="empty-state">Select or create a page</div>
  }

  return (
    <div className="page-editor-wrapper">
      <div className="top-nav" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
          {!sidebarOpen && (
            <button className="icon-btn" onClick={onToggleSidebar} aria-label="Open sidebar" aria-expanded={sidebarOpen}>
              <Menu size={20} aria-hidden="true" />
            </button>
          )}
          <nav className="breadcrumbs" aria-label="Breadcrumb hierarchy">
            {breadcrumbs.map((crumb, idx) => (
              <span key={crumb.id} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                {idx > 0 && <span className="breadcrumb-separator" aria-hidden="true">/</span>}
                <button
                  className={`breadcrumb-item ${crumb.id === page.id ? 'is-current' : ''}`}
                  onClick={() => setActivePageId(crumb.id)}
                  aria-current={crumb.id === page.id ? 'page' : undefined}
                >
                  {crumb.emoji && <PageIcon icon={crumb.emoji} size={14} className="breadcrumb-emoji" />}
                  <span className="breadcrumb-text">{crumb.title || 'Untitled'}</span>
                </button>
              </span>
            ))}
          </nav>
        </div>
        <button className="icon-btn" onClick={handleDeletePage} title="Delete Page" style={{ color: 'var(--text-secondary)' }} aria-label="Delete Page">
          <Trash2 size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="editor-container">
        <div className="page-content">
          <PageHeader 
            activePageId={activePageId}
            title={page.title || ''}
            emoji={page.emoji || ''}
            coverImage={page.coverImage || ''}
            titleInputRef={titleInputRef}
            editor={editor}
          />

          <div onClick={handleEditorClick} role="textbox" aria-label="Rich text editor">
            <EditorToolbar editor={editor} />
            <EditorContent editor={editor} className="tiptap-editor" />
          </div>
          
          <SubPagesPanel 
            activePageId={activePageId} 
            allPages={allPages} 
            setActivePageId={setActivePageId} 
          />

          <BacklinksPanel 
            dexiePages={dexiePages} 
            allPages={allPages} 
            activePageId={activePageId} 
            setActivePageId={setActivePageId} 
          />
        </div>
      </div>
    </div>
  )
}
