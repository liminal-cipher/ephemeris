import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, realpathSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import * as Y from 'yjs'
import { NativeVault } from '../vault.js'
import { SimulatedProvider } from '../sync/simulatedProvider.js'
import { synchronise } from '../sync/engine.js'
import { hash, canonical } from '../sync/protocol.js'
import { restoreNativeBackup, verifyBackup } from '../backup.js'
import { browserBackup } from './fixtures.js'
import { startCompanion } from '../companion.js'

function setup(t,{enabled=true}={}) {
  const root=mkdtempSync(path.join(realpathSync(tmpdir()),'ephemeris-sync-')), handles=[]
  const open=name=>{ const v=NativeVault.open(path.join(root,name)); handles.push(v); return v }
  const create=name=>{ const v=NativeVault.create(path.join(root,name)); handles.push(v); if(enabled) v.enableSync(); return v }
  const a=create('a'),b=create('b'),p=new SimulatedProvider()
  t.after(()=>{handles.forEach(v=>v.close()); rmSync(root,{recursive:true,force:true})})
  const sync=v=>synchronise(v,p,{now:()=>1000000})
  const converge=async()=>{for(let i=0;i<3;i++){await sync(a);await sync(b)}}
  return {a,b,p,root,open,create,sync,converge}
}
const view=v=>v.list({includeDeleted:true,includeRecovery:true}).map(({version:_version,...note})=>({...note,attachments:v.listAttachments(note.id).map(a=>v.readAttachment(note.id,a.id))}))
function editText(v,text) {const n=v.read('n'),doc=new Y.Doc(); Y.applyUpdate(doc,n.document); doc.getText('body').insert(doc.getText('body').length,text); v.update('n',{document:Y.encodeStateAsUpdate(doc)},n);doc.destroy()}
function body(v) {const d=new Y.Doc();Y.applyUpdate(d,v.read('n').document);const s=d.getText('body').toString();d.destroy();return s}
async function seed(f) {f.a.create({id:'n',metadata:{title:'base'}});await f.converge()}

test('two independent Vaults exchange creates and edits, reopen, and idle sync never mutates',async t=>{
  const f=setup(t);await seed(f)
  assert.notDeepEqual(f.a.syncIdentity(),f.b.syncIdentity())
  f.b.rename('n','from B',f.b.read('n'));await f.converge()
  assert.equal(f.a.read('n').metadata.title,'from B')
  const count=f.a.changes().length, operations=f.p.exportState().operations.length
  await f.converge();assert.equal(f.a.changes().length,count);assert.equal(f.p.exportState().operations.length,operations)
  f.a.close();f.b.close();assert.deepEqual(view(f.open('a')),view(f.open('b')))
})

test('offline independent fields and compatible Yjs changes merge after reopen',async t=>{
  const f=setup(t);await seed(f)
  f.a.update('n',{metadata:{title:'A'}},f.a.read('n'));f.b.update('n',{metadata:{emoji:'B'}},f.b.read('n'))
  editText(f.a,'alpha');editText(f.b,'한글');await f.converge()
  assert.equal(f.a.read('n').metadata.title,'A');assert.equal(f.a.read('n').metadata.emoji,'B')
  assert.ok(body(f.a).includes('alpha')&&body(f.a).includes('한글'))
  assert.deepEqual(f.a.syncConflicts('n'),[])
  f.a.close();f.b.close();assert.deepEqual(view(f.open('a')),view(f.open('b')))
})

for (const field of ['title','parentId']) test(`concurrent ${field} changes retain both complete versions and converge`,async t=>{
  const f=setup(t);f.a.create({id:'p1'});f.a.create({id:'p2'});await seed(f)
  const values=field==='title'?['left','right']:['p1','p2']
  f.a.update('n',{metadata:{[field]:values[0]}},f.a.read('n'));f.b.update('n',{metadata:{[field]:values[1]}},f.b.read('n'))
  await f.converge();f.a.close();f.b.close();const a=f.open('a'),b=f.open('b')
  assert.deepEqual(view(a),view(b));assert.deepEqual(a.syncConflicts('n'),b.syncConflicts('n'))
  const conflict=a.syncConflicts('n').find(c=>c.field===`meta:${field}`);assert.ok(conflict)
  assert.deepEqual(conflict.operations.map(id=>a.retainedSyncOperation(id).snapshot.metadata[field]).sort(),values.sort())
})

