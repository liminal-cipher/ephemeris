import { useSyncExternalStore } from 'react'
import { vault } from '../store/workspace'
import { showToast } from '../store/dialogStore'

const subscribe = listener => vault.subscribe(listener)
const snapshot = () => JSON.stringify(vault.workspace.doc.getMap('deletedPages').toJSON())

export default function RecoveryPanel() {
  const deleted = JSON.parse(useSyncExternalStore(subscribe, snapshot))
  return <details className="sync-settings">
    <summary>Deleted pages ({Object.keys(deleted).length})</summary>
    <p>Deleted content stays on this device and in backups. Restore each page to the workspace root.</p>
    {Object.entries(deleted).map(([id, entry]) => <div key={id}>
      <span>{entry.metadata?.title || vault.list({ includeDeleted: true }).find(page => page.id === id)?.title || 'Untitled'}</span>
      <button onClick={() => {
        vault.restore(id).catch(error => showToast(`Restore could not be saved: ${error.message}`, 'error'))
      }}>Restore page</button>
    </div>)}
  </details>
}
