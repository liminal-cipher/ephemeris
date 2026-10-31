import { mkdtempSync,rmSync,realpathSync,statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import * as Y from 'yjs'
import { NativeVault } from './vault.js'
import { synchronise } from './sync/engine.js'
import { SimulatedProvider } from './sync/simulatedProvider.js'
import { hash } from './sync/protocol.js'

const mode=process.argv[2]??'payload',root=mkdtempSync(path.join(realpathSync(tmpdir()),'ephemeris-resources-'))
const a=NativeVault.create(path.join(root,'a')),b=NativeVault.create(path.join(root,'b')),p=new SimulatedProvider()
try {
  for(const v of [a,b]){v.enableSync();v.enableRecovery()}
  const start=performance.now();let count,details
  if(mode==='payload') {
    const doc=new Y.Doc();doc.getText('body').insert(0,'x'.repeat(1024*1024))
    a.create({id:'large',document:Y.encodeStateAsUpdate(doc)});doc.destroy()
    a.putAttachment('large',{id:'blob',bytes:new Uint8Array(32*1024*1024)},a.read('large'))
    await synchronise(a,p);await synchronise(b,p)
    let rejected=false
    try{a.rename('large','another full snapshot',a.read('large'))}catch(error){if(!/resource limit/.test(error.message))throw error;rejected=true}
    details={documentBytes:1024*1024,attachmentBytes:32*1024*1024,nextEditRejected:rejected}
  } else {
    a.create({id:'n'});await synchronise(a,p);await synchronise(b,p)
    const base=p.exportState().operations[0]
    for(let i=0;i<64;i++) {
      const body={protocol:1,id:`rival-${i}`,vaultId:`vault-${i}`,clientId:`client-${i}`,sequence:1,parents:[base.id],snapshot:{...base.snapshot,metadata:{...base.snapshot.metadata,title:`Choice ${i}`}},writes:['meta:title']}
      await p.publish({...body,sha256:hash(body)},p.epoch)
    }
    await synchronise(a,p);await synchronise(b,p);count=a.syncConflicts('n').length
    a.connectSync('lagging-target','epoch')
    details={rivals:64,conflicts:count,pendingOtherTarget:a.pendingSync('lagging-target').length}
  }
  const milliseconds=Math.round(performance.now()-start)
  a.close();b.close();console.log(JSON.stringify({mode,...details,milliseconds,peakRssKiB:process.resourceUsage().maxRSS,databaseBytes:statSync(path.join(root,'a','vault.sqlite')).size}))
} finally{a.close();b.close();rmSync(root,{recursive:true,force:true})}
