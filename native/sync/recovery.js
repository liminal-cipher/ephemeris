import { canonical, hash, graph, reconcile, validateSnapshot, equal, fields } from './protocol.js'

export const RECOVERY_TABLES=['sync_projection','sync_structures','sync_resolutions','sync_dependencies']
export function migrateRecovery(store) {
  store.db.exec(`
    CREATE TABLE sync_projection (note_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, heads TEXT NOT NULL, parent_id TEXT, deleted INTEGER NOT NULL, recovery INTEGER NOT NULL, writers TEXT NOT NULL) STRICT;
    CREATE TABLE sync_structures (id TEXT PRIMARY KEY, note_id TEXT NOT NULL, payload TEXT NOT NULL) STRICT;
    CREATE TABLE sync_resolutions (operation_id TEXT NOT NULL REFERENCES sync_operations(id), conflict_id TEXT NOT NULL, PRIMARY KEY(operation_id,conflict_id)) STRICT;
    CREATE TABLE sync_dependencies (operation_id TEXT NOT NULL REFERENCES sync_operations(id), parent_id TEXT NOT NULL, PRIMARY KEY(operation_id,parent_id)) STRICT;
    CREATE INDEX sync_dependencies_parent ON sync_dependencies(parent_id);
    CREATE INDEX sync_operations_note ON sync_operations(note_id,applied);
    CREATE INDEX sync_operations_waiting ON sync_operations(applied,sequence,id);
    CREATE INDEX sync_delivery_pending ON sync_delivery(target_id,state,retry_at);
    CREATE INDEX sync_projection_parent ON sync_projection(parent_id);
    PRAGMA user_version=3;
  `)
  for(const row of store.db.prepare('SELECT id,payload FROM sync_operations').iterate()) {
    const op=JSON.parse(row.payload)
    for(const id of [...new Set([...op.parents,...(op.resolution?.references??[])])])store.db.prepare('INSERT INTO sync_dependencies VALUES(?,?)').run(op.id,id)
  }
  for (const {id} of store.db.prepare('SELECT id FROM notes ORDER BY id').iterate()) cacheProjection(store,id)
  projectHierarchy(store)
}

export function cacheProjection(store,id) {
  const ops=store.operations(id),result=reconcile(ops)
  if (!result.snapshot) return
  const writers=projectionWriters(ops,result.heads)
  const s=result.snapshot
  store.db.prepare('INSERT INTO sync_projection VALUES(?,?,?,?,?,?,?) ON CONFLICT(note_id) DO UPDATE SET snapshot=excluded.snapshot,heads=excluded.heads,parent_id=excluded.parent_id,deleted=excluded.deleted,recovery=excluded.recovery,writers=excluded.writers')
    .run(id,canonical(s),canonical(result.heads),s.metadata.parentId??null,Number(s.deleted!==null),Number(s.recovery),canonical(writers))
  for (const c of result.conflicts) store.db.prepare('INSERT OR IGNORE INTO sync_conflicts VALUES(?,?,?)').run(c.id,c.noteId,canonical(c))
}

export function projectionWriters(ops,heads) {
  const writers={}
  const linear=heads.length===1&&ops.every(op=>op.parents.length<=1)
  const ancestors=linear?null:graph(ops).ancestors,map=new Map(ops.map(op=>[op.id,op]))
  for (const field of ['meta:parentId','deleted']) {
    if(linear){let op=map.get(heads[0]);while(op&&!op.writes.includes(field))op=map.get(op.parents[0]);writers[field]=op?[op.id]:[]}
    else {
      const entries=ops.filter(op=>op.writes.includes(field))
      writers[field]=entries.filter(op=>!entries.some(other=>ancestors.get(other.id).has(op.id))).map(op=>op.id).sort()
    }
  }
  return writers
}

// Only hierarchy summaries are scanned across notes; document/attachment BLOBs
// are loaded for changed projections. All related changes share one transaction.
export function hierarchy(rows) {
  const map=new Map(rows.map(row=>[row.note_id,row])), invalid=new Map()
  const mark=(row,reason,affected)=>{
    const operations=[...new Set(affected.flatMap(id=>{
      const item=map.get(id)
      return item?Object.values(JSON.parse(item.writers)).flat():[]
    }))].sort()
    const field='structure:'+reason
    invalid.set(row.note_id,{id:hash({noteId:row.note_id,field,ids:operations}),noteId:row.note_id,field,operations,status:'unresolved',reason,affected:[...affected].sort(),requestedParent:row.parent_id,temporaryParent:null})
  }
  for (const row of rows) {
    if (!row.parent_id) continue
    const parent=map.get(row.parent_id)
    if (!parent) mark(row,'missing-parent',[row.note_id,row.parent_id])
    else if (parent.deleted || parent.recovery) mark(row,'unavailable-parent',[row.note_id,row.parent_id])
  }
  const done=new Set()
  for (const row of rows) {
    const chain=[],positions=new Map();let current=row.note_id
    while (map.has(current) && !done.has(current) && !invalid.has(current)) {
      if (positions.has(current)) {
        const cycle=chain.slice(positions.get(current))
        for(const id of cycle)mark(map.get(id),'cycle',cycle)
        break
      }
      positions.set(current,chain.length);chain.push(current);current=map.get(current).parent_id
    }
    chain.forEach(id=>done.add(id))
  }
  return invalid
}

