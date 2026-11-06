import { identifier } from '../validation.js'
import { MAX_HISTORY_BYTES, MAX_HISTORY_OPERATIONS } from './limits.js'

export const DEFAULT_RESOURCES = Object.freeze({ operationBytes:256*1024*1024, operations:100000, chunkBytes:512*1024*1024, chunks:262144, attachmentBytes:512*1024*1024 })
export function migrateResources(db) {
  db.exec('CREATE TABLE sync_resource_limits (singleton INTEGER PRIMARY KEY CHECK(singleton=1), limits TEXT NOT NULL) STRICT')
  db.prepare('INSERT INTO sync_resource_limits VALUES(1,?)').run(JSON.stringify(DEFAULT_RESOURCES))
}
export function resourceUsage(db) {
  const operations=db.prepare('SELECT count(*) AS count,coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes FROM sync_operations').get()
  const chunks=db.prepare('SELECT count(*) AS count,coalesce(sum(length(bytes)),0) AS bytes FROM sync_chunks').get()
  const attachments=db.prepare('SELECT coalesce(sum(length(bytes)),0) AS bytes FROM attachments').get()
  return {operationBytes:operations.bytes,operations:operations.count,chunkBytes:chunks.bytes,chunks:chunks.count,attachmentBytes:attachments.bytes}
}
export function resourceLimits(db) {
  const limits=JSON.parse(db.prepare('SELECT limits FROM sync_resource_limits WHERE singleton=1').get().limits)
  validateLimits(limits)
  return limits
}
function validateLimits(limits) {
  if(!limits || Object.keys(limits).sort().join(',')!==Object.keys(DEFAULT_RESOURCES).sort().join(','))throw new Error('Invalid sync resource limits')
  for(const [key,max] of Object.entries(DEFAULT_RESOURCES))if(!Number.isSafeInteger(limits[key])||limits[key]<1||limits[key]>max)throw new Error('Invalid sync resource limits')
}
export function checkResources(db, additions={}) {
  const limits=resourceLimits(db),usage=resourceUsage(db)
  for(const key of Object.keys(limits))if(usage[key]+(additions[key]??0)>limits[key])throw new Error(`Sync resource limit: ${key}; retain history and export a backup`)
}
export function configureResources(db, limits) {
  validateLimits(limits)
  const usage=resourceUsage(db)
  for(const key of Object.keys(limits))if(limits[key]<usage[key])throw new Error('Resource limit is below retained usage')
  db.prepare('UPDATE sync_resource_limits SET limits=? WHERE singleton=1').run(JSON.stringify(limits))
  return limits
}
export function retentionReport(db,noteId) {
  identifier(noteId)
  if(!db.prepare('SELECT id FROM notes WHERE id=?').get(noteId))throw new Error('Note not found')
  const history=db.prepare('SELECT count(*) AS operations,coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes,sum(CASE WHEN applied=0 THEN 1 ELSE 0 END) AS waiting FROM sync_operations WHERE note_id=?').get(noteId)
  const targets=db.prepare("SELECT t.id,t.epoch,count(o.id) AS operations,coalesce(sum(CASE WHEN d.state='acknowledged' THEN 1 ELSE 0 END),0) AS acknowledged FROM sync_targets t LEFT JOIN sync_delivery d ON d.target_id=t.id LEFT JOIN sync_operations o ON o.id=d.operation_id AND o.note_id=? GROUP BY t.id,t.epoch").all(noteId)
  // Count acknowledgements for this note only, including targets with zero rows.
  for(const target of targets)target.acknowledged=db.prepare("SELECT count(*) AS count FROM sync_delivery d JOIN sync_operations o ON o.id=d.operation_id WHERE d.target_id=? AND o.note_id=? AND d.state='acknowledged'").get(target.id,noteId).count
  const unresolved=db.prepare('SELECT count(*) AS count FROM (SELECT id FROM sync_conflicts WHERE note_id=? UNION SELECT id FROM sync_structures WHERE note_id=?) c WHERE NOT EXISTS(SELECT 1 FROM sync_resolutions r WHERE r.conflict_id=c.id)').get(noteId,noteId).count
  return {policy:'retain-all-evidence',noteId,history,targets,unresolvedConflicts:unresolved,safeToDeleteOperations:0,
    reasons:['causal-history','offline-clients-not-enumerated','restored-or-forked-vaults-not-enumerated',...(unresolved?['unresolved-conflict-evidence']:[]),...(targets.some(t=>t.acknowledged<t.operations)?['pending-provider-delivery']:[]),...(history.waiting?['missing-causal-history']:[])],
    perNoteLimits:{bytes:MAX_HISTORY_BYTES,operations:MAX_HISTORY_OPERATIONS},usage:resourceUsage(db),limits:resourceLimits(db)}
}
