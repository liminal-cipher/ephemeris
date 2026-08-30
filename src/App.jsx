import { useState } from 'react'
import Sidebar from './components/Sidebar'
import PageEditor from './components/PageEditor'
import GraphView from './components/GraphView'
import CommandPalette from './components/CommandPalette'
import GlobalDialogHost from './components/common/GlobalDialogHost'

function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [isGraphViewOpen, setIsGraphViewOpen] = useState(false)

  return (
    <div className="app-container">
      {sidebarOpen && (
        <Sidebar 
          onOpenGraph={() => setIsGraphViewOpen(true)} 
          onToggleSidebar={() => setSidebarOpen(false)} 
        />
      )}
      <div className="main-content">
        <PageEditor onToggleSidebar={() => setSidebarOpen(!sidebarOpen)} sidebarOpen={sidebarOpen} />
      </div>
      {isGraphViewOpen && <GraphView onClose={() => setIsGraphViewOpen(false)} />}
      <CommandPalette />
      <GlobalDialogHost />
    </div>
  )
}

export default App