test('delete wins offline edit and restore races; causally later restoration is explicit',async t=>{
  const f=setup(t);await seed(f)
  f.a.delete('n',f.a.read('n'));editText(f.b,'retained edit');await f.converge()
  assert.ok(f.a.read('n').deleted);assert.ok(f.b.read('n').deleted);assert.ok(body(f.a).includes('retained edit'))
  assert.ok(f.a.syncConflicts('n').some(c=>c.field==='delete-versus-edit'))
  f.a.restore('n',f.a.read('n'));f.a.delete('n',f.a.read('n'));f.b.restore('n',f.b.read('n'));await f.converge()
  assert.ok(f.a.read('n').deleted);assert.ok(f.b.read('n').deleted)
  f.b.restore('n',f.b.read('n'));await f.converge();assert.equal(f.a.read('n').deleted,null)
  f.a.close();f.b.close();assert.deepEqual(view(f.open('a')),view(f.open('b')))
})

test('attachments transfer exactly; concurrent identity collisions retain both byte sequences',async t=>{
  const f=setup(t);await seed(f)
  f.a.putAttachment('n',{id:'image',bytes:new Uint8Array([1,2,255]),metadata:{type:'image/png'}},f.a.read('n'))
  f.b.putAttachment('n',{id:'image',bytes:new Uint8Array([8,9])},f.b.read('n'))
  // SQLite UTF-8 ordering differs from JavaScript UTF-16 for these IDs.
  for (const id of ['\u{1f600}','\ue000']) f.a.putAttachment('n',{id,bytes:new Uint8Array([42])},f.a.read('n'))
  await f.converge();f.a.close();f.b.close();const a=f.open('a'),b=f.open('b')
  assert.deepEqual(view(a),view(b))
  const c=a.syncConflicts('n').find(c=>c.field==='attachment:image');assert.ok(c)
  assert.equal(new Set(c.operations.map(id=>a.retainedSyncOperation(id).snapshot.attachments.find(a=>a.id==='image').sha256)).size,2)
  a.verify();b.verify()
})

test('duplicate and reversed pages persist dependencies before cursor and drain after reopen',async t=>{
  const f=setup(t);f.a.create({id:'n'});f.a.rename('n','second',f.a.read('n'));await f.sync(f.a)
  const ops=f.p.exportState().operations, target='reordered',epoch='one'
  f.b.connectSync(target,epoch)
  assert.equal(f.b.receiveSync(target,null,{epoch,operations:[ops[1],ops[1]],cursor:1,hasMore:true}).waiting,1)
  assert.equal(f.b.list().length,0);f.b.close();const b=f.open('b')
  assert.equal(b.syncStatus(target).cursor,1)
  assert.equal(b.receiveSync(target,1,{epoch,operations:[ops[0]],cursor:2,hasMore:false}).waiting,0)
  assert.equal(b.read('n').metadata.title,'second');const count=b.changes().length
  b.receiveSync(target,2,{epoch,operations:ops,cursor:3,hasMore:false});assert.equal(b.changes().length,count)
  assert.throws(()=>b.receiveSync(target,2,{epoch,operations:[],cursor:4,hasMore:false}),/Stale/)
})

test('interrupted acceptance retries same operation, bounds backoff and preserves local editing',async t=>{
  const f=setup(t);f.a.create({id:'n'});f.p.failNext('afterAccept')
  await assert.rejects(synchronise(f.a,f.p,{now:()=>0}),/disconnection/)
  assert.equal(f.p.exportState().operations.length,1)
  assert.equal(f.a.syncStatus(f.p.id).deliveries[0].state,'retry')
  f.a.close();const a=f.open('a');assert.equal(a.pendingSync(f.p.id,{now:999}).length,0)
  await synchronise(a,f.p,{now:()=>1000});assert.equal(f.p.exportState().operations.length,1)
  a.rename('n','offline edit',a.read('n'));const op=a.pendingSync(f.p.id,{now:1000})[0]
  for(let i=0;i<40;i++) a.retrySync(f.p.id,op.id,1000)
  assert.equal(a.syncStatus(f.p.id).deliveries.find(d=>d.operation_id===op.id).retry_at,61000)
  assert.equal(a.read('n').metadata.title,'offline edit')
})

