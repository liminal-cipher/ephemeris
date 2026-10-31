import { DatabaseSync } from 'node:sqlite'
import { NativeVault } from '../vault.js'
const [directory,conflictId]=process.argv.slice(2)
const vault=NativeVault.open(directory),original=DatabaseSync.prototype.exec
DatabaseSync.prototype.exec=function(sql){if(sql==='COMMIT')process.exit(31);return original.call(this,sql)}
vault.resolveSyncConflict('x',conflictId,{value:null},{...vault.read('x'),heads:vault.syncHeads('x')})
