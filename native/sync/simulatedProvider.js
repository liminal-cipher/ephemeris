import { validateOperation, canonical } from './protocol.js'
import { identifier } from '../validation.js'
import { MAX_PAGE_BYTES, byteLimit, ProviderError } from './limits.js'

// A deterministic simulator, not a network transport. Exported state can be
// persisted by a test harness to model server durability across client crashes.
export class SimulatedProvider {
  #operations = []
  #faults = new Map()
  #pageTransform
  constructor({id='simulated',epoch='generation-1',operations=[],namespace='default'}={}) {
    identifier(id); identifier(epoch)
    identifier(namespace);this.namespace=namespace
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
  async info() { await this.#fault('info'); return {id:this.id,epoch:this.epoch,namespace:this.namespace,protocols:[1,2]} }
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
  async pull(cursor,{limit=50,epoch,maxBytes=MAX_PAGE_BYTES}={}) {
    byteLimit(maxBytes)
    await this.#fault('beforePull')
    if (epoch!==this.epoch || !Number.isSafeInteger(limit) || limit<1 || limit>100) throw new Error('Invalid provider request')
    const offset=cursor===null?0:cursor?.offset
    if (!Number.isSafeInteger(offset) || offset<0 || offset>this.#operations.length || (cursor!==null && (cursor.epoch!==this.epoch || (cursor.namespace??'default')!==this.namespace))) throw new ProviderError('CURSOR_EXPIRED','Invalid or expired cursor')
    let end=offset,bytes=0
    while(end<Math.min(offset+limit,this.#operations.length)) {
      const size=Buffer.byteLength(JSON.stringify(this.#operations[end]))
      if(bytes+size>maxBytes){if(end===offset)throw new ProviderError('OPERATION_TOO_LARGE');break}
      bytes+=size;end++
    }
    const page={ epoch:this.epoch, operations:structuredClone(this.#operations.slice(offset,end)), cursor:{epoch:this.epoch,offset:end,namespace:this.namespace}, hasMore:end<this.#operations.length }
    await this.#fault('afterPull')
    const transform=this.#pageTransform;this.#pageTransform=undefined
    return transform?transform(page):page
  }
  exportState() { return structuredClone({id:this.id,epoch:this.epoch,namespace:this.namespace,operations:this.#operations}) }
  reset(epoch) { identifier(epoch); if (epoch===this.epoch) throw new Error('Reset requires a new epoch'); this.epoch=epoch; this.#operations=[] }
}