test('download interruption, unavailable and empty remote never delete local notes',async t=>{
  const f=setup(t);await seed(f);const before=view(f.a)
  f.p.failNext('beforePull');await assert.rejects(f.sync(f.a),/disconnection/)
  f.p.failNext('info');await assert.rejects(f.sync(f.a),/disconnection/)
  const empty=new SimulatedProvider({id:'empty'});await synchronise(f.a,empty)
  assert.deepEqual(view(f.a),before)
  const cursor=f.a.syncStatus(f.p.id).cursor;f.p.reset('generation-2')
  await assert.rejects(f.sync(f.a),/epoch changed/);assert.deepEqual(f.a.syncStatus(f.p.id).cursor,cursor)
  await assert.rejects(f.p.pull({epoch:'generation-1',offset:999},{epoch:'generation-2'}),/cursor/)
  f.a.close();assert.deepEqual(view(f.open('a')),before)
})

test('invalid remote payload, attachment checksum and acknowledgements fail closed',async t=>{
  const f=setup(t);f.a.create({id:'n'});await f.sync(f.a);const op=f.p.exportState().operations[0]
  f.b.connectSync('bad','one')
  const invalid=structuredClone(op);invalid.snapshot.id='../escape'
  assert.throws(()=>f.b.receiveSync('bad',null,{epoch:'one',operations:[invalid],cursor:1,hasMore:false}),/Invalid identifier/)
  const attachment=structuredClone(op);attachment.snapshot.attachments=[{id:'a',metadata:{},bytes:'AQ==',sha256:'0'.repeat(64)}]
  assert.throws(()=>f.b.receiveSync('bad',null,{epoch:'one',operations:[attachment],cursor:1,hasMore:false}),/Attachment/)
  assert.equal(f.b.syncStatus('bad').cursor,null);assert.deepEqual(f.b.list(),[])
  const liar={info:async()=>({id:'liar',epoch:'one'}),publish:async()=>({id:op.id,sha256:'bad',epoch:'one'})}
  await assert.rejects(synchronise(f.a,liar),/acknowledgement/)
  assert.equal(f.a.syncStatus('liar').deliveries[0].state,'retry')
})

test('outbox and incoming-write failures roll back canonical data and checkpoints',async t=>{
  const f=setup(t);await seed(f)
  const db=new DatabaseSync(path.join(f.root,'a','vault.sqlite'))
  const before=f.a.read('n'),count=f.a.changes().length
  db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON sync_operations BEGIN SELECT RAISE(ABORT,'outbox failure'); END")
  assert.throws(()=>f.a.rename('n','lost',before),/outbox failure/)
  assert.deepEqual(f.a.read('n'),before);assert.equal(f.a.changes().length,count)
  db.exec('DROP TRIGGER fail_outbox');db.close()
  f.a.rename('n','valid',before);await f.sync(f.a)
  const other=new DatabaseSync(path.join(f.root,'b','vault.sqlite'))
  other.exec("CREATE TRIGGER fail_incoming BEFORE UPDATE ON sync_operations BEGIN SELECT RAISE(ABORT,'incoming failure'); END")
  const cursor=f.b.syncStatus(f.p.id).cursor
  await assert.rejects(f.sync(f.b),/incoming failure/)
  assert.equal(f.b.read('n').metadata.title,'base');assert.deepEqual(f.b.syncStatus(f.p.id).cursor,cursor)
  other.exec('DROP TRIGGER fail_incoming');other.close();await f.converge()
  f.a.close();f.b.close();assert.deepEqual(view(f.open('a')),view(f.open('b')))
})

