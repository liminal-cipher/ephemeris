import { parentPort, workerData } from 'node:worker_threads'
import { NativeVault, ConflictError } from './vault.js'
import { readNote, writeNote, WRITE_ROUTES } from './companion-operations.js'

let vault
try {
  vault = NativeVault.open(workerData.directory, { readOnly: !workerData.permissions.length })
  vault.verify()
  vault.search('startup-probe', { limit: 1 })
  parentPort.postMessage({ ready: true })
} catch {
  vault?.close()
  parentPort.postMessage({ startupError: 'Cannot open a verified searchable Vault. Run inspect and rebuild-search locally.' })
}

parentPort.on('message', ({ requestId, operation, args }) => {
  try {
    let result
    if (operation === 'list') result = vault.listPage(args)
    else if (operation === 'views') result = vault.queryNotes(args)
    else if (operation === 'search') result = vault.search(args.q, args)
    else if (operation === 'changes') result = args.after === undefined ? vault.recentChanges(args) : vault.changes(args)
    else if (operation === 'read') result = readNote(vault, args.id)
    else if (Object.hasOwn(WRITE_ROUTES, operation)) result = writeNote(vault, operation, args, workerData.permissions)
    else if (operation === 'attachment') {
      const attachment = vault.readAttachment(args.noteId, args.id)
      parentPort.postMessage({ requestId, contentType: 'application/octet-stream', body: attachment.bytes, sha256: attachment.sha256 })
      return
    } else throw new Error('Invalid operation')
    const body = JSON.stringify(result)
    if (Buffer.byteLength(body) > 16 * 1024 * 1024) {
      parentPort.postMessage({ requestId, error: 'Response too large; use native backup/CLI recovery', status: 413 })
      return
    }
    parentPort.postMessage({ requestId, contentType: 'application/json', body })
  } catch (error) {
    const conflict = error instanceof ConflictError
    const invalid = /Invalid|identifier|pagination|query|Metadata|metadata|JSON|hierarchy|Parent|Cannot edit|Legacy-only|base64/.test(error.message)
    parentPort.postMessage({ requestId, error: conflict ? 'Stale note version; original and draft retained' : invalid ? 'Invalid request or unsupported note state' : 'Native data unavailable; inspect the Vault locally', status: conflict ? 409 : invalid ? 400 : error.message === 'Note not found' ? 404 : 503 })
  }
})
