import { useState } from 'react'
import Sidebar from './components/Sidebar'
import PageEditor from './components/PageEditor'

function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true)

  return (
    <div className="app-container">
      {sidebarOpen && <Sidebar />}
      <div className="main-content">
        <PageEditor onToggleSidebar={() => setSidebarOpen(!sidebarOpen)} sidebarOpen={sidebarOpen} />
      </div>
    </div>
  )
}

export default App