test('schema 1 activation is additive, atomic and compatible with both snapshot versions',async t=>{
  const f=setup(t,{enabled:false});f.a.create({id:'n'});const original=f.a.read('n'),journal=f.a.changes()
  await f.a.exportBackup(path.join(f.root,'v1'))
  const db=new DatabaseSync(path.join(f.root,'a','vault.sqlite'))
  db.exec('CREATE TABLE sync_delivery (collision TEXT)')
  assert.throws(()=>f.a.enableSync(),/already exists/)
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,1)
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='sync_identity'").get().n,0)
  db.exec('DROP TABLE sync_delivery');db.close()
  const identity=f.a.enableSync();assert.deepEqual(f.a.enableSync(),identity)
  assert.deepEqual(f.a.read('n'),original);assert.deepEqual(f.a.changes(),journal)
  await f.a.exportBackup(path.join(f.root,'v2'));assert.equal((await verifyBackup(path.join(f.root,'v2'))).schemaVersion,2)
  await restoreNativeBackup(path.join(f.root,'v2'),path.join(f.root,'restored'))
  const restored=f.open('restored');assert.deepEqual(restored.verify(),f.a.verify());assert.deepEqual(restored.syncIdentity(),identity)
  await restoreNativeBackup(path.join(f.root,'v1'),path.join(f.root,'old'))
  assert.deepEqual(f.open('old').read('n'),original)
})

for (const mode of ['before','accepted']) test(`process exit ${mode} remote acceptance replays durably`,async t=>{
  const f=setup(t);f.a.create({id:'n'});f.a.close()
  const file=path.join(f.root,'provider.json');writeFileSync(file,JSON.stringify(f.p.exportState()))
  const child=spawnSync(process.execPath,['native/test/sync-worker.js',path.join(f.root,'a'),file,mode],{encoding:'utf8'})
  assert.equal(child.status,23,child.stderr)
  const p=new SimulatedProvider(JSON.parse(readFileSync(file,'utf8'))),a=f.open('a')
  assert.equal(p.exportState().operations.length,mode==='accepted'?1:0)
  assert.equal(a.syncStatus(p.id).deliveries[0].state,'pending')
  await synchronise(a,p);await synchronise(f.b,p)
  assert.equal(p.exportState().operations.length,1);assert.deepEqual(view(a),view(f.b))
})

test('process exit during incoming transaction rolls back note, inbox and cursor',async t=>{
  const f=setup(t);f.a.create({id:'n'});await f.sync(f.a);f.b.close()
  const file=path.join(f.root,'provider.json');writeFileSync(file,JSON.stringify(f.p.exportState()))
  const child=spawnSync(process.execPath,['native/test/sync-worker.js',path.join(f.root,'b'),file,'downloaded'],{encoding:'utf8'})
  assert.equal(child.status,24,child.stderr)
  const b=f.open('b');assert.deepEqual(b.list(),[]);assert.equal(b.syncStatus(f.p.id).cursor,null)
  assert.deepEqual(b.syncStatus(f.p.id).deliveries,[])
  await synchronise(b,f.p);b.close();assert.deepEqual(view(f.open('b')),view(f.a))
})

test('sync backup retains pending deliveries, conflicts and exact recovered versions',async t=>{
  const f=setup(t);await seed(f)
  f.a.rename('n','A',f.a.read('n'));f.b.rename('n','B',f.b.read('n'));await f.converge()
  f.a.putAttachment('n',{id:'pending',bytes:new Uint8Array([4,5])},f.a.read('n'))
  const directory=path.join(f.root,'backup');await f.a.exportBackup(directory)
  await restoreNativeBackup(directory,path.join(f.root,'clone'));const clone=f.open('clone')
  assert.deepEqual(clone.verify(),f.a.verify());assert.deepEqual(clone.syncStatus(f.p.id),f.a.syncStatus(f.p.id))
  assert.deepEqual(clone.syncConflicts('n'),f.a.syncConflicts('n'))
  const identity=clone.syncIdentity();clone.forkSyncClient()
  assert.equal(clone.syncIdentity().vaultId,identity.vaultId);assert.notEqual(clone.syncIdentity().clientId,identity.clientId)
  clone.rename('n','clone edit',clone.read('n'));f.a.rename('n','original edit',f.a.read('n'))
  for(let i=0;i<3;i++){await f.sync(f.a);await synchronise(clone,f.p)}
  assert.deepEqual(view(clone),view(f.a));clone.verify();f.a.verify()
})

