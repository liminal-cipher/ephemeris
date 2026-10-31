import { test } from 'node:test'
import assert from 'node:assert/strict'

// Reuse with a future adapter's isolated fixture factory. Persistence here is
// supplied by the harness; this cannot certify physical server durability.
export function providerConformance(name,fixture) {
  test(`${name}: identity, durable-reopen idempotency and cursor contract`,async t=>{
    const {provider,operation,reopen}=await fixture(t),info=await provider.info()
    assert.deepEqual(await provider.info(),info)
    const ack=await provider.publish(operation,info.epoch)
    assert.deepEqual(ack,{id:operation.id,sha256:operation.sha256,epoch:info.epoch})
    const restarted=await reopen(provider)
    assert.deepEqual(await restarted.publish(operation,info.epoch),ack)
    const first=await restarted.pull(null,{epoch:info.epoch,limit:1})
    assert.equal(first.operations.length,1);assert.deepEqual(first.operations[0],operation)
    const next=await restarted.pull(first.cursor,{epoch:info.epoch,limit:1})
    assert.deepEqual(next.operations,[]);assert.equal(next.hasMore,false)
    await assert.rejects(restarted.pull({offset:999,epoch:info.epoch},{epoch:info.epoch}),/cursor/)
  })
  test(`${name}: content reuse and byte limits cannot silently acknowledge`,async t=>{
    const {provider,operation}=await fixture(t),info=await provider.info()
    await provider.publish(operation,info.epoch)
    const altered=structuredClone(operation);altered.snapshot.metadata.title='forged'
    await assert.rejects(provider.publish(altered,info.epoch))
    await assert.rejects(provider.pull(null,{epoch:info.epoch,limit:1,maxBytes:1}),/byte limit/)
  })
}
