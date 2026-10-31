import { mkdtempSync, rmSync, realpathSync, statSync } from 'node:fs'
import { tmpdir, cpus } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { NativeVault } from './vault.js'
import { synchronise } from './sync/engine.js'
import { SimulatedProvider } from './sync/simulatedProvider.js'

const notes=Number(process.argv[2]??1000), edits=Number(process.argv[3]??200)
const recovery=process.argv.includes('--recovery')
const root=mkdtempSync(path.join(realpathSync(tmpdir()),'ephemeris-benchmark-'))
const a=NativeVault.create(path.join(root,'a')), b=NativeVault.create(path.join(root,'b'))
const timed=async fn=>{const start=performance.now();await fn();return Math.round(performance.now()-start)}
try {
  for (const v of [a,b]) {v.enableSync();if(recovery)v.enableRecovery()}
  const provider=new SimulatedProvider()
  const createMs=await timed(()=>{for(let i=0;i<notes;i++)a.create({id:`note-${i}`,metadata:{title:`Synthetic ${i}`}})})
  const editsMs=await timed(()=>{for(let i=0;i<edits;i++)a.rename('note-0',`Edit ${i}`,a.read('note-0'))})
  const syncMs=await timed(async()=>{
    let more=true;while(more)more=(await synchronise(a,provider)).hasMore
    await synchronise(b,provider)
  })
  const idleMs=await timed(()=>synchronise(b,provider))
  const output={node:process.version,platform:process.platform,cpu:cpus()[0].model,notes,edits,recovery,createMs,editsMs,syncMs,idleMs,peakRssKiB:process.resourceUsage().maxRSS}
  a.close();b.close();output.databaseBytes=statSync(path.join(root,'a','vault.sqlite')).size
  console.log(JSON.stringify(output))
} finally {a.close();b.close();rmSync(root,{recursive:true,force:true})}