test('independent same-ID documents and replaced Yjs histories preserve unresolved originals',async t=>{
  const f=setup(t)
  const bytes=text=>{const d=new Y.Doc();d.getText('body').insert(0,text);const data=Y.encodeStateAsUpdate(d);d.destroy();return data}
  f.a.create({id:'n',document:bytes('first')});f.b.create({id:'n',document:bytes('second')});await f.converge()
  const conflicts=f.a.syncConflicts('n');assert.ok(conflicts.some(c=>c.field==='document'))
  assert.deepEqual(view(f.a),view(f.b));assert.deepEqual(conflicts,f.b.syncConflicts('n'))
  f.a.update('n',{document:bytes('replacement')},f.a.read('n'));editText(f.b,'continued');await f.converge()
  assert.ok(f.a.syncConflicts('n').filter(c=>c.field==='document').length>=2)
  f.a.close();f.b.close();const a=f.open('a'),b=f.open('b');assert.deepEqual(view(a),view(b));a.verify();b.verify()
})

test('legacy bytes and recovery rows survive enabled browser import, sync and reopen',async t=>{
  const f=setup(t),{text}=await browserBackup();await f.a.importBackup(text);await f.converge()
  f.a.close();f.b.close();const a=f.open('a'),b=f.open('b')
  assert.deepEqual(view(a),view(b));assert.equal(a.readImport(JSON.parse(text).sha256),text)
  a.verify();b.verify()
})

test('a missing parent waits across pages; invalid cyclic moves never bypass storage validation',async t=>{
  const f=setup(t);f.a.create({id:'parent'});f.a.create({id:'child',metadata:{parentId:'parent'}});await f.sync(f.a)
  const ops=f.p.exportState().operations;f.b.connectSync('ordered','one')
  assert.equal(f.b.receiveSync('ordered',null,{epoch:'one',operations:[ops[1]],cursor:1,hasMore:true}).waiting,1)
  f.b.receiveSync('ordered',1,{epoch:'one',operations:[ops[0]],cursor:2,hasMore:false})
  assert.equal(f.b.read('child').metadata.parentId,'parent')
  const op=structuredClone(ops[0]);op.id='invalid-self';op.sequence=999;op.snapshot.metadata.parentId='parent';const {sha256:_,...body}=op;op.sha256=hash(body)
  const before=view(f.b)
  assert.throws(()=>f.b.receiveSync('ordered',2,{epoch:'one',operations:[op],cursor:3,hasMore:false}),/hierarchy/)
  assert.deepEqual(view(f.b),before);assert.equal(f.b.syncStatus('ordered').cursor,2)
})

test('different target checkpoints do not suppress forwarding original operations',async t=>{
  const f=setup(t);await seed(f);const other=new SimulatedProvider({id:'second-target'}),c=f.create('c')
  await synchronise(f.b,other);await synchronise(c,other);assert.deepEqual(view(c),view(f.a))
  assert.equal(other.exportState().operations[0].id,f.p.exportState().operations[0].id)
  const length=other.exportState().operations.length;await synchronise(f.b,other);assert.equal(other.exportState().operations.length,length)
})

test('explicit enablement and read-only handles cannot start or mutate sync state',async t=>{
  const f=setup(t,{enabled:false});await assert.rejects(f.sync(f.a),/not enabled/)
  f.a.enableSync();const readOnly=NativeVault.open(path.join(f.root,'a'),{readOnly:true})
  try {assert.throws(()=>readOnly.enableSync(),/read-only/);await assert.rejects(synchronise(readOnly,f.p),/read-only/)} finally {readOnly.close()}
})

test('provider timeout and cancellation leave durable retryable operations',async t=>{
  const f=setup(t);f.a.create({id:'n'});f.p.failNext('beforePublish',()=>new Promise(()=>{}))
  await assert.rejects(synchronise(f.a,f.p,{timeoutMs:20,now:()=>0}),/timeout/)
  assert.equal(f.a.syncStatus(f.p.id).deliveries[0].state,'retry')
  const abort=new AbortController();abort.abort(new Error('cancelled'))
  await assert.rejects(synchronise(f.a,f.p,{signal:abort.signal}),/cancelled/)
  assert.equal(f.p.exportState().operations.length,0)
})

