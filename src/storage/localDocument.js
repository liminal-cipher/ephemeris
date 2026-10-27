import * as Y from 'yjs'

// Compatible with the existing y-indexeddb stores. Never compact or delete
// historical updates here; acknowledgement means the IDB transaction committed.
export class LocalDocument {
  constructor(name, { broadcast = true } = {}) {
    this.name = name
    this.doc = new Y.Doc()
    this.listeners = new Set()
    this.pending = Promise.resolve()
    this.status = 'loading'
    this.error = null
    this.closed = false
    this.ready = this.open().then(() => {
      this.setStatus('saved')
      if (broadcast && typeof window !== 'undefined' && window.BroadcastChannel) {
        this.channel = new window.BroadcastChannel(`ephemeris-local:${name}`)
        this.channel.onmessage = ({ data }) => {
          if (this.closed) return
          try {
            if (data.type === 'request') {
              this.channel.postMessage({ type: 'update', update: Y.encodeStateAsUpdate(this.doc) })
            } else if (data.type === 'update' && data.update instanceof Uint8Array) {
              Y.applyUpdate(this.doc, data.update, this.channel)
            }
          } catch (error) { this.setStatus('error', error) }
        }
        this.channel.postMessage({ type: 'request' })
        this.channel.postMessage({ type: 'update', update: Y.encodeStateAsUpdate(this.doc) })
      }
      return this
    }).catch(error => {
      this.setStatus('error', error)
      throw error
    })
    this.doc.on('update', (update, origin) => {
      if (origin === this || this.closed) return
      this.setStatus('saving')
      this.pending = this.pending.then(() => this.ready).then(() => this.append(update))
      // Keep the rejected chain for flush(), while handling event-driven errors.
      const pending = this.pending
      pending.then(() => {
        if (pending === this.pending) this.setStatus('saved')
      }, error => this.setStatus('error', error))
      if (origin !== this.channel) this.channel?.postMessage({ type: 'update', update })
    })
  }

  async open() {
    this.database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name)
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains('updates')) database.createObjectStore('updates', { autoIncrement: true })
        if (!database.objectStoreNames.contains('custom')) database.createObjectStore('custom')
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('Local database is blocked by another application version'))
    })
    this.database.onversionchange = () => {
      this.database.close()
      this.setStatus('error', new Error('Storage changed in another tab. Reload to continue.'))
    }
    await new Promise((resolve, reject) => {
      const tx = this.database.transaction('updates', 'readonly')
      const request = tx.objectStore('updates').getAll()
      request.onsuccess = () => {
        try {
          this.doc.transact(() => request.result.forEach(update => Y.applyUpdate(this.doc, update, this)), this)
        } catch (error) { reject(error) }
      }
      tx.oncomplete = resolve
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Could not read local document'))
    })
  }

  append(update) {
    return new Promise((resolve, reject) => {
      const tx = this.database.transaction('updates', 'readwrite')
      tx.objectStore('updates').add(update)
      tx.oncomplete = resolve
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Could not save local document'))
    })
  }

  setStatus(status, error = null) {
    this.status = status
    this.error = error
    this.listeners.forEach(listener => listener(this))
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async flush() {
    await this.ready
    // Updates can arrive during a transaction; wait until the queue settles.
    let pending
    do { pending = this.pending; await pending } while (pending !== this.pending)
    if (this.error) throw this.error
  }

  async commit(mutate) {
    await this.flush()
    const draft = new Y.Doc()
    try {
      Y.applyUpdate(draft, Y.encodeStateAsUpdate(this.doc))
      const vector = Y.encodeStateVector(draft)
      mutate(draft)
      const update = Y.encodeStateAsUpdate(draft, vector)
      this.setStatus('saving')
      // Destructive UI actions become visible only after the write commits.
      this.pending = this.pending.then(async () => {
        await this.append(update)
        Y.applyUpdate(this.doc, update, this)
        this.channel?.postMessage({ type: 'update', update })
      })
      const pending = this.pending
      await pending
      if (pending === this.pending) this.setStatus('saved')
    } catch (error) { this.setStatus('error', error); throw error }
    finally { draft.destroy() }
  }

  async close() {
    try { await this.flush() } finally {
      this.closed = true
      this.channel?.close()
      this.database?.close()
      this.doc.destroy()
      this.listeners.clear()
    }
  }
}
