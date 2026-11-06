import { useState } from 'react'
import Sidebar from './components/Sidebar'
import PageEditor from './components/PageEditor'
import GraphView from './components/GraphView'
import CommandPalette from './components/CommandPalette'
import GlobalDialogHost from './components/common/GlobalDialogHost'
import NativeWorkspace from './components/NativeWorkspace'
import { useWorkspaceStore } from './store/workspace'

function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [isGraphViewOpen, setIsGraphViewOpen] = useState(false)
  const [nativeOpen, setNativeOpen] = useState(false)
  const ready = useWorkspaceStore(state => state.isSynced)
  const error = useWorkspaceStore(state => state.error)

  return (
    <div className="app-container">
      <div className="browser-workspace" inert={nativeOpen || undefined}>
      {error ? <div role="alert">Local storage is unavailable: {error}. Existing databases have been retained. Do not clear browser storage.</div> : !ready ? <div role="status">Opening local workspace…</div> : <>
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
      {!nativeOpen && <CommandPalette />}
      <GlobalDialogHost />
      </>}
      <button className="native-open" onClick={event => { event.currentTarget.focus(); setNativeOpen(true) }}>Native workspace</button>
      </div>
      {nativeOpen && <NativeWorkspace onClose={() => setNativeOpen(false)} />}
    </div>
  )
}

export default App
