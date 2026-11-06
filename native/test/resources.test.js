import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NativeVault } from '../vault.js'
import { DEFAULT_RESOURCES } from '../sync/resources.js'
import { digest } from '../validation.js'
import { hash } from '../sync/protocol.js'
import { SimulatedProvider } from '../sync/simulatedProvider.js'
import { synchronise } from '../sync/engine.js'

function fixture(t) {
  const root=mkdtempSync(path.join(realpathSync(tmpdir()),'ephemeris-resource-test-'))
  const v=NativeVault.create(path.join(root,'v'));v.enableSync();v.enableRecovery();v.enablePayloads()
  t.after(()=>{v.close();rmSync(root,{recursive:true,force:true})})
  return v
}
test('global operation quota rolls back note, journal and projection together',t=>{
  const v=fixture(t);v.create({id:'a'});v.create({id:'b'})
  v.configureSyncResources({...DEFAULT_RESOURCES,operations:2})
  const before=v.verify()
  assert.throws(()=>v.rename('a','not committed',v.read('a')),/resource limit/)
  assert.throws(()=>v.create({id:'c'}),/resource limit/)
  assert.deepEqual(v.verify(),before)
  assert.equal(v.syncRetention('a').usage.operations,2)
  assert.throws(()=>v.configureSyncResources({...DEFAULT_RESOURCES,operations:1}),/below retained/)
})
test('chunk quota rejects extra staged data without losing retained bytes',t=>{
  const v=fixture(t);v.create({id:'a'})
  v.configureSyncResources({...DEFAULT_RESOURCES,chunkBytes:10,chunks:1})
  const bytes=Buffer.from('retained'),id=digest(bytes)
  v.receiveSyncChunk(id,bytes)
  assert.equal(v.receiveSyncChunk(id,bytes),false)
  const extra=Buffer.from('extra'),extraId=digest(extra)
  assert.throws(()=>v.receiveSyncChunk(extraId,extra),/resource limit/)
  assert.equal(v.hasSyncChunk(extraId),false)
  assert.deepEqual(Buffer.from(v.readSyncChunk(id)),bytes)
  assert.equal(v.syncRetention('a').usage.chunkBytes,bytes.length)
})
test('deduplicated chunks cannot bypass the materialised attachment budget',t=>{
  const v=fixture(t),bytes=Buffer.from('same bytes')
  v.create({id:'a'});v.configureSyncResources({...DEFAULT_RESOURCES,attachmentBytes:bytes.length})
  v.putAttachment('a',{id:'one',bytes},v.read('a'))
  const before=v.verify()
  assert.throws(()=>v.putAttachment('a',{id:'two',bytes},v.read('a')),/resource limit/)
  assert.deepEqual(v.verify(),before)
})
test('provider acknowledgements never authorise deletion of offline and fork history',async t=>{
  const v=fixture(t),p=new SimulatedProvider()
  v.create({id:'a'});v.create({id:'b'})
  v.connectSync('offline','old');await synchronise(v,p)
  let report=v.syncRetention('a')
  assert.equal(report.safeToDeleteOperations,0)
  assert.equal(report.targets.find(t=>t.id==='offline').acknowledged,0)
  assert.equal(report.targets.find(t=>t.id===p.id).acknowledged,1)
  assert.ok(report.reasons.includes('pending-provider-delivery'))
  const original=v.syncIdentity();v.forkSyncClient()
  assert.notEqual(v.syncIdentity().clientId,original.clientId)
  report=v.syncRetention('a');assert.equal(report.safeToDeleteOperations,0)
  assert.ok(report.reasons.includes('restored-or-forked-vaults-not-enumerated'))
})
test('excess concurrent evidence rejects the complete page and preserves its checkpoint',async t=>{
  const v=fixture(t),p=new SimulatedProvider()
  v.create({id:'a'});await synchronise(v,p)
  const base=p.exportState().operations[0]
  const rivals=Array.from({length:145},(_,i)=>{
    const body={...base,id:`rival-${i}`,clientId:`writer-${i}`,sequence:1,parents:[base.id],snapshot:{...base.snapshot,metadata:{...base.snapshot.metadata,title:`choice ${i}`}},writes:['meta:title']}
    delete body.sha256;return {...body,sha256:hash(body)}
  })
  const cursor=v.syncCheckpoint(p.id).cursor
  v.receiveSync(p.id,cursor,{epoch:p.epoch,operations:rivals.slice(0,100),cursor:'first',hasMore:true})
  const before=v.read('a'),conflicts=v.syncConflicts('a').length
  assert.equal(conflicts,4950)
  assert.throws(()=>v.receiveSync(p.id,'first',{epoch:p.epoch,operations:rivals.slice(100),cursor:'last',hasMore:false}),/resource limit/)
  assert.equal(v.syncCheckpoint(p.id).cursor,'first');assert.deepEqual(v.read('a'),before)
  assert.equal(v.syncConflicts('a').length,conflicts)
  assert.ok(v.syncRetention('a').reasons.includes('unresolved-conflict-evidence'))
})
