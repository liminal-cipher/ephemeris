import { randomUUID } from 'node:crypto'
import { identifier, jsonValue } from '../validation.js'
import { canonical, equal, hash, changedFields, expectedWrites, validateOperation, graph, reconcile } from './protocol.js'
import { cacheProjection, projectHierarchy, requested, conflictViews, resolutionSnapshot, hierarchy, RECOVERY_TABLES, projectionWriters } from './recovery.js'
import { MAX_PAGE_BYTES, MAX_HISTORY_BYTES, MAX_HISTORY_OPERATIONS, MAX_APPLY_OPERATIONS, byteLimit, pageBytes } from './limits.js'

export const SYNC_TABLES = ['sync_identity','sync_operations','sync_targets','sync_delivery','sync_conflicts']
export function migrateSync(db) {
  db.exec(`
    CREATE TABLE sync_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), vault_id TEXT NOT NULL, client_id TEXT NOT NULL) STRICT;
    CREATE TABLE sync_operations (id TEXT PRIMARY KEY, note_id TEXT NOT NULL, client_id TEXT NOT NULL, sequence INTEGER NOT NULL, payload TEXT NOT NULL, applied INTEGER NOT NULL CHECK(applied IN(0,1)), UNIQUE(client_id,sequence)) STRICT;
    CREATE TABLE sync_targets (id TEXT PRIMARY KEY, epoch TEXT NOT NULL, cursor TEXT NOT NULL DEFAULT 'null') STRICT;
    CREATE TABLE sync_delivery (target_id TEXT NOT NULL REFERENCES sync_targets(id), operation_id TEXT NOT NULL REFERENCES sync_operations(id), state TEXT NOT NULL CHECK(state IN('pending','retry','acknowledged')), attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(target_id,operation_id)) STRICT;
    CREATE TABLE sync_conflicts (id TEXT PRIMARY KEY, note_id TEXT NOT NULL, payload TEXT NOT NULL) STRICT;
    PRAGMA user_version=2;
  `)
  db.prepare('INSERT INTO sync_identity VALUES(1,?,?)').run(randomUUID(),randomUUID())
}

