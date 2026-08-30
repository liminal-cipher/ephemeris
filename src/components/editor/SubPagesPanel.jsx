import React from 'react'
import { FileText, Plus, CornerDownRight } from 'lucide-react'
import { createWorkspacePage } from '../../store/workspace'
import './SubPagesPanel.css'

export default function SubPagesPanel({ activePageId, allPages, setActivePageId }) {
  const childPages = allPages ? allPages.filter(p => p.parentId === activePageId) : []

  const handleCreateChild = () => {
    const newId = createWorkspacePage(activePageId)
    setActivePageId(newId)
  }

  if (childPages.length === 0) {
    return (
      <div className="sub-pages-container empty">
        <button className="add-subpage-inline-btn" onClick={handleCreateChild}>
          <Plus size={14} aria-hidden="true" /> Add a sub-page
        </button>
      </div>
    )
  }

  return (
    <div className="sub-pages-container" role="region" aria-label="Sub-pages">
      <div className="sub-pages-header">
        <div className="sub-pages-title">
          <CornerDownRight size={14} style={{ color: 'var(--text-muted)' }} aria-hidden="true" />
          <span>Sub-pages ({childPages.length})</span>
        </div>
        <button 
          className="add-subpage-btn" 
          onClick={handleCreateChild}
          aria-label="Add new sub-page"
        >
          <Plus size={13} aria-hidden="true" /> New Sub-page
        </button>
      </div>

      <div className="sub-pages-grid" role="list">
        {childPages.map(child => (
          <div
            key={child.id}
            className="sub-page-card"
            onClick={() => setActivePageId(child.id)}
            role="listitem"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setActivePageId(child.id)
              }
            }}
          >
            <span className="sub-page-icon">{child.emoji || <FileText size={16} />}</span>
            <div className="sub-page-info">
              <span className="sub-page-title">{child.title || 'Untitled'}</span>
              <span className="sub-page-date">
                {new Date(child.updatedAt || child.createdAt || Date.now()).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric'
                })}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