export function projectHierarchy(store,changed=[]) {
  const rows=store.db.prepare('SELECT note_id,parent_id,deleted,recovery,writers FROM sync_projection ORDER BY note_id').all()
  const invalid=hierarchy(rows),actual=new Map(store.db.prepare("SELECT id,json_extract(metadata,'$.parentId') AS parent_id FROM notes").all().map(row=>[row.id,row.parent_id]))
  const updates=new Set(changed)
  for (const row of rows) if (!actual.has(row.note_id) || actual.get(row.note_id)!==(invalid.has(row.note_id)?null:row.parent_id)) updates.add(row.note_id)
  for (const c of invalid.values()) store.db.prepare('INSERT OR IGNORE INTO sync_structures VALUES(?,?,?)').run(c.id,c.noteId,canonical(c))
  // The safe tree has already been validated as a whole; apply can bypass the
  // per-note check against the obsolete intermediate tree, never the final tree.
  for (const id of updates) {
    const s=JSON.parse(store.db.prepare('SELECT snapshot FROM sync_projection WHERE note_id=?').get(id).snapshot)
    if(invalid.has(id))s.metadata.parentId=null
    store.apply(s,true)
  }
  return [...invalid.values()]
}

export function requested(store,id) {
  const row=store.db.prepare('SELECT snapshot,heads FROM sync_projection WHERE note_id=?').get(id)
  if(!row)throw new Error('Sync projection not found')
  return {snapshot:JSON.parse(row.snapshot),heads:JSON.parse(row.heads)}
}

export function conflictViews(store,noteId) {
  const raw=[...store.db.prepare('SELECT payload FROM sync_conflicts WHERE note_id=?').all(noteId),...store.db.prepare('SELECT payload FROM sync_structures WHERE note_id=?').all(noteId)].map(row=>JSON.parse(row.payload))
  return raw.map(c=>{
    const resolutions=store.db.prepare('SELECT operation_id FROM sync_resolutions WHERE conflict_id=? ORDER BY operation_id').all(c.id).map(row=>row.operation_id)
    return {...c,status:resolutions.length?'resolved':'unresolved',resolutions}
  })
}

export function resolutionSnapshot(store,noteId,conflictId,decision,expected) {
  const current=requested(store,noteId)
  if (!expected || !equal(expected.heads,current.heads)) throw new Error('Stale resolution decision')
  const conflict=conflictViews(store,noteId).find(c=>c.id===conflictId)
  if (!conflict || conflict.status!=='unresolved') throw new Error('Unresolved conflict not found')
  const field=conflict.field.startsWith('structure:')?'meta:parentId':conflict.field==='delete-versus-edit'?'deleted':conflict.field
  if (!(field.startsWith('meta:') || field.startsWith('attachment:') || ['deleted','document'].includes(field))) throw new Error('Unsupported resolution field')
  if (!decision || Object.keys(decision).length!==1 || !['operationId','value'].includes(Object.keys(decision)[0])) throw new Error('Explicit resolution choice required')
  let value=decision.value
  if(Object.hasOwn(decision,'operationId')) {
    if(!conflict.operations.includes(decision.operationId))throw new Error('Version is not a competitor')
    const selected=store.retained(decision.operationId).snapshot
    if(selected.id!==noteId)throw new Error('Version belongs to another note')
    value=fields(selected)[field]
  }
  const s=structuredClone(current.snapshot)
  if(field.startsWith('meta:'))s.metadata[field.slice(5)]=value
  else if(field.startsWith('attachment:')) {
    if(value?.id!==field.slice(11))throw new Error('Attachment identity must be retained')
    s.attachments=s.attachments.filter(a=>a.id!==value.id);s.attachments.push(value);s.attachments.sort((a,b)=>a.id<b.id?-1:1)
  } else s[field]=value
  validateSnapshot(s)
  if(field==='meta:parentId') {
    const rows=store.db.prepare('SELECT note_id,parent_id,deleted,recovery,writers FROM sync_projection').all()
    const row=rows.find(row=>row.note_id===noteId);row.parent_id=s.metadata.parentId??null
    if(hierarchy(rows).has(noteId))throw new Error('Resolution leaves an invalid hierarchy')
  }
  const raw=store.db.prepare('SELECT payload FROM sync_conflicts WHERE id=? UNION ALL SELECT payload FROM sync_structures WHERE id=?').get(conflictId,conflictId)
  return {snapshot:s,resolution:{conflicts:[conflictId],references:conflict.operations,fields:[field],evidence:[JSON.parse(raw.payload)]}}
}
