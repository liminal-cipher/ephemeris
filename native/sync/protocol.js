import * as Y from 'yjs'
import { identifier, metadata, jsonValue, nativeUpdate, digest, MAX_BYTES } from '../validation.js'

export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  return JSON.stringify(value)
}
export const hash = value => digest(canonical(value))
export const equal = (a, b) => canonical(a) === canonical(b)
export function decode(text) {
  if (typeof text !== 'string' || text.length > MAX_BYTES * 2 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw new Error('Invalid base64')
  return Buffer.from(text, 'base64')
}
export function snapshot(note, attachments) {
  return { id: note.id, metadata: note.metadata, document: Buffer.from(note.document).toString('base64'),
    deleted: note.deleted, recovery: note.recovery, legacyRecords: note.legacyRecords, contentState: note.contentState,
    attachments: attachments.map(a => ({ id: a.id, metadata: a.metadata, bytes: Buffer.from(a.bytes).toString('base64'), sha256: a.sha256 })).sort((a,b) => a.id < b.id ? -1 : 1) }
}
export function validateSnapshot(s) {
  if (!s || !equal(Object.keys(s).sort(), ['id','metadata','document','deleted','recovery','legacyRecords','contentState','attachments'].sort())) throw new Error('Invalid sync snapshot')
  identifier(s.id); metadata(s.metadata); nativeUpdate(decode(s.document))
  if (s.metadata.parentId===s.id) throw new Error('Invalid page hierarchy')
  if (typeof s.recovery !== 'boolean' || !['native','legacy-only'].includes(s.contentState) || !Array.isArray(s.legacyRecords) || !Array.isArray(s.attachments) || s.attachments.length > 1000 || (s.deleted !== null && (typeof s.deleted !== 'object' || Array.isArray(s.deleted)))) throw new Error('Invalid sync note state')
  const ids = new Set()
  for (const a of s.attachments) {
    identifier(a.id)
    if (ids.has(a.id) || !equal(Object.keys(a).sort(), ['id','metadata','bytes','sha256'].sort()) || digest(decode(a.bytes)) !== a.sha256) throw new Error('Attachment integrity failure')
    ids.add(a.id)
  }
  jsonValue(s)
}
export function fields(s) {
  const result = {}
  for (const [key, value] of Object.entries(s.metadata)) result['meta:' + key] = value
  for (const key of ['document','deleted','recovery','legacyRecords','contentState']) result[key] = s[key]
  for (const a of s.attachments) result['attachment:' + a.id] = a
  return result
}
export function changedFields(before, after) {
  const a = before ? fields(before) : {}, b = fields(after)
  // Existing attachment identities and metadata keys are retained by this protocol.
  if (Object.keys(a).some(key => !Object.hasOwn(b, key))) throw new Error('Sync fields cannot be removed')
  return Object.keys(b).filter(key => !Object.hasOwn(a, key) || !equal(a[key], b[key])).sort()
}
export function validateOperation(op) {
  jsonValue(op)
  if (!op || op.protocol !== 1 || !equal(Object.keys(op).sort(), ['protocol','id','vaultId','clientId','sequence','parents','snapshot','writes','sha256'].sort())) throw new Error('Unsupported sync operation')
  for (const key of ['id','vaultId','clientId']) identifier(op[key])
  if (!Number.isSafeInteger(op.sequence) || op.sequence < 1 || !Array.isArray(op.parents) || op.parents.length > 1000 || new Set(op.parents).size !== op.parents.length || op.parents.includes(op.id)) throw new Error('Invalid causality')
  op.parents.forEach(identifier); validateSnapshot(op.snapshot)
  const available = fields(op.snapshot)
  if (!Array.isArray(op.writes) || op.writes.length > 2000 || new Set(op.writes).size !== op.writes.length || op.writes.some(key => !Object.hasOwn(available, key))) throw new Error('Invalid field writes')
  const { sha256, ...body } = op
  if (hash(body) !== sha256) throw new Error('Operation checksum mismatch')
  return op
}

// An immutable per-note DAG. Versions and timestamps do not order replicas.
export function graph(operations) {
  const map = new Map(operations.map(op => [op.id, op])), ancestors = new Map(), visiting = new Set()
  const visit = id => {
    if (ancestors.has(id)) return ancestors.get(id)
    if (visiting.has(id) || !map.has(id)) throw new Error('Incomplete or cyclic operation graph')
    visiting.add(id)
    const set = new Set()
    for (const parent of map.get(id).parents) { set.add(parent); for (const ancestor of visit(parent)) set.add(ancestor) }
    visiting.delete(id); ancestors.set(id, set); return set
  }
  operations.forEach(op => visit(op.id))
  const heads = operations.filter(op => !operations.some(other => ancestors.get(other.id).has(op.id))).map(op => op.id).sort()
  return { map, ancestors, heads }
}

export function reconcile(operations) {
  if (!operations.length) return { snapshot: null, conflicts: [], heads: [] }
  const { ancestors, heads } = graph(operations), registers = new Map(), conflicts = []
  const sorted = [...operations].sort((a,b) => a.id < b.id ? -1 : 1)
  const compatibleDocuments = entries => {
    const common = sorted.filter(base => entries.every(op => ancestors.get(op.id).has(base.id)))
    return common.length > 0 && entries.every(op => {
      if (op.snapshot.contentState !== 'native') return false
      const vector=Y.decodeStateVector(Y.encodeStateVectorFromUpdate(decode(op.snapshot.document)))
      return common.every(base => [...Y.decodeStateVector(Y.encodeStateVectorFromUpdate(decode(base.snapshot.document)))].every(([client,clock]) => (vector.get(client)??0)>=clock))
    })
  }
  const conflict = (field, entries) => {
    const ids = entries.map(op => op.id).sort()
    conflicts.push({ id: hash({ noteId: sorted[0].snapshot.id, field, ids }), noteId: sorted[0].snapshot.id, field, operations: ids, status: 'unresolved' })
  }
  for (const op of sorted) for (const key of op.writes) {
    if (!registers.has(key)) registers.set(key, [])
    registers.get(key).push(op)
  }
  const chosen = {}
  for (const [key, entries] of registers) {
    const maximal = entries.filter(op => !entries.some(other => ancestors.get(other.id).has(op.id)))
    // Record every genuinely concurrent disagreeing pair, even after a later edit.
    // This makes retained history independent of delivery order and batch size.
    for (let i=0;i<entries.length;i++) for (let j=i+1;j<entries.length;j++) {
      const a=entries[i], b=entries[j]
      if (!ancestors.get(a.id).has(b.id) && !ancestors.get(b.id).has(a.id) && !equal(fields(a.snapshot)[key], fields(b.snapshot)[key]) && (key!=='document' || !compatibleDocuments([a,b]))) conflict(key, [a,b])
    }
    chosen[key] = fields(maximal[0].snapshot)[key]
    if (key === 'document' && maximal.length > 1) {
      if (compatibleDocuments(maximal)) chosen[key] = Buffer.from(Y.mergeUpdates(maximal.map(op => decode(op.snapshot.document)))).toString('base64')
    }
    if (key === 'deleted') chosen[key] = maximal.find(op => op.snapshot.deleted !== null)?.snapshot.deleted ?? null
  }
  // Concurrent delete versus any edit remains inspectable; deletion wins until
  // a restoration causally observes all deletion writers.
  for (const a of sorted.filter(op => op.writes.includes('deleted') && op.snapshot.deleted !== null)) {
    for (const b of sorted) if (a !== b && !ancestors.get(a.id).has(b.id) && !ancestors.get(b.id).has(a.id) && b.snapshot.deleted === null) conflict('delete-versus-edit', [a,b])
  }
  const s = { id: sorted[0].snapshot.id, metadata: {}, attachments: [] }
  for (const [key,value] of Object.entries(chosen)) {
    if (key.startsWith('meta:')) s.metadata[key.slice(5)] = value
    else if (key.startsWith('attachment:')) s.attachments.push(value)
    else s[key] = value
  }
  s.attachments.sort((a,b) => a.id < b.id ? -1 : 1)
  // Recovery and legacy source records are never dropped by reconciliation.
  s.recovery = sorted.some(op => op.snapshot.recovery)
  s.legacyRecords = [...new Map(sorted.flatMap(op => op.snapshot.legacyRecords).map(row => [canonical(row),row])).values()]
  validateSnapshot(s)
  return { snapshot: s, conflicts, heads }
}
