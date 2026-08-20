import { db } from '../db/db';

export async function exportWorkspace() {
  try {
    const pages = await db.pages.toArray();
    const dataStr = JSON.stringify(pages, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `ephemeris-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Failed to export workspace:', error);
    alert('Failed to export workspace.');
  }
}

export async function importWorkspace(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = JSON.parse(e.target.result);
        if (!Array.isArray(data)) {
          throw new Error('Invalid backup format');
        }
        
        await db.pages.bulkPut(data);
        resolve(data.length);
      } catch (error) {
        console.error('Import failed:', error);
        reject(error);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