test('forged field baseline and reused IDs cannot silently change a stored operation',async t=>{
  const f=setup(t);await seed(f);f.a.rename('n','new',f.a.read('n'));await f.sync(f.a)
  const op=structuredClone(f.p.exportState().operations.at(-1));op.writes=[];const {sha256:_,...body}=op;op.sha256=hash(body)
  const target=f.b.syncStatus(f.p.id)
  assert.throws(()=>f.b.receiveSync(f.p.id,target.cursor,{epoch:f.p.epoch,operations:[op],cursor:99,hasMore:false}),/baseline/)
  assert.equal(f.b.read('n').metadata.title,'base')
  const old=structuredClone(f.p.exportState().operations[0]);old.snapshot.metadata.title='tampered';const {sha256:__,...body2}=old;old.sha256=hash(body2)
  await assert.rejects(f.p.publish(old,f.p.epoch),/collision/)
  assert.equal(canonical(f.b.syncStatus(f.p.id).cursor),canonical(target.cursor))
})

test('three replicas retain identical conflict history under different delivery permutations',async t=>{
  const f=setup(t);await seed(f);const c=f.create('c');await synchronise(c,f.p)
  f.a.rename('n','A',f.a.read('n'));f.b.rename('n','B',f.b.read('n'));c.rename('n','C',c.read('n'))
  // Upload all branches without pulling, so every branch really was offline.
  for (const v of [c,f.b,f.a]) for (const op of v.pendingSync(f.p.id)) await f.p.publish(op,f.p.epoch)
  const ops=f.p.exportState().operations
  for (const [v,items] of [[f.a,ops],[f.b,[...ops].reverse()],[c,[ops[2],ops[0],ops[3],ops[1]]]]) {
    v.connectSync('permutation','one');let cursor=null
    for (let i=0;i<items.length;i++) {v.receiveSync('permutation',cursor,{epoch:'one',operations:[items[i]],cursor:i+1,hasMore:i<items.length-1});cursor=i+1}
  }
  assert.deepEqual(view(f.a),view(f.b));assert.deepEqual(view(f.b),view(c))
  assert.equal(f.a.syncConflicts('n').filter(c=>c.field==='meta:title').length,3)
  assert.deepEqual(f.a.syncConflicts('n'),c.syncConflicts('n'));assert.deepEqual(f.b.syncConflicts('n'),c.syncConflicts('n'))
  f.a.close();f.b.close();c.close();for(const name of ['a','b','c']) f.open(name).verify()
})

test('cross-note and cyclic causal references are rejected without cursor advancement',async t=>{
  const f=setup(t);f.a.create({id:'n'});f.a.create({id:'other'});await f.sync(f.a)
  const ops=f.p.exportState().operations
  f.b.connectSync('invalid','one')
  const rehash=op=>{const {sha256:_,...body}=op;return {...body,sha256:hash(body)}}
  const cross=structuredClone(ops[1]);cross.parents=[ops[0].id]
  assert.throws(()=>f.b.receiveSync('invalid',null,{epoch:'one',operations:[ops[0],rehash(cross)],cursor:1,hasMore:false}),/Cross-note/)
  const first=structuredClone(ops[0]),second=structuredClone(ops[0]);second.id='cycle-two';second.sequence=999
  first.parents=[second.id];second.parents=[first.id]
  assert.throws(()=>f.b.receiveSync('invalid',null,{epoch:'one',operations:[rehash(first),rehash(second)],cursor:1,hasMore:false}),/Cyclic/)
  f.b.close();const b=f.open('b');assert.equal(b.syncStatus('invalid').cursor,null);assert.deepEqual(b.list(),[])
})

