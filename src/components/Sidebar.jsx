import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { useStore } from '../store/useStore'
import { FileText, Plus, Download, Upload } from 'lucide-react'
import { exportWorkspace, importWorkspace } from '../utils/exportImport'
import { useRef } from 'react'
import './Sidebar.css'

export default function Sidebar() {
  const pages = useLiveQuery(() => db.pages.toArray())
  const { activePageId, setActivePageId } = useStore()
  const fileInputRef = useRef(null)

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
      <div className="sidebar-footer" style={{ flexDirection: 'column', gap: '8px' }}>
        <button className="new-page-btn" onClick={createNewPage}>
          <Plus size={16} />
          New Page
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
