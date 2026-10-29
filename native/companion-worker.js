import { parentPort, workerData } from 'node:worker_threads'
import { NativeVault } from './vault.js'
import { identifier } from './validation.js'

let vault
try {
  vault = NativeVault.open(workerData.directory, { readOnly: true })
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
    else if (operation === 'search') result = vault.search(args.q, args)
    else if (operation === 'changes') result = args.after === undefined ? vault.recentChanges(args) : vault.changes(args)
    else if (operation === 'read') {
      identifier(args.id)
      const note = vault.read(args.id)
      result = { ...note, document: Buffer.from(note.document).toString('base64'), preview: vault.preview(args.id), attachments: vault.listAttachments(args.id) }
    } else if (operation === 'attachment') {
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
    const invalid = /Invalid|identifier|pagination|query/.test(error.message)
    parentPort.postMessage({ requestId, error: invalid ? 'Invalid request' : 'Native data unavailable; inspect the Vault locally', status: invalid ? 400 : 503 })
  }
})
