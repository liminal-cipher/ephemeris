import { pageOptions } from './textProjection.js'

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const text = (value, max) => typeof value === 'string' && value.length <= max && !value.includes('\0')
export function validateProperties(fields, previous = {}) {
  if (!fields || typeof fields !== 'object') return
  for (const [key, value] of Object.entries(fields)) {
    if (same(value, previous[key])) continue
    let valid = true
    if (key === 'tags') valid = Array.isArray(value) && value.length <= 50 && value.every(tag => text(tag, 64) && tag.trim()) && new Set(value).size === value.length
    if (key === 'project' || key === 'status') valid = text(value, 200)
    if (key === 'favorite') valid = typeof value === 'boolean'
    if (key === 'dueDate') valid = value === '' || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value)
    if (!valid) throw new Error('Invalid property: ' + key)
  }
  if (fields.kind === 'workspace-view' || fields.view !== undefined) validateView(fields.view ?? previous.view)
}

export function validateView(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['tag', 'status', 'project', 'favorite', 'sort', 'layout'].includes(key))) throw new Error('Invalid view definition')
  for (const key of ['tag', 'status', 'project']) if (options[key] !== undefined && !text(options[key], 200)) throw new Error('Invalid view filter')
  if (options.favorite !== undefined && typeof options.favorite !== 'boolean') throw new Error('Invalid favourite filter')
  if (options.sort !== undefined && !['title', 'recent', 'due'].includes(options.sort)) throw new Error('Invalid view sort')
  if (options.layout !== undefined && !['table', 'cards', 'board'].includes(options.layout)) throw new Error('Invalid view layout')
  return options
}

export function queryNotes(db, { limit: count, offset: start, definitions = false, ...options } = {}) {
  const { limit, offset } = pageOptions({ limit: count, offset: start })
  validateView(options)
  if (typeof definitions !== 'boolean') throw new Error('Invalid definitions filter')
  const clauses = ['n.deleted IS NULL', 'n.recovery=0'], values = []
  clauses.push(definitions ? "json_extract(n.metadata,'$.kind')='workspace-view'" : "json_extract(n.metadata,'$.kind') IS NOT 'workspace-view'")
  for (const key of ['status', 'project']) if (options[key]) { clauses.push("json_extract(n.metadata,'$." + key + "')=?"); values.push(options[key]) }
  if (options.favorite) clauses.push("json_extract(n.metadata,'$.favorite')=1")
  if (options.tag) { clauses.push("json_type(n.metadata,'$.tags')='array' AND EXISTS(SELECT 1 FROM json_each(n.metadata,'$.tags') WHERE value=?)"); values.push(options.tag) }
  const where = clauses.join(' AND ')
  const order = options.sort === 'recent' ? 'c.last_sequence DESC,n.id' : options.sort === 'due' ? "COALESCE(NULLIF(json_extract(n.metadata,'$.dueDate'),''),'9999-99-99'),n.id" : "lower(COALESCE(json_extract(n.metadata,'$.title'),'')),n.id"
  const total = db.prepare('SELECT count(*) AS total FROM notes n WHERE ' + where).get(...values).total
  const source = options.sort === 'recent' ? 'notes n LEFT JOIN (SELECT note_id,max(sequence) AS last_sequence FROM changes GROUP BY note_id) c ON c.note_id=n.id' : 'notes n'
  const rows = db.prepare('SELECT n.id,n.metadata,n.version,n.content_hash FROM ' + source + ' WHERE ' + where + ' ORDER BY ' + order + ' LIMIT ? OFFSET ?')
    .all(...values, limit, offset).map(row => ({ id: row.id, metadata: JSON.parse(row.metadata), version: row.version, contentHash: row.content_hash }))
  return { rows, total, limit, offset }
}
