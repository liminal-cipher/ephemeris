import { MAX_PAGE_BYTES, byteLimit, pageBytes, permanentProviderError, ProviderError } from './limits.js'
import { hash } from './protocol.js'
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
    try {
      return await Promise.race([Promise.resolve().then(operation),new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(new Error('Sync provider timeout')),timeoutMs)
        abort=()=>reject(signal.reason ?? new Error('Sync aborted'))
        signal?.addEventListener('abort',abort,{once:true})
      })])
    } finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort',abort) }
  }
  vault.syncIdentity() // Explicit enableSync is required; never auto-migrate here.
  const info=await call(()=>provider.info())
  if((info.namespace??'default')!==namespace)throw new ProviderError('FORBIDDEN','Provider namespace mismatch')
  const target=providerTargetId(info,namespace)
  vault.connectSync(target,info.epoch)
  let uploaded=0,applied=0,waiting=0
  for (const op of vault.pendingSync(target,{now:now(),limit,maxBytes})) {
    try {
      const ack=await call(()=>provider.publish(op,info.epoch))
      if (!ack || ack.epoch!==info.epoch || ack.id!==op.id || ack.sha256!==op.sha256) throw new Error('Invalid provider acknowledgement')
      signal?.throwIfAborted()
      vault.acknowledgeSync(target,op.id,op.sha256); uploaded++
    } catch (error) { if(!permanentProviderError(error))vault.retrySync(target,op.id,now());throw error }
  }
  for (let i=0;i<maxPages;i++) {
    const cursor=vault.syncCheckpoint(target).cursor
    const page=await call(()=>provider.pull(cursor,{limit,epoch:info.epoch,maxBytes}))
    signal?.throwIfAborted()
    if(!page || !Array.isArray(page.operations) || page.operations.length>limit)throw new Error('Invalid provider page')
    pageBytes(page,maxBytes)
    const result=vault.receiveSync(target,cursor,page)
    applied+=result.applied; waiting=result.waiting
    if (!page.hasMore && !result.moreWork) return {uploaded,applied,waiting,hasMore:vault.pendingSync(target,{now:now(),limit:1,maxBytes}).length>0}
  }
  return {uploaded,applied,waiting,hasMore:true}
}