// All mutations are called inside a NativeVault transaction; no connection is
// exported to providers. Immutable operation snapshots are recovery history.
export class SyncStore {
  constructor(db, read, apply) { this.db=db; this.read=read; this.apply=apply }
  get recoveryEnabled() { return this.db.prepare('PRAGMA user_version').get().user_version===3 }
  identity() { const row=this.db.prepare('SELECT * FROM sync_identity WHERE singleton=1').get(); return { vaultId:row.vault_id, clientId:row.client_id } }
  forkClient() { this.db.prepare('UPDATE sync_identity SET client_id=? WHERE singleton=1').run(randomUUID()); return this.identity() }
  operations(noteId) {
    if(this.recoveryEnabled) {
      const size=this.db.prepare('SELECT count(*) AS count,coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes FROM sync_operations WHERE note_id=? AND applied=1').get(noteId)
      if(size.count>MAX_HISTORY_OPERATIONS || size.bytes>MAX_HISTORY_BYTES)throw new Error('Sync history resource limit; retain backup and use recovery tooling')
    }
    return this.db.prepare('SELECT payload FROM sync_operations WHERE note_id=? AND applied=1 ORDER BY id').all(noteId).map(row=>JSON.parse(row.payload))
  }
  record(noteId, sequence, {parentIntent=false}={}) {
    const operations=this.operations(noteId), baseline=reconcile(operations), s=this.read(noteId)
    if(this.recoveryEnabled && baseline.snapshot && !parentIntent)s.metadata.parentId=baseline.snapshot.metadata.parentId
    const body={ protocol:1, id:randomUUID(), ...this.identity(), sequence, parents:baseline.heads, snapshot:s, writes:changedFields(baseline.snapshot,s) }
    const op={...body,sha256:hash(body)}
    this.insert(op,1)
    if(this.recoveryEnabled){cacheProjection(this,noteId);projectHierarchy(this,[noteId])}
  }
  insert(op,applied) {
    validateOperation(op)
    const old=this.db.prepare('SELECT payload FROM sync_operations WHERE id=?').get(op.id)
    if (old) { if (!equal(JSON.parse(old.payload),op)) throw new Error('Operation identity reused'); return false }
    if(op.protocol===2 && !this.recoveryEnabled)throw new Error('Resolution requires explicit schema 3 upgrade')
    if(this.recoveryEnabled) {
      const size=this.db.prepare('SELECT count(*) AS count,coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes FROM sync_operations WHERE note_id=?').get(op.snapshot.id)
      if(size.count>=MAX_HISTORY_OPERATIONS || size.bytes+Buffer.byteLength(canonical(op))>MAX_HISTORY_BYTES)throw new Error('Sync history resource limit; operation not committed')
    }
    this.db.prepare('INSERT INTO sync_operations VALUES(?,?,?,?,?,?)').run(op.id,op.snapshot.id,op.clientId,op.sequence,canonical(op),applied)
    if(this.recoveryEnabled)for(const id of [...new Set([...op.parents,...(op.resolution?.references??[])])])this.db.prepare('INSERT INTO sync_dependencies VALUES(?,?)').run(op.id,id)
    this.db.prepare("INSERT INTO sync_delivery(target_id,operation_id,state) SELECT id,?,'pending' FROM sync_targets").run(op.id)
    return true
  }
  target(id) {
    identifier(id)
    const row=this.db.prepare('SELECT * FROM sync_targets WHERE id=?').get(id)
    if (!row) throw new Error('Sync target not configured')
    return {...row,cursor:JSON.parse(row.cursor)}
  }
  connect(id,epoch) {
    identifier(id); identifier(epoch)
    const old=this.db.prepare('SELECT * FROM sync_targets WHERE id=?').get(id)
    if (old && old.epoch!==epoch) throw new Error('Remote epoch changed; explicit recovery required')
    if (!old) {
      this.db.prepare('INSERT INTO sync_targets(id,epoch) VALUES(?,?)').run(id,epoch)
      this.db.prepare("INSERT INTO sync_delivery(target_id,operation_id,state) SELECT ?,id,'pending' FROM sync_operations").run(id)
    }
    return this.target(id)
  }
  pending(id,now,limit,maxBytes=MAX_PAGE_BYTES) {
    this.target(id)
    byteLimit(maxBytes)
    if (!Number.isSafeInteger(now) || now<0 || !Number.isSafeInteger(limit) || limit<1 || limit>100) throw new Error('Invalid sync bounds')
    const result=[];let bytes=0
    for(const row of this.db.prepare("SELECT o.id,length(CAST(o.payload AS BLOB)) AS bytes FROM sync_operations o JOIN sync_delivery d ON d.operation_id=o.id WHERE d.target_id=? AND d.state!='acknowledged' AND d.retry_at<=? AND o.applied=1 ORDER BY o.sequence,o.id LIMIT ?").iterate(id,now,limit)) {
      if(bytes+row.bytes>maxBytes){if(!result.length)throw new Error('Operation exceeds sync byte budget');break}
      result.push(this.retained(row.id));bytes+=row.bytes
    }
    return result
  }
  acknowledge(id,opId,sha256) {
    this.target(id); identifier(opId)
    const row=this.db.prepare('SELECT payload FROM sync_operations WHERE id=?').get(opId)
    if (!row || JSON.parse(row.payload).sha256!==sha256) throw new Error('Invalid provider acknowledgement')
    this.db.prepare("UPDATE sync_delivery SET state='acknowledged',retry_at=0 WHERE target_id=? AND operation_id=?").run(id,opId)
  }
  retry(id,opId,now) {
    this.target(id); identifier(opId)
    if (!Number.isSafeInteger(now) || now<0 || now>Number.MAX_SAFE_INTEGER-60000) throw new Error('Invalid retry time')
    const row=this.db.prepare('SELECT * FROM sync_delivery WHERE target_id=? AND operation_id=?').get(id,opId)
    if (!row) throw new Error('Unknown delivery')
    if (row.state==='acknowledged') return
    const attempts=Math.min(row.attempts+1,30), retryAt=now+Math.min(60000,1000*2**Math.min(attempts-1,6))
    this.db.prepare("UPDATE sync_delivery SET state='retry',attempts=?,retry_at=? WHERE target_id=? AND operation_id=?").run(attempts,retryAt,id,opId)
  }
  receive(id,expectedCursor,page) {
    const target=this.target(id)
    if (!equal(target.cursor,expectedCursor)) throw new Error('Stale sync cursor')
    if (!page || page.epoch!==target.epoch || !Array.isArray(page.operations) || page.operations.length>100 || typeof page.hasMore!=='boolean' || !Object.hasOwn(page,'cursor')) throw new Error('Invalid sync page')
    pageBytes(page)
    const cursor=jsonValue(page.cursor)
    if (cursor.length>4096 || (page.hasMore && equal(page.cursor,expectedCursor))) throw new Error('Invalid sync cursor')
    page.operations.forEach(validateOperation)
    for (const op of page.operations) { this.insert(op,0); this.acknowledge(id,op.id,op.sha256) }
    // Missing ancestors may arrive later, but known cross-note edges and cycles
    // are invalid, not indefinitely retryable dependencies.
    const known=new Map()
    const get=id=>{
      if(known.has(id))return known.get(id)
      const row=this.db.prepare("SELECT id,note_id,json_extract(payload,'$.parents') AS parents FROM sync_operations WHERE id=?").get(id)
      const op=row?{id:row.id,snapshot:{id:row.note_id},parents:JSON.parse(row.parents)}:null
      known.set(id,op);return op
    }
    const complete=new Set(),visiting=new Set()
    const check=op=>{
      if (complete.has(op.id)) return
      if (visiting.has(op.id)) throw new Error('Cyclic remote operations')
      visiting.add(op.id)
      for (const id of op.parents) if (get(id)) {
        const parent=get(id)
        if (parent.snapshot.id!==op.snapshot.id) throw new Error('Cross-note causal parent')
        check(parent)
      }
      visiting.delete(op.id);complete.add(op.id)
    }
    for(const op of page.operations)check(get(op.id))
    let progress=true, applied=0
    const changed=new Set()
    while (progress && applied<MAX_APPLY_OPERATIONS) {
      progress=false
      const candidates=this.recoveryEnabled?this.db.prepare('SELECT o.id FROM sync_operations o WHERE o.applied=0 AND NOT EXISTS(SELECT 1 FROM sync_dependencies d LEFT JOIN sync_operations p ON p.id=d.parent_id WHERE d.operation_id=o.id AND (p.id IS NULL OR p.applied=0)) ORDER BY o.sequence,o.id LIMIT ?').all(MAX_APPLY_OPERATIONS-applied):this.db.prepare('SELECT id FROM sync_operations WHERE applied=0 ORDER BY sequence,id').all()
      for (const candidate of candidates) {
        const row=this.db.prepare('SELECT payload FROM sync_operations WHERE id=?').get(candidate.id)
        if(applied>=MAX_APPLY_OPERATIONS)break
        const op=JSON.parse(row.payload), all=this.operations(op.snapshot.id), byId=new Map(all.map(item=>[item.id,item]))
        if (op.parents.some(parent=>!byId.has(parent))) continue
        const ancestry=new Set(), visit=parent=>{ if (ancestry.has(parent)) return; ancestry.add(parent); byId.get(parent).parents.forEach(visit) }
        op.parents.forEach(visit)
        const baseline=reconcile(all.filter(item=>ancestry.has(item.id)))
        if(op.resolution?.references.some(id=>!this.db.prepare('SELECT id FROM sync_operations WHERE id=? AND applied=1').get(id)))continue
        if (!equal(expectedWrites(baseline.snapshot,op),op.writes)) throw new Error('Invalid operation baseline')
        const result=reconcile([...all,op])
        const parent=result.snapshot.metadata.parentId
        if (!this.recoveryEnabled && parent && !this.db.prepare('SELECT id FROM notes WHERE id=?').get(parent)) continue
        if(!this.recoveryEnabled)this.apply(result.snapshot)
        this.db.prepare('UPDATE sync_operations SET applied=1 WHERE id=?').run(op.id)
        if(this.recoveryEnabled) {
          cacheProjection(this,op.snapshot.id)
          changed.add(op.snapshot.id)
          for(const c of op.resolution?.evidence??[]) {
            const table=c.field.startsWith('structure:')?'sync_structures':'sync_conflicts'
            this.db.prepare(`INSERT OR IGNORE INTO ${table} VALUES(?,?,?)`).run(c.id,c.noteId,canonical(c))
          }
          for(const id of op.resolution?.conflicts??[])this.db.prepare('INSERT OR IGNORE INTO sync_resolutions VALUES(?,?)').run(op.id,id)
        }
        for (const conflict of result.conflicts) this.db.prepare('INSERT OR IGNORE INTO sync_conflicts VALUES(?,?,?)').run(conflict.id,conflict.noteId,canonical(conflict))
        progress=true; applied++
      }
    }
    if(this.recoveryEnabled && applied)projectHierarchy(this,[...changed])
    this.db.prepare('UPDATE sync_targets SET cursor=? WHERE id=?').run(cursor,id)
    return { applied, waiting:this.db.prepare('SELECT count(*) AS count FROM sync_operations WHERE applied=0').get().count, moreWork:applied>=MAX_APPLY_OPERATIONS }
  }
  status(id) {
    return { ...this.target(id), deliveries:this.db.prepare('SELECT operation_id,state,attempts,retry_at FROM sync_delivery WHERE target_id=? ORDER BY operation_id').all(id), waiting:this.db.prepare('SELECT count(*) AS count FROM sync_operations WHERE applied=0').get().count }
  }
  conflicts(noteId) {
    identifier(noteId)
    if(this.recoveryEnabled)return conflictViews(this,noteId)
    return this.db.prepare('SELECT payload FROM sync_conflicts WHERE note_id=? ORDER BY id').all(noteId).map(row=>JSON.parse(row.payload))
  }
  retained(id) {
    identifier(id)
    const row=this.db.prepare('SELECT payload FROM sync_operations WHERE id=?').get(id)
    if (!row) throw new Error('Operation not found')
    return JSON.parse(row.payload)
  }
  resolve(noteId,conflictId,decision,expected,sequence) {
    const result=resolutionSnapshot(this,noteId,conflictId,decision,expected)
    const base=requested(this,noteId)
    const body={protocol:2,id:randomUUID(),...this.identity(),sequence,parents:base.heads,snapshot:result.snapshot,resolution:result.resolution}
    body.writes=expectedWrites(base.snapshot,body)
    const op={...body,sha256:hash(body)}
    this.insert(op,1)
    for(const id of body.resolution.conflicts)this.db.prepare('INSERT INTO sync_resolutions VALUES(?,?)').run(op.id,id)
    cacheProjection(this,noteId);projectHierarchy(this,[noteId])
    return op.id
  }
}

