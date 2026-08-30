import { usePagesList, useWorkspaceStore, createWorkspacePage } from '../store/workspace'
import { useStore } from '../store/useStore'
import { FileText, Plus, Download, Upload, Search, Network } from 'lucide-react'
import { exportWorkspace, importWorkspace } from '../utils/exportImport'
import { useRef, useState, useEffect } from 'react'
import './Sidebar.css'

export default function Sidebar({ onOpenGraph }) {
  const pages = usePagesList()
  const isSynced = useWorkspaceStore(state => state.isSynced)
  const { activePageId, setActivePageId } = useStore()
  const fileInputRef = useRef(null)
  const [searchQuery, setSearchQuery] = useState('')

  const handleCreateNewPage = (parentId = null) => {
    const id = createWorkspacePage(parentId)
    setActivePageId(id)
  }

  const handleImportClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0]
    if (file) {
      try {
        const count = await importWorkspace(file)
        alert(`Successfully imported ${count} pages.`)
      } catch (err) {
        alert('Failed to import backup file.')
      }
      e.target.value = '' // reset input
    }
  }

  // Set first page active if none selected and synced
  useEffect(() => {
    if (isSynced && pages.length > 0 && !activePageId) {
      setActivePageId(pages[0].id)
    }
  }, [pages.length, activePageId, setActivePageId, isSynced])

  // Build tree for hierarchical rendering
  const buildTree = (pagesList) => {
    const tree = []
    const lookup = {}
    pagesList.forEach(p => lookup[p.id] = { ...p, children: [] })
    pagesList.forEach(p => {
      if (p.parentId && lookup[p.parentId]) {
        lookup[p.parentId].children.push(lookup[p.id])
      } else {
        tree.push(lookup[p.id])
      }
    })
    return tree
  }

  const renderPages = (pagesToRender, depth = 0) => {
    return pagesToRender.map(page => (
      <div key={page.id}>
        <div 
          className={`sidebar-item ${activePageId === page.id ? 'active' : ''}`}
          onClick={() => setActivePageId(page.id)}
          style={{ paddingLeft: `${depth * 1 + 1}rem` }}
        >
          <span className="emoji">{page.emoji || <FileText size={16} />}</span>
          <span className="title">{page.title || 'Untitled'}</span>
          <div className="item-actions">
            <button 
              className="icon-btn-small" 
              onClick={(e) => { e.stopPropagation(); handleCreateNewPage(page.id); }}
              title="Add child page"
            >
              <Plus size={14} />
            </button>
          </div>
        </div>
        {page.children && page.children.length > 0 && renderPages(page.children, depth + 1)}
      </div>
    ))
  }

  const filteredPages = searchQuery 
    ? pages.filter(p => (p.title || 'Untitled').toLowerCase().includes(searchQuery.toLowerCase()))
    : []

  const tree = !searchQuery ? buildTree(pages) : []

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="workspace-name">My Workspace</div>
        <div className="search-bar">
          <Search size={14} style={{ color: 'var(--text-muted)' }} />
          <input 
            type="text" 
            placeholder="Search pages..." 
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>
      </div>
      <div className="sidebar-content">
        {!isSynced ? (
          <div className="empty-state" style={{ padding: '1rem', fontSize: '0.85rem' }}>Loading workspace...</div>
        ) : searchQuery ? (
          filteredPages.length > 0 ? (
            filteredPages.map(page => (
              <div 
                key={page.id} 
                className={`sidebar-item ${activePageId === page.id ? 'active' : ''}`}
                onClick={() => setActivePageId(page.id)}
              >
                <span className="emoji">{page.emoji || <FileText size={16} />}</span>
                <span className="title">{page.title || 'Untitled'}</span>
              </div>
            ))
          ) : (
            <div className="empty-state" style={{ padding: '1rem', fontSize: '0.85rem' }}>No pages found.</div>
          )
        ) : (
          renderPages(tree)
        )}
      </div>
      <div className="sidebar-footer" style={{ flexDirection: 'column', gap: '8px' }}>
        <button className="new-page-btn" onClick={() => handleCreateNewPage(null)}>
          <Plus size={16} />
          New Page
        </button>
        <button className="new-page-btn" onClick={onOpenGraph} style={{ background: 'var(--bg-hover)', color: 'var(--text-primary)' }}>
          <Network size={16} />
          Graph View
        </button>
        <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
          <button className="new-page-btn" onClick={exportWorkspace} style={{ flex: 1 }} title="Export Backup">
            <Download size={16} /> Export
          </button>
          <button className="new-page-btn" onClick={handleImportClick} style={{ flex: 1 }} title="Import Backup">
            <Upload size={16} /> Import
          </button>
        </div>
        <input 
          type="file" 
          accept=".json" 
          ref={fileInputRef} 
          style={{ display: 'none' }} 
          onChange={handleFileChange} 
        />
      </div>
    </div>
  )
}
