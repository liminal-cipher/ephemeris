import { validateOperation, canonical } from './protocol.js'
import { identifier } from '../validation.js'

// A deterministic simulator, not a network transport. Exported state can be
// persisted by a test harness to model server durability across client crashes.
export class SimulatedProvider {
  #operations = []
  #faults = new Map()
  #pageTransform
  constructor({id='simulated',epoch='generation-1',operations=[]}={}) {
    identifier(id); identifier(epoch)
    this.id=id; this.epoch=epoch
    for (const op of operations) this.#accept(op)
  }
  failNext(point, error=new Error('Simulated disconnection')) { this.#faults.set(point,error) }
  transformNextPage(transform) { if (typeof transform!=='function') throw new Error('Expected page transform'); this.#pageTransform=transform }
  async #fault(point) {
    if (!this.#faults.has(point)) return
    const fault=this.#faults.get(point); this.#faults.delete(point)
    if (typeof fault==='function') await fault()
    else throw fault
  }
  async info() { await this.#fault('info'); return {id:this.id,epoch:this.epoch} }
  #accept(operation) {
    const op=structuredClone(validateOperation(operation))
    const prior=this.#operations.find(item=>item.id===op.id || (item.clientId===op.clientId && item.sequence===op.sequence))
    if (prior) { if (canonical(prior)!==canonical(op)) throw new Error('Provider idempotency collision'); return }
    this.#operations.push(op)
  }
  async publish(operation,epoch) {
    await this.#fault('beforePublish')
    if (epoch!==this.epoch) throw new Error('Remote epoch changed')
    this.#accept(operation)
    await this.#fault('afterAccept')
    return { id:operation.id, sha256:operation.sha256, epoch:this.epoch }
  }
  async pull(cursor,{limit=50,epoch}={}) {
    await this.#fault('beforePull')
    if (epoch!==this.epoch || !Number.isSafeInteger(limit) || limit<1 || limit>100) throw new Error('Invalid provider request')
    const offset=cursor===null?0:cursor?.offset
    if (!Number.isSafeInteger(offset) || offset<0 || offset>this.#operations.length || (cursor!==null && cursor.epoch!==this.epoch)) throw new Error('Invalid or expired cursor')
    const end=Math.min(offset+limit,this.#operations.length)
    const page={ epoch:this.epoch, operations:structuredClone(this.#operations.slice(offset,end)), cursor:{epoch:this.epoch,offset:end}, hasMore:end<this.#operations.length }
    await this.#fault('afterPull')
    const transform=this.#pageTransform;this.#pageTransform=undefined
    return transform?transform(page):page
  }
  exportState() { return structuredClone({id:this.id,epoch:this.epoch,operations:this.#operations}) }
  reset(epoch) { identifier(epoch); if (epoch===this.epoch) throw new Error('Reset requires a new epoch'); this.epoch=epoch; this.#operations=[] }
}