export function verifySync(db,add) {
  const recovery=db.prepare('PRAGMA user_version').get().user_version===3
  const invalid=recovery?hierarchy(db.prepare('SELECT note_id,parent_id,deleted,recovery,writers FROM sync_projection').all()):new Map()
  for (const table of SYNC_TABLES) db.prepare(`SELECT * FROM ${table} LIMIT 0`).all()
  const identity=db.prepare('SELECT * FROM sync_identity').all()
  if (identity.length!==1) throw new Error('Invalid sync identity')
  identifier(identity[0].vault_id); identifier(identity[0].client_id)
  const perNote=new Map()
  for (const row of db.prepare('SELECT * FROM sync_operations ORDER BY id').all()) {
    const op=validateOperation(JSON.parse(row.payload))
    if (op.id!==row.id || op.snapshot.id!==row.note_id || op.clientId!==row.client_id || op.sequence!==row.sequence) throw new Error('Invalid stored sync operation')
    if (row.applied) { if (!perNote.has(row.note_id)) perNote.set(row.note_id,[]); perNote.get(row.note_id).push(op) }
  }
  for (const ops of perNote.values()) {
    const {ancestors}=graph(ops)
    for (const op of ops) {
      const baseline=reconcile(ops.filter(other=>ancestors.get(op.id).has(other.id))).snapshot
      if (!equal(expectedWrites(baseline,op),op.writes)) throw new Error('Invalid stored sync baseline')
    }
    const expected=reconcile(ops).snapshot
    if(recovery) {
      const cached=db.prepare('SELECT * FROM sync_projection WHERE note_id=?').get(expected.id),heads=graph(ops).heads
      if(!cached || !equal(JSON.parse(cached.snapshot),expected) || !equal(JSON.parse(cached.heads),heads) || !equal(JSON.parse(cached.writers),projectionWriters(ops,heads)) || cached.parent_id!==(expected.metadata.parentId??null) || cached.deleted!==Number(expected.deleted!==null) || cached.recovery!==Number(expected.recovery))throw new Error('Invalid recovery projection')
      if(invalid.has(expected.id))expected.metadata.parentId=null
    }
    const note=db.prepare('SELECT * FROM notes WHERE id=?').get(expected.id)
    if (!note) throw new Error('Missing synchronised note')
    const actual={id:note.id,metadata:JSON.parse(note.metadata),document:Buffer.from(note.document).toString('base64'),deleted:note.deleted===null?null:JSON.parse(note.deleted),recovery:Boolean(note.recovery),legacyRecords:JSON.parse(note.legacy),contentState:note.content_state,
      attachments:db.prepare('SELECT * FROM attachments WHERE note_id=? ORDER BY id').all(note.id).map(a=>({id:a.id,metadata:JSON.parse(a.metadata),bytes:Buffer.from(a.bytes).toString('base64'),sha256:a.sha256})).sort((a,b)=>a.id<b.id?-1:1)}
    if (!equal(actual,expected)) throw new Error('Sync materialisation integrity failure')
  }
  if (perNote.size!==db.prepare('SELECT count(*) AS count FROM notes').get().count) throw new Error('Missing sync baseline')
  for (const row of db.prepare('SELECT * FROM sync_targets').all()) {
    identifier(row.id); identifier(row.epoch)
    if (jsonValue(JSON.parse(row.cursor)).length>4096) throw new Error('Invalid stored cursor')
  }
  for (const row of db.prepare('SELECT * FROM sync_delivery').all()) {
    if (!Number.isSafeInteger(row.attempts) || row.attempts<0 || row.attempts>30 || !Number.isSafeInteger(row.retry_at) || row.retry_at<0) throw new Error('Invalid stored delivery')
  }
  for (const row of db.prepare('SELECT * FROM sync_conflicts').all()) {
    const c=JSON.parse(row.payload)
    if (c.id!==row.id || c.noteId!==row.note_id || c.status!=='unresolved' || hash({noteId:c.noteId,field:c.field,ids:c.operations})!==c.id) throw new Error('Invalid stored conflict')
    for (const id of c.operations) if (!db.prepare('SELECT id FROM sync_operations WHERE id=? AND note_id=?').get(id,c.noteId)) throw new Error('Missing conflict version')
  }
  for (const table of SYNC_TABLES) for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()) add(row)
  if(recovery) {
    for(const row of db.prepare('SELECT * FROM sync_structures').all()) {
      const c=JSON.parse(row.payload)
      if(c.id!==row.id || c.noteId!==row.note_id || hash({noteId:c.noteId,field:c.field,ids:c.operations})!==c.id)throw new Error('Invalid structural conflict')
      for(const id of c.operations)if(!db.prepare('SELECT id FROM sync_operations WHERE id=?').get(id))throw new Error('Missing structural evidence')
    }
    for(const row of db.prepare('SELECT * FROM sync_resolutions').all()) {
      const op=JSON.parse(db.prepare('SELECT payload FROM sync_operations WHERE id=?').get(row.operation_id).payload)
      if(!op.resolution?.conflicts.includes(row.conflict_id))throw new Error('Invalid resolution record')
    }
    for(const row of db.prepare('SELECT id,payload FROM sync_operations').iterate()) {
      const op=JSON.parse(row.payload),expected=[...new Set([...op.parents,...(op.resolution?.references??[])])].sort()
      const actual=db.prepare('SELECT parent_id FROM sync_dependencies WHERE operation_id=? ORDER BY parent_id').all(op.id).map(row=>row.parent_id).sort()
      if(!equal(actual,expected))throw new Error('Invalid dependency index')
    }
    for(const table of RECOVERY_TABLES)for(const row of db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).iterate())add(row)
  }
}
