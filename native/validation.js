import * as Y from 'yjs'
import { createHash } from 'node:crypto'

export const MAX_BYTES = 50 * 1024 * 1024
export const digest = bytes => createHash('sha256').update(bytes).digest('hex')

export function identifier(id) {
  if (typeof id !== 'string' || !id || id.length > 200 || [...id].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === '/' || char === '\\') ||
      ['.', '..', '__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('Invalid identifier')
  return id
}

export function jsonValue(value) {
  const visit = (item, depth = 0) => {
    if (depth > 100) throw new Error('Metadata is too deeply nested')
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (typeof item !== 'object' || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)) throw new Error('Expected JSON data')
    for (const [key, child] of Object.entries(item)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsafe metadata property')
      visit(child, depth + 1)
    }
  }
  visit(value)
  const text = JSON.stringify(value)
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Metadata too large')
  return text
}

export function metadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid metadata')
  const text = jsonValue(value)
  if ('id' in value) throw new Error('ID is immutable')
  for (const key of ['title', 'emoji', 'coverImage']) if (value[key] != null && typeof value[key] !== 'string') throw new Error('Invalid metadata')
  if (value.parentId != null) identifier(value.parentId)
  return text
}

export function nativeUpdate(update) {
  if (!(update instanceof Uint8Array) || !update.length || update.length > MAX_BYTES) throw new Error('Invalid native update')
  const bytes = Buffer.from(update)
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, bytes)
    if (doc.store.pendingStructs || doc.store.pendingDs) throw new Error('Incomplete native update')
    return bytes
  } finally { doc.destroy() }
}

export function emptyUpdate() {
  const doc = new Y.Doc()
  try { return Y.encodeStateAsUpdate(doc) } finally { doc.destroy() }
}
