import { NativeVault } from './vault.js'
import { readSyncConfig } from './sync-config.js'
import { HttpProvider } from './sync/httpProvider.js'
import { providerTargetId, synchronise } from './sync/engine.js'

const [directory,file,action,acceptedEpoch,...extra]=process.argv.slice(2)
let vault
const controller=new AbortController()
for(const event of ['SIGINT','SIGTERM'])process.once(event,()=>controller.abort(new Error('Sync cancelled')))
try {
  if(!directory||!file||extra.length||(action&&!['--restart-cursor','--accept-epoch'].includes(action))||(action==='--restart-cursor'&&acceptedEpoch)||(action==='--accept-epoch'&&!acceptedEpoch))throw new Error('Usage: node native/sync-client.js <absolute-vault-directory> <absolute-private-client-config.json> [--restart-cursor | --accept-epoch <exact-new-epoch>]')
  const config=readSyncConfig(file),provider=new HttpProvider(config)
  vault=NativeVault.open(directory)
  if(action) {
    const info=await provider.info({signal:controller.signal}),target=providerTargetId(info,config.namespace),old=vault.syncCheckpoint(target)
    if(action==='--restart-cursor'&&old.epoch!==info.epoch)throw new Error('Epoch changed; explicitly accept the new epoch')
    if(action==='--accept-epoch'&&acceptedEpoch!==info.epoch)throw new Error('Accepted epoch does not match the provider')
    vault.restartSyncTarget(target,old.epoch,info.epoch)
  }
  let result,uploaded=0,applied=0
  for(let cycle=0;cycle<1000;cycle++) {
    result=await synchronise(vault,provider,{namespace:config.namespace,signal:controller.signal})
    uploaded+=result.uploaded;applied+=result.applied
    if(!result.hasMore||result.retryAt>Date.now())break
  }
  console.log(JSON.stringify({...result,uploaded,applied}))
  if(result.hasMore||result.waiting)process.exitCode=2
}catch(error){console.error(error.message);process.exitCode=1}finally{vault?.close()}
