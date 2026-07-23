import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { useStore } from '../store/useStore'
import { FileText, Plus } from 'lucide-react'
import './Sidebar.css'

export default function Sidebar() {
  const pages = useLiveQuery(() => db.pages.toArray())
  const { activePageId, setActivePageId } = useStore()

  const createNewPage = async () => {
    const id = await db.pages.add({
      title: '',
      emoji: '',
      coverImage: '',
      content: '',
      parentId: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    setActivePageId(id)
  }

  // Set first page active if none selected
  if (pages?.length > 0 && !activePageId) {
    setActivePageId(pages[0].id)
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="workspace-name">My Workspace</div>
      </div>
      <div className="sidebar-content">
        {pages?.map(page => (
          <div 
            key={page.id} 
            className={`sidebar-item ${activePageId === page.id ? 'active' : ''}`}
            onClick={() => setActivePageId(page.id)}
          >
            <span className="emoji">{page.emoji || <FileText size={16} />}</span>
            <span className="title">{page.title || 'Untitled'}</span>
          </div>
        ))}
      </div>
      <div className="sidebar-footer">
        <button className="new-page-btn" onClick={createNewPage}>
          <Plus size={16} />
          New Page
        </button>
      </div>
    </div>
  )
}
