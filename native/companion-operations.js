import { ConflictError } from './vault.js'
import { identifier } from './validation.js'
import { decode } from './sync/protocol.js'
import { validateProperties } from './knowledge.js'

export const WRITE_PERMISSIONS = ['notes:create', 'notes:update', 'notes:delete', 'notes:restore', 'attachments:create']
export const WRITE_ROUTES = { create: 'notes:create', update: 'notes:update', delete: 'notes:delete', restore: 'notes:restore', attach: 'attachments:create' }

export function permissions(value = []) {
  if (!Array.isArray(value) || value.some(item => !WRITE_PERMISSIONS.includes(item)) || new Set(value).size !== value.length) throw new Error('Invalid write permissions')
  return [...value]
}

function keys(value, allowed, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw new Error('Invalid request')
}

export function readNote(vault, id) {
  identifier(id)
  const note = vault.read(id)
  return { ...note, document: Buffer.from(note.document).toString('base64'), preview: vault.preview(id), attachments: vault.listAttachments(id) }
}

// The HTTP adapter exposes only operations on the one explicitly opened Vault.
// Neither request objects nor metadata can select a path, SQL statement or method.
export function writeNote(vault, operation, args, granted) {
  if (!granted.includes(WRITE_ROUTES[operation])) throw new Error('Permission denied')
  const allowed = {
    create: ['id', 'metadata', 'document'], update: ['id', 'expected', 'metadata', 'document'],
    delete: ['id', 'expected'], restore: ['id', 'expected'], attach: ['id', 'expected', 'attachment'],
  }
  keys(args, allowed[operation], operation === 'create' ? ['id'] : ['id', 'expected'])
  identifier(args.id)
  if (operation !== 'create') {
    keys(args.expected, ['version', 'contentHash'], ['version', 'contentHash'])
    if (!Number.isSafeInteger(args.expected.version) || args.expected.version < 1 || !/^[a-f0-9]{64}$/.test(args.expected.contentHash)) throw new Error('Invalid expected version')
  }
  if (operation === 'create') {
    validateProperties(args.metadata)
    try { vault.read(args.id); throw new ConflictError() }
    catch (error) { if (error.message !== 'Note not found') throw error }
    vault.create({ id: args.id, metadata: args.metadata, ...(args.document === undefined ? {} : { document: decode(args.document) }) })
  } else if (operation === 'update') {
    validateProperties(args.metadata, vault.read(args.id).metadata)
    if (args.metadata === undefined && args.document === undefined) throw new Error('Invalid empty update')
    vault.update(args.id, { ...(args.metadata === undefined ? {} : { metadata: args.metadata }), ...(args.document === undefined ? {} : { document: decode(args.document) }) }, args.expected)
  } else if (operation === 'delete') vault.delete(args.id, args.expected)
  else if (operation === 'restore') vault.restore(args.id, args.expected)
  else if (operation === 'attach') {
    keys(args.attachment, ['id', 'metadata', 'bytes'], ['id', 'bytes'])
    identifier(args.attachment.id)
    vault.putAttachment(args.id, { ...args.attachment, bytes: decode(args.attachment.bytes) }, args.expected)
  }
  return readNote(vault, args.id)
}
