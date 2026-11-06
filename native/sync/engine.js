import { MAX_PAGE_BYTES, byteLimit, pageBytes, permanentProviderError, ProviderError } from './limits.js'
import { hash, validateOperation } from './protocol.js'
import { chunkIds } from './payloads.js'
export const providerTargetId=(info,namespace='default')=>namespace==='default'?info.id:'namespace-'+hash({id:info.id,namespace})
// Provider: info(), publish(operation, epoch), pull(cursor, {limit, epoch}).
// Providers must durably accept before returning an acknowledgement; retries
// reuse the exact operation ID and checksum. No storage connection is exposed.
export async function synchronise(vault,provider,{now=Date.now,limit=50,maxPages=100,signal,timeoutMs=10000,maxBytes=MAX_PAGE_BYTES,namespace='default'}={}) {
  byteLimit(maxBytes)
  if (!Number.isSafeInteger(limit) || limit<1 || limit>100 || !Number.isSafeInteger(maxPages) || maxPages<1 || maxPages>1000 || !Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>60000) throw new Error('Invalid sync options')
  const call=async operation=>{
    signal?.throwIfAborted()
    let timer,abort
    const controller=new AbortController()
    try {
      return await Promise.race([Promise.resolve().then(()=>operation(controller.signal)),new Promise((_,reject)=>{
        timer=setTimeout(()=>{const error=new Error('Sync provider timeout');controller.abort(error);reject(error)},timeoutMs)
        abort=()=>{const error=signal.reason ?? new Error('Sync aborted');controller.abort(error);reject(error)}
        signal?.addEventListener('abort',abort,{once:true})
        if(signal?.aborted)abort()
      })])
    } finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort',abort) }
  }
  vault.syncIdentity() // Explicit enableSync is required; never auto-migrate here.
  const info=await call(signal=>provider.info({signal}))
  if((info.namespace??'default')!==namespace)throw new ProviderError('FORBIDDEN','Provider namespace mismatch')
  const target=providerTargetId(info,namespace)
  vault.connectSync(target,info.epoch)
  let uploaded=0,applied=0,waiting=0
  const sentChunks=new Set()
  for (const op of vault.pendingSync(target,{now:now(),limit,maxBytes})) {
    try {
      if(!(info.protocols??[1]).includes(op.protocol))throw new ProviderError('INVALID_OPERATION','Provider does not support operation protocol')
      for(const hash of chunkIds(op)) {
        if(sentChunks.has(hash))continue
        if(!await call(signal=>provider.hasChunk(hash,info.epoch,{signal}))) {
          const ack=await call(signal=>provider.putChunk(hash,vault.readSyncChunk(hash),info.epoch,{signal}))
          if(ack?.sha256!==hash || ack?.epoch!==info.epoch)throw new Error('Invalid chunk acknowledgement')
        }
        sentChunks.add(hash)
      }
      const ack=await call(signal=>provider.publish(op,info.epoch,{signal}))
      if (!ack || ack.epoch!==info.epoch || ack.id!==op.id || ack.sha256!==op.sha256) throw new Error('Invalid provider acknowledgement')
      signal?.throwIfAborted()
      vault.acknowledgeSync(target,op.id,op.sha256); uploaded++
    } catch (error) { if(!permanentProviderError(error))vault.retrySync(target,op.id,now());throw error }
  }
  for (let i=0;i<maxPages;i++) {
    const cursor=vault.syncCheckpoint(target).cursor
    const page=await call(signal=>provider.pull(cursor,{limit,epoch:info.epoch,maxBytes,signal}))
    signal?.throwIfAborted()
    if(!page || !Array.isArray(page.operations) || page.operations.length>limit)throw new Error('Invalid provider page')
    pageBytes(page,maxBytes)
    for(const op of page.operations) {
      validateOperation(op)
      for(const hash of chunkIds(op))if(!vault.hasSyncChunk(hash)) {
        const bytes=await call(signal=>provider.getChunk(hash,info.epoch,{signal}))
        signal?.throwIfAborted();vault.receiveSyncChunk(hash,bytes)
      }
    }
    const result=vault.receiveSync(target,cursor,page)
    applied+=result.applied; waiting=result.waiting
    if (!page.hasMore && !result.moreWork) {
      const queue=vault.syncQueue(target)
      return {uploaded,applied,waiting,hasMore:queue.pending>0,...(queue.retryAt>now()?{retryAt:queue.retryAt}:{})}
    }
  }
  return {uploaded,applied,waiting,hasMore:true}
}
