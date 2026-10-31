import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NativeVault } from '../vault.js'
import { synchronise } from '../sync/engine.js'
import { SimulatedProvider } from '../sync/simulatedProvider.js'
import { restoreNativeBackup } from '../backup.js'
import { DatabaseSync } from 'node:sqlite'
import * as Y from 'yjs'
import { decode } from '../sync/protocol.js'

function fixture(t) {
  const root=mkdtempSync(path.join(realpathSync(tmpdir()),'ephemeris-recovery-')),handles=[]
  const open=name=>{const v=NativeVault.open(path.join(root,name));handles.push(v);return v}
  const create=name=>{const v=NativeVault.create(path.join(root,name));handles.push(v);v.enableSync();v.enableRecovery?.();return v}
  const a=create('a'),b=create('b'),p=new SimulatedProvider()
  const sync=async()=>{for(let i=0;i<3;i++){await synchronise(a,p);await synchronise(b,p)}}
  t.after(()=>{handles.forEach(v=>v.close());rmSync(root,{recursive:true,force:true})})
  return {a,b,p,root,open,create,sync}
}

test('concurrent cross-note cycle preserves requested moves and a readable safe tree',async t=>{
  const f=fixture(t);f.a.create({id:'x'});f.a.create({id:'y'});await f.sync()
  f.a.move('x','y',f.a.read('x'));f.b.move('y','x',f.b.read('y'))
  await f.sync()
  assert.equal(f.a.read('x').metadata.parentId,null);assert.equal(f.b.read('y').metadata.parentId,null)
  const state=f.a.syncRecovery();assert.ok(state.some(c=>c.reason==='cycle'))
  assert.equal(f.a.requestedSyncNote('x').metadata.parentId,'y')
  assert.equal(f.b.requestedSyncNote('y').metadata.parentId,'x')
})

const expected=(v,id)=>({...v.read(id),heads:v.syncHeads(id)})
const resolve=(v,id,c,value)=>v.resolveSyncConflict(id,c.id,{value},expected(v,id))
const state=v=>v.list({includeDeleted:true}).map(({version:_version,...note})=>note)

test('explicit cycle repair synchronises atomically, preserves history, and survives snapshots',async t=>{
  const f=fixture(t);f.a.create({id:'x'});f.a.create({id:'y'});await f.sync()
  f.a.move('x','y',f.a.read('x'));f.b.move('y','x',f.b.read('y'));await f.sync()
  const conflict=f.a.syncRecovery().find(c=>c.noteId==='x')
  resolve(f.a,'x',conflict,null);await f.sync()
  assert.equal(f.a.read('x').metadata.parentId,null);assert.equal(f.b.read('y').metadata.parentId,'x')
  assert.deepEqual(f.b.syncRecovery(),[]);assert.deepEqual(state(f.a),state(f.b))
  assert.equal(f.b.syncConflicts('x').find(c=>c.id===conflict.id).status,'resolved')
  const fresh=f.create('fresh');await synchronise(fresh,f.p)
  assert.equal(fresh.syncConflicts('x').find(c=>c.id===conflict.id).status,'resolved')
  for(const id of conflict.operations)assert.ok(f.b.retainedSyncOperation(id))
  await f.a.exportBackup(path.join(f.root,'backup'));await restoreNativeBackup(path.join(f.root,'backup'),path.join(f.root,'restored'))
  const restored=f.open('restored');assert.deepEqual(restored.verify(),f.a.verify())
  assert.deepEqual(restored.syncConflicts('x'),f.a.syncConflicts('x'))
})

test('deleted parent versus move remains readable; restoration and explicit repair preserve evidence',async t=>{
  const f=fixture(t);f.a.create({id:'parent'});f.a.create({id:'child'});await f.sync()
  f.a.delete('parent',f.a.read('parent'));f.b.move('child','parent',f.b.read('child'));await f.sync()
  assert.equal(f.b.read('child').metadata.parentId,null)
  assert.equal(f.b.requestedSyncNote('child').metadata.parentId,'parent')
  assert.ok(f.a.syncRecovery().some(c=>c.reason==='unavailable-parent'))
  f.b.rename('child','searchable',f.b.read('child'));await f.sync()
  assert.equal(f.a.requestedSyncNote('child').metadata.parentId,'parent')
  assert.equal(f.a.search('searchable')[0].id,'child')
  f.a.restore('parent',f.a.read('parent'));await f.sync()
  assert.equal(f.b.read('child').metadata.parentId,'parent')
  assert.ok(f.b.syncConflicts('child').some(c=>c.reason==='unavailable-parent'))
  f.a.close();f.b.close();assert.deepEqual(state(f.open('a')),state(f.open('b')))
})

