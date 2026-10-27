import { db } from '../db/db'
import { vault, workspaceReady } from '../store/workspace'
import { createBackup, restoreBackup, PRESENTATION_KEYS } from '../storage/backup'
import { showToast } from '../store/dialogStore'

export async function exportWorkspace() {
  try {
    await workspaceReady
    const settings = {}
    for (const key of PRESENTATION_KEYS) {
      try { const value = localStorage.getItem(key); if (value !== null) settings[key] = value } catch { /* Optional presentation settings. */ }
    }
    const backup = await createBackup(vault, await db.pages.toArray(), settings)
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `ephemeris-backup-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    showToast('Workspace backup exported. Keep it in a safe location.', 'success')
  } catch (error) { showToast(`Backup failed: ${error.message}`, 'error') }
}

export async function importWorkspace(file) {
  if (file.size > 50 * 1024 * 1024) throw new Error('Backup exceeds the 50 MiB limit')
  await workspaceReady
  const text = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsText(file)
  })
  const result = await restoreBackup(vault, text)
  // Keep current preferences. Imported values also remain in the recovery archive.
  for (const [key, value] of Object.entries(result.settings)) {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, value) } catch { /* Retained in archive. */ }
  }
  return result.count
}
