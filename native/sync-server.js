import { readFileSync } from 'node:fs'
import { startSyncServer } from './sync/httpProvider.js'
import { readSyncConfig } from './sync-config.js'
import { regularFile } from './paths.js'

const [file,...extra]=process.argv.slice(2)
let server
try {
  if(!file||extra.length)throw new Error('Usage: node native/sync-server.js <absolute-private-server-config.json>')
  const config=readSyncConfig(file)
  if(config.tls) {
    const {keyFile,certFile}=config.tls
    if(regularFile(keyFile).size>65536||regularFile(certFile).size>65536)throw new Error('TLS file too large')
    config.tls={key:readFileSync(keyFile),cert:readFileSync(certFile)}
  }
  server=await startSyncServer(config)
  console.log(JSON.stringify({url:server.url}))
  for(const event of ['SIGINT','SIGTERM'])process.once(event,async()=>{await server.close();process.exit(0)})
}catch(error){await server?.close();console.error(error.message);process.exitCode=1}