async function titleConflict(f) {
  f.a.create({id:'n',metadata:{title:'base'}});await f.sync()
  f.a.rename('n','left',f.a.read('n'));f.b.rename('n','right',f.b.read('n'));await f.sync()
  return f.a.syncConflicts('n').find(c=>c.field==='meta:title')
}
for(const same of [true,false])test(`concurrent resolutions ${same?'agree':'disagree'} without losing original choices`,async t=>{
  const f=fixture(t),conflict=await titleConflict(f)
  resolve(f.a,'n',conflict,'agreed');resolve(f.b,'n',conflict,same?'agreed':'different');await f.sync()
  assert.deepEqual(state(f.a),state(f.b));assert.deepEqual(f.a.syncConflicts('n'),f.b.syncConflicts('n'))
  const active=f.a.syncConflicts('n').filter(c=>c.status==='unresolved')
  assert.equal(active.length,same?0:1)
  assert.equal(f.a.syncConflicts('n').find(c=>c.id===conflict.id).resolutions.length,2)
  f.a.verify();f.b.verify()
})

test('stale resolution decisions fail; offline resolution races create new recoverable conflicts',async t=>{
  const f=fixture(t),c=await titleConflict(f),old=expected(f.a,'n')
  f.a.rename('n','new local',f.a.read('n'))
  assert.throws(()=>f.a.resolveSyncConflict('n',c.id,{value:'stale'},old),/Stale/)
  resolve(f.a,'n',c,'resolved');f.b.rename('n','offline rival',f.b.read('n'));await f.sync()
  assert.ok(f.a.syncConflicts('n').some(c=>c.status==='unresolved'&&c.field==='meta:title'))
  assert.deepEqual(state(f.a),state(f.b))
})

test('resolution racing deletion does not resurrect; explicit deletion resolution can restore',async t=>{
  const f=fixture(t),c=await titleConflict(f)
  resolve(f.a,'n',c,'resolution');f.b.delete('n',f.b.read('n'));await f.sync()
  assert.ok(f.a.read('n').deleted)
  const deletion=f.a.syncConflicts('n').find(c=>c.field==='delete-versus-edit'&&c.status==='unresolved')
  resolve(f.a,'n',deletion,null);await f.sync()
  assert.equal(f.b.read('n').deleted,null)
  f.a.close();f.b.close();assert.deepEqual(state(f.open('a')),state(f.open('b')))
})

test('selecting attachment and incompatible Yjs versions retains every original snapshot',async t=>{
  const f=fixture(t)
  const bytes=text=>{const d=new Y.Doc();d.getText('body').insert(0,text);const data=Y.encodeStateAsUpdate(d);d.destroy();return data}
  f.a.create({id:'n',document:bytes('A')});f.b.create({id:'n',document:bytes('B')})
  f.a.putAttachment('n',{id:'file',bytes:new Uint8Array([1])},f.a.read('n'))
  f.b.putAttachment('n',{id:'file',bytes:new Uint8Array([2])},f.b.read('n'));await f.sync()
  for(const field of ['document','attachment:file']) {
    const c=f.a.syncConflicts('n').find(c=>c.field===field&&c.status==='unresolved')
    f.a.resolveSyncConflict('n',c.id,{operationId:c.operations[0]},expected(f.a,'n'));await f.sync()
    for(const id of c.operations)assert.ok(f.b.retainedSyncOperation(id).snapshot.document)
  }
  assert.deepEqual(state(f.a),state(f.b));assert.deepEqual(f.a.readAttachment('n','file'),f.b.readAttachment('n','file'))
  f.a.verify();f.b.verify()
})

