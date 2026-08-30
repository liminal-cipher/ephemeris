import React, { useMemo } from 'react'
import { Link as LinkIcon } from 'lucide-react'
import { extractLinksFromPages } from '../../utils/linkParser'

export default function BacklinksPanel({ dexiePages, allPages, activePageId, setActivePageId }) {
  const backlinks = useMemo(() => {
    if (!dexiePages || !activePageId) return []
    const { edges } = extractLinksFromPages(dexiePages)
    const incomingEdgeSourceIds = edges.filter(e => e.target === activePageId || e.target === Number(activePageId)).map(e => e.source)
    const uniqueSourceIds = [...new Set(incomingEdgeSourceIds)]
    return uniqueSourceIds.map(id => allPages.find(p => p.id === id || p.id === String(id))).filter(Boolean)
  }, [dexiePages, allPages, activePageId])

  return (
    <div className="backlinks-section" aria-labelledby="backlinks-heading">
      <h3 id="backlinks-heading" className="backlinks-title">
        <LinkIcon size={16} aria-hidden="true" />
        Backlinks
      </h3>
      {backlinks.length > 0 ? (
        <ul className="backlinks-list" role="list">
          {backlinks.map(p => (
            <li 
              key={p.id} 
              className="backlink-item" 
              onClick={() => setActivePageId(p.id)}
              role="button"
              tabIndex="0"
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setActivePageId(p.id)
                }
              }}
              aria-label={`Go to backlink page: ${p.title || 'Untitled'}`}
            >
              <span className="backlink-emoji" aria-hidden="true">{p.emoji || '📄'}</span>
              <span className="backlink-title">{p.title || 'Untitled'}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="backlinks-empty" role="status">No pages link to this page yet.</div>
      )}
    </div>
  )
}
