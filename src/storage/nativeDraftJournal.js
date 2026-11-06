// Pending native writes only. This database never stores Companion credentials.
let opening
function database() {
  if (!opening) opening = new Promise((resolve, reject) => {
    const request = indexedDB.open('ephemeris-native-recovery', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('drafts')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => { opening = null; reject(request.error) }
    request.onblocked = () => { opening = null; reject(new Error('Close other Ephemeris tabs to open recovery storage.')) }
  })
  return opening
}
async function transact(mode, operation) {
  const db = await database()
  return new Promise((resolve, reject) => {
    // A completed strict transaction is the durability boundary shown in the UI.
    const transaction = db.transaction('drafts', mode, mode === 'readwrite' ? { durability: 'strict' } : {})
    const request = operation(transaction.objectStore('drafts'))
    transaction.oncomplete = () => resolve(request.result)
    transaction.onabort = () => reject(transaction.error || new Error('Recovery transaction aborted'))
    transaction.onerror = () => reject(transaction.error || request.error)
  })
}
export const nativeDraftJournal = {
  setItem: (key, value) => transact('readwrite', store => store.put(value, key)),
  removeItem: key => transact('readwrite', store => store.delete(key)),
  entries: async prefix => {
    const db = await database()
    return new Promise((resolve, reject) => {
      const result = [], transaction = db.transaction('drafts', 'readonly')
      const request = transaction.objectStore('drafts').openCursor(IDBKeyRange.bound(prefix, prefix + '\uffff'))
      request.onsuccess = () => { const cursor = request.result; if (cursor) { result.push([cursor.key, cursor.value]); cursor.continue() } }
      transaction.oncomplete = () => resolve(result)
      transaction.onabort = () => reject(transaction.error)
      request.onerror = () => reject(request.error)
    })
  },
}
