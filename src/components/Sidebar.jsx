import { usePagesList, useWorkspaceStore, createWorkspacePage, deleteWorkspacePage } from '../store/workspace'
import { useStore } from '../store/useStore'
import { FileText, Plus, Download, Upload, Search, Network, Trash2, X } from 'lucide-react'
import { exportWorkspace, importWorkspace } from '../utils/exportImport'
import { useRef, useState, useEffect } from 'react'
import './Sidebar.css'

export default function Sidebar({ onOpenGraph }) {
  const pages = usePagesList()
  const isSynced = useWorkspaceStore(state => state.isSynced)
  const { activePageId, setActivePageId } = useStore()
  const fileInputRef = useRef(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedPageIds, setSelectedPageIds] = useState([])
  const [lastSelectedId, setLastSelectedId] = useState(null)

  const handleCreateNewPage = (parentId = null) => {
    const id = createWorkspacePage(parentId)
    setActivePageId(id)
    setSelectedPageIds([id])
    setLastSelectedId(id)
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
      setSelectedPageIds([pages[0].id])
      setLastSelectedId(pages[0].id)
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

  // Get flattened visible order for Shift-click selection range
  const getVisibleIds = (treeNodes) => {
    const ids = []
    const traverse = (nodes) => {
      nodes.forEach(node => {
        ids.push(node.id)
        if (node.children && node.children.length > 0) {
          traverse(node.children)
        }
      })
    }
    traverse(treeNodes)
    return ids
  }

  const filteredPages = searchQuery 
    ? pages.filter(p => (p.title || 'Untitled').toLowerCase().includes(searchQuery.toLowerCase()))
    : []

  const tree = !searchQuery ? buildTree(pages) : []

  // Multi-selection click handler with Shift / Ctrl support
  const handleItemClick = (pageId, e) => {
    const visibleIds = searchQuery ? filteredPages.map(p => p.id) : getVisibleIds(tree)

    if (e.shiftKey && lastSelectedId) {
      const idx1 = visibleIds.indexOf(lastSelectedId)
      const idx2 = visibleIds.indexOf(pageId)
      if (idx1 !== -1 && idx2 !== -1) {
        const start = Math.min(idx1, idx2)
        const end = Math.max(idx1, idx2)
        const rangeIds = visibleIds.slice(start, end + 1)
        setSelectedPageIds(Array.from(new Set([...selectedPageIds, ...rangeIds])))
      } else {
        setSelectedPageIds([pageId])
      }
    } else if (e.ctrlKey || e.metaKey) {
      if (selectedPageIds.includes(pageId)) {
        setSelectedPageIds(selectedPageIds.filter(id => id !== pageId))
      } else {
        setSelectedPageIds([...selectedPageIds, pageId])
      }
      setLastSelectedId(pageId)
    } else {
      setSelectedPageIds([pageId])
      setLastSelectedId(pageId)
    }

    setActivePageId(pageId)
  }

  // Delete individual page
  const handleDeletePage = (pageId, e) => {
    e.stopPropagation()
    if (window.confirm('Are you sure you want to delete this page?')) {
      deleteWorkspacePage(pageId)
      if (activePageId === pageId) {
        const remaining = pages.filter(p => p.id !== pageId)
        setActivePageId(remaining.length > 0 ? remaining[0].id : null)
      }
      setSelectedPageIds(prev => prev.filter(id => id !== pageId))
    }
  }

  // Delete multiple selected pages
  const handleBulkDelete = () => {
    if (selectedPageIds.length === 0) return
    const count = selectedPageIds.length
    if (window.confirm(`Are you sure you want to delete ${count} selected page${count > 1 ? 's' : ''}?`)) {
      selectedPageIds.forEach(id => deleteWorkspacePage(id))
      const remaining = pages.filter(p => !selectedPageIds.includes(p.id))
      setActivePageId(remaining.length > 0 ? remaining[0].id : null)
      setSelectedPageIds([])
      setLastSelectedId(null)
    }
  }

  // Handle keyboard Delete / Backspace for bulk deletion
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedPageIds.length > 0) {
        e.preventDefault()
        handleBulkDelete()
      } else if (e.key === 'Escape' && selectedPageIds.length > 0) {
        setSelectedPageIds([])
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedPageIds, pages, activePageId])

  const renderPages = (pagesToRender, depth = 0) => {
    return pagesToRender.map(page => {
      const isSelected = selectedPageIds.includes(page.id)
      const isActive = activePageId === page.id

      return (
        <div key={page.id}>
          <div 
            className={`sidebar-item ${isActive ? 'active' : ''} ${isSelected ? 'selected' : ''}`}
            onClick={(e) => handleItemClick(page.id, e)}
            style={{ paddingLeft: `${depth * 1 + 1}rem` }}
            role="treeitem"
            aria-selected={isSelected}
            tabIndex={0}
          >
            <span className="emoji">{page.emoji || <FileText size={16} />}</span>
            <span className="title">{page.title || 'Untitled'}</span>
            <div className="item-actions">
              <button 
                className="icon-btn-small" 
                onClick={(e) => { e.stopPropagation(); handleCreateNewPage(page.id); }}
                title="Add child page"
                aria-label="Add child page"
              >
                <Plus size={14} />
              </button>
              <button 
                className="icon-btn-small icon-btn-delete" 
                onClick={(e) => handleDeletePage(page.id, e)}
                title="Delete page"
                aria-label="Delete page"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
          {page.children && page.children.length > 0 && renderPages(page.children, depth + 1)}
        </div>
      )
    })
  }

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
            aria-label="Search pages"
          />
        </div>
        {selectedPageIds.length > 1 && (
          <div className="sidebar-selection-banner" role="status">
            <span className="selection-count">{selectedPageIds.length} selected</span>
            <div className="selection-actions">
              <button 
                className="selection-action-btn delete-btn"
                onClick={handleBulkDelete}
                title={`Delete ${selectedPageIds.length} pages`}
                aria-label={`Delete ${selectedPageIds.length} selected pages`}
              >
                <Trash2 size={13} /> Delete
              </button>
              <button 
                className="selection-action-btn"
                onClick={() => setSelectedPageIds([])}
                title="Clear selection (Esc)"
                aria-label="Clear selection"
              >
                <X size={13} />
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="sidebar-content">
        {!isSynced ? (
          <div className="empty-state" style={{ padding: '1rem', fontSize: '0.85rem' }}>Loading workspace...</div>
        ) : searchQuery ? (
          filteredPages.length > 0 ? (
            filteredPages.map(page => {
              const isSelected = selectedPageIds.includes(page.id)
              const isActive = activePageId === page.id
              return (
                <div 
                  key={page.id} 
                  className={`sidebar-item ${isActive ? 'active' : ''} ${isSelected ? 'selected' : ''}`}
                  onClick={(e) => handleItemClick(page.id, e)}
                  role="treeitem"
                  aria-selected={isSelected}
                  tabIndex={0}
                >
                  <span className="emoji">{page.emoji || <FileText size={16} />}</span>
                  <span className="title">{page.title || 'Untitled'}</span>
                  <div className="item-actions">
                    <button 
                      className="icon-btn-small icon-btn-delete" 
                      onClick={(e) => handleDeletePage(page.id, e)}
                      title="Delete page"
                      aria-label="Delete page"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              )
            })
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

