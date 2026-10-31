import { MAX_BYTES } from '../validation.js'

export const MAX_PAGE_BYTES=64*1024*1024
export const MAX_HISTORY_BYTES=64*1024*1024
export const MAX_HISTORY_OPERATIONS=1024
export const MAX_APPLY_OPERATIONS=200
export function byteLimit(value=MAX_PAGE_BYTES) {
  if(!Number.isSafeInteger(value)||value<1024||value>MAX_PAGE_BYTES)throw new Error('Invalid sync byte limit')
  return value
}
export function pageBytes(page,limit=MAX_PAGE_BYTES) {
  byteLimit(limit)
  // Bound aggregate serialisation before validating/decoding any Yjs or BLOB.
  let bytes=0
  for(const op of page.operations) {
    const size=Buffer.byteLength(JSON.stringify(op))
    if(size>MAX_BYTES)throw new Error('Oversized sync operation')
    bytes+=size
    if(bytes>limit)throw new Error('Sync page byte limit exceeded')
  }
  return bytes
}
export class ProviderError extends Error {
  constructor(code,message=code) {super(message);this.name='ProviderError';this.code=code}
}
export const permanentProviderError=error=>['UNAUTHENTICATED','FORBIDDEN','REVOKED','INVALID_OPERATION','OPERATION_TOO_LARGE','CURSOR_EXPIRED','EPOCH_CHANGED'].includes(error?.code)
