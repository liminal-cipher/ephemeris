import { readFileSync, writeFileSync } from 'node:fs'
import { NativeVault } from '../vault.js'
import { SimulatedProvider } from '../sync/simulatedProvider.js'
import { synchronise } from '../sync/engine.js'
import { DatabaseSync } from 'node:sqlite'
const [directory,file,mode]=process.argv.slice(2)
const vault=NativeVault.open(directory),provider=new SimulatedProvider(JSON.parse(readFileSync(file,'utf8')))
if (mode==='downloaded') {
  let receiving=false
  const receive=vault.receiveSync.bind(vault),exec=DatabaseSync.prototype.exec
  vault.receiveSync=(...args)=>{receiving=true;return receive(...args)}
  DatabaseSync.prototype.exec=function(sql){if(receiving&&sql==='COMMIT')process.exit(24);return exec.call(this,sql)}
} else provider.failNext(mode==='accepted'?'afterAccept':'beforePublish',()=>{writeFileSync(file,JSON.stringify(provider.exportState()));process.exit(23)})
await synchronise(vault,provider)