test('migration and resolution failures roll back without altering schema 2 history',async t=>{
  const f=fixture(t),v=NativeVault.create(path.join(f.root,'old'));v.enableSync();v.create({id:'n'})
  const old=v.verify(),db=new DatabaseSync(path.join(f.root,'old','vault.sqlite'))
  db.exec('CREATE TABLE sync_structures (collision TEXT)')
  assert.throws(()=>v.enableRecovery(),/already exists/);assert.equal(db.prepare('PRAGMA user_version').get().user_version,2)
  db.exec('DROP TABLE sync_structures');assert.deepEqual(v.verify(),old);v.enableRecovery();v.verify();db.close();v.close()
  const c=await titleConflict(f),before=f.a.verify(),fault=new DatabaseSync(path.join(f.root,'a','vault.sqlite'))
  fault.exec("CREATE TRIGGER fail_resolution BEFORE INSERT ON sync_resolutions BEGIN SELECT RAISE(ABORT,'resolution failure'); END")
  assert.throws(()=>resolve(f.a,'n',c,'no'),/resolution failure/)
  fault.exec('DROP TRIGGER fail_resolution');fault.close();assert.deepEqual(f.a.verify(),before)
})

test('corrupt migration input and incomplete declared schema are rejected',t=>{
  const f=fixture(t),v=NativeVault.create(path.join(f.root,'corrupt'));v.enableSync();v.create({id:'n'})
  const db=new DatabaseSync(path.join(f.root,'corrupt','vault.sqlite'))
  const original=db.prepare('SELECT content_hash FROM notes WHERE id=?').get('n').content_hash
  db.prepare('UPDATE notes SET content_hash=? WHERE id=?').run('corrupt','n')
  assert.throws(()=>v.enableRecovery(),/integrity/)
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,2)
  assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name='sync_projection'").get().count,0)
  db.prepare('UPDATE notes SET content_hash=? WHERE id=?').run(original,'n');v.enableRecovery();v.close()
  db.exec('DROP TABLE sync_dependencies');db.close()
  assert.throws(()=>NativeVault.open(path.join(f.root,'corrupt')),/no such table: sync_dependencies/)
})

test('missing hierarchy and causal parents have distinct inspectable states and drain later',async t=>{
  const f=fixture(t);f.a.create({id:'parent'});f.a.create({id:'child',metadata:{parentId:'parent'}});f.a.rename('child','later',f.a.read('child'))
  await synchronise(f.a,f.p);const ops=f.p.exportState().operations
  f.b.connectSync('reordered','one')
  f.b.receiveSync('reordered',null,{epoch:'one',operations:[ops[2]],cursor:1,hasMore:true})
  assert.ok(f.b.syncRecovery().some(c=>c.reason==='missing-causal-dependency'))
  f.b.receiveSync('reordered',1,{epoch:'one',operations:[ops[1]],cursor:2,hasMore:true})
  assert.equal(f.b.read('child').metadata.title,'later');assert.equal(f.b.read('child').metadata.parentId,null)
  assert.ok(f.b.syncRecovery().some(c=>c.reason==='missing-parent'))
  f.b.receiveSync('reordered',2,{epoch:'one',operations:[ops[0]],cursor:3,hasMore:false})
  assert.deepEqual(f.b.syncRecovery(),[]);assert.equal(f.b.read('child').metadata.parentId,'parent');f.b.verify()
})

test('termination before repair commit rolls back every related note and retained status',async t=>{
  const f=fixture(t);f.a.create({id:'x'});f.a.create({id:'y'});await f.sync()
  f.a.move('x','y',f.a.read('x'));f.b.move('y','x',f.b.read('y'));await f.sync()
  const c=f.a.syncRecovery().find(c=>c.noteId==='x'),before=f.a.verify();f.a.close()
  const child=spawnSync(process.execPath,['native/test/recovery-worker.js',path.join(f.root,'a'),c.id],{encoding:'utf8'})
  assert.equal(child.status,31,child.stderr)
  const reopened=f.open('a');assert.deepEqual(reopened.verify(),before)
  resolve(reopened,'x',c,null);await synchronise(reopened,f.p);await synchronise(f.b,f.p)
  assert.deepEqual(state(reopened),state(f.b))
})