test('two handles and overlapping engines use SQLite and cursor comparison safely',async t=>{
  const f=setup(t),other=f.open('a');f.a.create({id:'n'});other.rename('n','other handle',other.read('n'))
  const results=await Promise.allSettled([f.sync(f.a),f.sync(other)])
  for (const result of results) if(result.status==='rejected') assert.match(result.reason.message,/Stale sync cursor/)
  await f.converge();assert.equal(f.b.read('n').metadata.title,'other handle')
  assert.equal(new Set(f.p.exportState().operations.map(op=>op.id)).size,2)
  const diagnostic=new DatabaseSync(path.join(f.root,'a','vault.sqlite'))
  assert.deepEqual(diagnostic.prepare('PRAGMA integrity_check').all().map(row=>row.integrity_check),['ok'])
  assert.deepEqual(diagnostic.prepare('PRAGMA foreign_key_check').all(),[])
  diagnostic.close()
  f.a.verify();f.b.verify();other.close()
})

test('tampered persisted sync state is rejected by backup verification',async t=>{
  const f=setup(t);await seed(f)
  const db=new DatabaseSync(path.join(f.root,'a','vault.sqlite'))
  db.exec("UPDATE notes SET metadata='{\"title\":\"tampered\",\"parentId\":null}'")
  f.a.rebuildSearch()
  assert.throws(()=>f.a.verify(),/materialisation/)
  await assert.rejects(f.a.exportBackup(path.join(f.root,'bad-backup')),/materialisation/)
  db.close()
})

test('schema 2 remains searchable through the read-only Companion without sync mutation',async t=>{
  const f=setup(t);await seed(f);f.b.rename('n','동기화 검색',f.b.read('n'));await f.converge()
  const before=f.a.verify(),origin='http://127.0.0.1:5173'
  const companion=await startCompanion({directory:path.join(f.root,'a'),origin})
  try {
    const headers={Origin:origin,Authorization:`Bearer ${companion.token}`}
    const response=await fetch(companion.url+'/v1/search?q='+encodeURIComponent('동기화'),{headers})
    assert.equal(response.status,200);assert.equal((await response.json())[0].id,'n')
    const denied=await fetch(companion.url+'/v1/sync',{method:'POST',headers})
    assert.equal(denied.status,405)
  } finally {await companion.close()}
  assert.deepEqual(f.a.verify(),before)
})

test('engine tolerates provider duplicate/reversed delivery and rejects lost-state cursors',async t=>{
  const f=setup(t);f.a.create({id:'n'});f.a.rename('n','latest',f.a.read('n'));await f.sync(f.a)
  f.p.transformNextPage(page=>({...page,operations:[...page.operations].reverse().flatMap(op=>[op,op])}))
  await f.sync(f.b);assert.deepEqual(view(f.b),view(f.a))
  const cursor=f.b.syncStatus(f.p.id).cursor,before=view(f.b)
  // A faulty provider loses data without changing its epoch: the cursor check
  // still stops sync, and absence is never interpreted as a deletion.
  const lost=new SimulatedProvider({id:f.p.id,epoch:f.p.epoch})
  await assert.rejects(synchronise(f.b,lost),/cursor/)
  assert.deepEqual(f.b.syncStatus(f.p.id).cursor,cursor)
  f.b.close();assert.deepEqual(view(f.open('b')),before)
})

test('failed acknowledgement cannot hide provider acceptance after restart',async t=>{
  const f=setup(t);f.a.create({id:'n'});f.a.connectSync(f.p.id,f.p.epoch)
  const db=new DatabaseSync(path.join(f.root,'a','vault.sqlite'))
  db.exec("CREATE TRIGGER fail_ack BEFORE UPDATE ON sync_delivery WHEN NEW.state='acknowledged' BEGIN SELECT RAISE(ABORT,'ack failure'); END")
  await assert.rejects(f.sync(f.a),/ack failure/)
  assert.equal(f.p.exportState().operations.length,1)
  assert.equal(f.a.syncStatus(f.p.id).deliveries[0].state,'retry')
  db.exec('DROP TRIGGER fail_ack');db.close();f.a.close()
  const a=f.open('a');await synchronise(a,f.p,{now:()=>2000000});await f.sync(f.b)
  assert.equal(f.p.exportState().operations.length,1);assert.deepEqual(view(a),view(f.b))
})
