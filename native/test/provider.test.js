import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync,realpathSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { NativeVault } from '../vault.js'
import { synchronise } from '../sync/engine.js'
import { SimulatedProvider } from '../sync/simulatedProvider.js'
import { ProviderError } from '../sync/limits.js'
import { providerConformance } from './provider-conformance.js'

async function fixture(t) {
  const root=mkdtempSync(path.join(realpathSync(tmpdir()),'ephemeris-provider-')),v=NativeVault.create(path.join(root,'v'))
  t.after(()=>{v.close();rmSync(root,{recursive:true,force:true})})
  v.enableSync();v.enableRecovery();v.create({id:'n'});const provider=new SimulatedProvider()
  v.connectSync(provider.id,provider.epoch)
  return {v,root,provider,operation:v.pendingSync(provider.id)[0],reopen:p=>new SimulatedProvider(JSON.parse(JSON.stringify(p.exportState())))}
}
providerConformance('simulated provider',fixture)

for(const code of ['UNAUTHENTICATED','FORBIDDEN','REVOKED'])test(`provider ${code} stops before acknowledgement or checkpoint`,async t=>{
  const {v,provider}=await fixture(t),before=v.syncStatus(provider.id)
  provider.failNext('beforePublish',new ProviderError(code))
  await assert.rejects(synchronise(v,provider),{code})
  assert.deepEqual(v.syncStatus(provider.id),before);assert.equal(provider.exportState().operations.length,0)
})

test('namespace binding rejects a different tenant before uploading',async t=>{
  const {v,provider}=await fixture(t);provider.namespace='another-tenant'
  await assert.rejects(synchronise(v,provider),/namespace/)
  assert.equal(provider.exportState().operations.length,0)
})

test('aggregate provider response size is rejected before cursor or note mutation',async t=>{
  const {v,provider,operation}=await fixture(t)
  provider.transformNextPage(page=>({...page,operations:Array.from({length:50},()=>operation)}))
  await assert.rejects(synchronise(v,provider,{maxBytes:1024}),/byte limit/)
  assert.equal(v.syncStatus(provider.id).cursor,null)
  assert.equal(v.read('n').metadata.title,'')
})
