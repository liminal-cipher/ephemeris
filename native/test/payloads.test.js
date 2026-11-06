import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { NativeVault } from '../vault.js'
import { restoreNativeBackup } from '../backup.js'
import { synchronise } from '../sync/engine.js'
import { SimulatedProvider } from '../sync/simulatedProvider.js'
import { CHUNK_BYTES } from '../sync/payloads.js'
import { hash } from '../sync/protocol.js'

function fixture(t) {
  const root=mkdtempSync(path.join(realpathSync(tmpdir()),'ephemeris-payload-')),handles=[]
  const create=(name,upgrade=true)=>{
    const v=NativeVault.create(path.join(root,name));handles.push(v)
    v.enableSync();v.enableRecovery();if(upgrade)v.enablePayloads();return v
  }
  const open=name=>{const v=NativeVault.open(path.join(root,name));handles.push(v);return v}
  t.after(()=>{handles.forEach(v=>v.close());rmSync(root,{recursive:true,force:true})})
  return {root,create,open,p:new SimulatedProvider()}
}

test('chunked attachment survives repeated edits, independent replicas, reopen and backup',async t=>{
  const f=fixture(t),a=f.create('a'),b=f.create('b'),bytes=randomBytes(CHUNK_BYTES*3+19)
  a.create({id:'n'});a.putAttachment('n',{id:'file',bytes},a.read('n'))
  for(let i=0;i<20;i++)a.rename('n',`title ${i}`,a.read('n'))
  await synchronise(a,f.p);await synchronise(b,f.p)
  assert.deepEqual(Buffer.from(b.readAttachment('n','file').bytes),bytes)
  assert.equal(b.read('n').metadata.title,'title 19')
  const state=f.p.exportState()
  assert.equal(state.chunks.length,4)
  assert.ok(Buffer.byteLength(JSON.stringify(state.operations))<40000)
  assert.ok(state.operations.every(op=>op.protocol===3))
  a.verify();b.verify()
  await a.exportBackup(path.join(f.root,'backup'))
  await restoreNativeBackup(path.join(f.root,'backup'),path.join(f.root,'restored'))
  const restored=f.open('restored');assert.deepEqual(restored.verify(),a.verify())
  assert.deepEqual(Buffer.from(restored.readAttachment('n','file').bytes),bytes)
  a.close();assert.equal(f.open('a').read('n').metadata.title,'title 19')
})

test('explicit upgrade retains legacy operation checksums and supports old history',async t=>{
  const f=fixture(t),a=f.create('a',false),b=f.create('b')
  a.create({id:'n'});a.putAttachment('n',{id:'file',bytes:randomBytes(100)},a.read('n'))
  await synchronise(a,f.p)
  const before=f.p.exportState().operations
  a.enablePayloads();a.rename('n','upgraded',a.read('n'));await synchronise(a,f.p);await synchronise(b,f.p)
  for(const op of before)assert.deepEqual(a.retainedSyncOperation(op.id),op)
  assert.equal(b.read('n').metadata.title,'upgraded');a.verify();b.verify()
  const old=f.create('old',false)
  await assert.rejects(synchronise(old,f.p),/schema 4/)
  assert.equal(old.syncCheckpoint(f.p.id).cursor,null)
})

test('missing or damaged chunks never advance note state or cursor',async t=>{
  const f=fixture(t),a=f.create('a'),b=f.create('b')
  a.create({id:'n'});a.putAttachment('n',{id:'file',bytes:randomBytes(CHUNK_BYTES+2)},a.read('n'))
  await synchronise(a,f.p)
  b.connectSync(f.p.id,f.p.epoch)
  const page=await f.p.pull(null,{epoch:f.p.epoch})
  assert.throws(()=>b.receiveSync(f.p.id,null,page),/Missing content chunk/)
  assert.equal(b.syncCheckpoint(f.p.id).cursor,null);assert.deepEqual(b.list(),[])
  const original=f.p.getChunk.bind(f.p)
  f.p.getChunk=async()=>Buffer.from('damaged')
  await assert.rejects(synchronise(b,f.p),/integrity/)
  assert.equal(b.syncCheckpoint(f.p.id).cursor,null);assert.deepEqual(b.list(),[])
  f.p.getChunk=original;await synchronise(b,f.p);b.verify()
})

test('manifest size, aggregate hash and protocol checks reject forged references',async t=>{
  const f=fixture(t),a=f.create('a'),b=f.create('b')
  a.create({id:'n'});a.putAttachment('n',{id:'file',bytes:randomBytes(10)},a.read('n'))
  await synchronise(a,f.p)
  const op=structuredClone(f.p.exportState().operations.at(-1))
  op.snapshot.attachments[0].content.size=CHUNK_BYTES+1
  const {sha256:_,...body}=op;op.sha256=hash(body)
  await assert.rejects(f.p.publish(op,f.p.epoch),/manifest/)
  assert.throws(()=>b.receiveSyncChunk('0'.repeat(64),Buffer.alloc(CHUNK_BYTES+1)),/integrity/)
})

test('upgraded conflict resolution preserves inline competing attachment evidence',async t=>{
  const f=fixture(t),a=f.create('a',false),b=f.create('b',false)
  a.create({id:'n'});await synchronise(a,f.p);await synchronise(b,f.p)
  a.putAttachment('n',{id:'file',bytes:Buffer.from('left')},a.read('n'))
  b.putAttachment('n',{id:'file',bytes:Buffer.from('right')},b.read('n'))
  await synchronise(a,f.p);await synchronise(b,f.p);await synchronise(a,f.p)
  const c=a.syncConflicts('n').find(c=>c.field==='attachment:file')
  const selected=c.operations.find(id=>a.retainedSyncOperation(id).snapshot.attachments[0].bytes===Buffer.from('right').toString('base64'))
  a.enablePayloads();b.enablePayloads()
  a.resolveSyncConflict('n',c.id,{operationId:selected},{...a.read('n'),heads:a.syncHeads('n')})
  await synchronise(a,f.p);await synchronise(b,f.p)
  assert.equal(Buffer.from(b.readAttachment('n','file').bytes).toString(),'right')
  assert.equal(b.syncConflicts('n').find(item=>item.id===c.id).status,'resolved')
  a.verify();b.verify()
})

test('failed payload migration rolls back schema and remains readable',t=>{
  const f=fixture(t),a=f.create('a',false)
  a.create({id:'n'})
  const db=new DatabaseSync(path.join(f.root,'a','vault.sqlite'))
  try {
    db.exec('CREATE TABLE sync_content (wrong TEXT)')
    assert.throws(()=>a.enablePayloads(),/already exists/)
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,3)
    assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name='sync_chunks'").get().count,0)
    assert.equal(a.read('n').id,'n')
  }finally{db.close()}
})