test('index failure during projection keeps cursor and original requested hierarchy',async t=>{
  const f=fixture(t);f.a.create({id:'x'});f.a.create({id:'y'});await f.sync()
  f.a.move('x','y',f.a.read('x'));f.b.move('y','x',f.b.read('y'));await synchronise(f.a,f.p)
  const db=new DatabaseSync(path.join(f.root,'b','vault.sqlite')),before=f.b.verify(),cursor=f.b.syncStatus(f.p.id).cursor
  db.exec("CREATE TRIGGER fail_projection BEFORE UPDATE ON notes BEGIN SELECT RAISE(ABORT,'projection failure'); END")
  await assert.rejects(synchronise(f.b,f.p),/projection failure/)
  assert.deepEqual(f.b.syncStatus(f.p.id).cursor,cursor)
  db.exec('DROP TRIGGER fail_projection');db.close()
  // Upload acknowledgement is allowed to progress independently of download.
  assert.equal(f.b.requestedSyncNote('y').metadata.parentId,'x')
  assert.equal(f.b.read('x').metadata.parentId,null);assert.ok(before.contentHash)
  await f.sync();f.b.verify()
})

test('bounded pending batches and operation history limits reject safely',async t=>{
  const f=fixture(t);f.a.create({id:'n',metadata:{title:'x'.repeat(2000)}})
  f.a.connectSync('one','epoch');f.a.connectSync('two','epoch')
  assert.throws(()=>f.a.pendingSync('one',{maxBytes:1024}),/budget/)
  const before=f.a.read('n')
  assert.throws(()=>f.a.putAttachment('n',{id:'too-large',bytes:new Uint8Array(38*1024*1024)},before),/too large|Oversized/)
  assert.deepEqual(f.a.read('n'),before);assert.deepEqual(f.a.listAttachments('n'),[])
  assert.equal(f.a.pendingSync('one').length,1);assert.equal(f.a.pendingSync('two').length,1)
})

test('large Base64 decoding is canonical and does not exhaust the regexp stack',()=>{
  const bytes=Buffer.alloc(8*1024*1024,0xab)
  assert.deepEqual(decode(bytes.toString('base64')),bytes)
  for(const value of ['A===','!!!!','AB==','AQ=','AQ==\n'])assert.throws(()=>decode(value),/base64/)
})

test('1024-operation history limit rolls back the next edit and remains reopenable',async t=>{
  const f=fixture(t);f.a.create({id:'n'})
  for(let i=0;i<1023;i++)f.a.rename('n',`edit ${i}`,f.a.read('n'))
  const before=f.a.read('n'),heads=f.a.syncHeads('n')
  assert.throws(()=>f.a.rename('n','over limit',before),/resource limit/)
  assert.deepEqual(f.a.read('n'),before);assert.deepEqual(f.a.syncHeads('n'),heads)
  f.a.close();const a=f.open('a');assert.deepEqual(a.read('n'),before);a.verify()
})

test('a delayed root drains in bounded transactions and resumes after reopen',async t=>{
  const f=fixture(t);f.a.create({id:'n'})
  for(let i=0;i<250;i++)f.a.rename('n',`edit ${i}`,f.a.read('n'))
  f.a.connectSync('source','one')
  const db=new DatabaseSync(path.join(f.root,'a','vault.sqlite'))
  const ops=db.prepare('SELECT payload FROM sync_operations ORDER BY sequence').all().map(row=>JSON.parse(row.payload));db.close()
  f.b.connectSync('delayed','one');let cursor=null
  for(let i=1;i<ops.length;i+=100){const next=i;f.b.receiveSync('delayed',cursor,{epoch:'one',operations:ops.slice(i,i+100),cursor:next,hasMore:true});cursor=next}
  const result=f.b.receiveSync('delayed',cursor,{epoch:'one',operations:[ops[0]],cursor:999,hasMore:false})
  assert.equal(result.applied,200);assert.equal(result.moreWork,true);f.b.close()
  const b=f.open('b'),done=b.receiveSync('delayed',999,{epoch:'one',operations:[],cursor:999,hasMore:false})
  assert.equal(done.waiting,0);assert.equal(b.read('n').metadata.title,'edit 249');b.verify()
})
