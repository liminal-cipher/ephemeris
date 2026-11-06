import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { request } from 'node:http'
import path from 'node:path'
import { NativeVault } from '../vault.js'
import { HttpProvider } from '../sync/httpProvider.js'
import { synchronise, providerTargetId } from '../sync/engine.js'
import { digest } from '../validation.js'
import { CHUNK_BYTES } from '../sync/payloads.js'

async function fixture(t) {
  const root=mkdtempSync(path.join(realpathSync(tmpdir()),'ephemeris-http-process-')),token=randomBytes(32).toString('base64url'),config=path.join(root,'server.json')
  writeFileSync(config,JSON.stringify({directory:path.join(root,'server'),principals:[{tokenHash:digest(token),namespace:'test'}]}),{mode:0o600})
  const children=[],v=NativeVault.create(path.join(root,'v'))
  v.enableSync();v.enableRecovery();v.enablePayloads();v.create({id:'n'})
  const kill=async child=>{if(child.exitCode!==null||child.signalCode!==null)return;const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited}
  t.after(async()=>{for(const child of children)await kill(child);v.close();rmSync(root,{recursive:true,force:true})})
  const start=async()=>{
    const child=spawn(process.execPath,[path.resolve('native/sync-server.js'),config],{windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(child)
    const url=await new Promise((resolve,reject)=>{
      let output='',errors=''
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Provider startup timed out'))},10000)
      child.stderr.on('data',data=>{errors+=data.toString()})
      child.once('error',error=>{clearTimeout(timer);reject(error)})
      child.once('exit',()=>{clearTimeout(timer);reject(new Error('Provider exited before startup: '+errors))})
      child.stdout.on('data',data=>{output+=data.toString();if(output.includes('\n')){clearTimeout(timer);try{resolve(JSON.parse(output.split('\n')[0]).url)}catch(error){reject(error)}}})
    })
    return {child,url,provider:new HttpProvider({url,token,namespace:'test'})}
  }
  return {root,v,token,start,kill}
}
test('server process termination after acceptance replays the exact pending operation once',async t=>{
  const f=await fixture(t),first=await f.start(),info=await first.provider.info(),target=providerTargetId(info,'test')
  f.v.connectSync(target,info.epoch)
  const op=f.v.pendingSync(target)[0]
  await first.provider.publish(op,info.epoch)
  await f.kill(first.child)
  assert.equal(f.v.pendingSync(target).length,1)
  const second=await f.start()
  assert.deepEqual(await second.provider.info(),info)
  await synchronise(f.v,second.provider,{namespace:'test'})
  const page=await second.provider.pull(null,{epoch:info.epoch})
  assert.equal(page.operations.length,1);assert.deepEqual(page.operations[0],op)
  assert.equal(f.v.pendingSync(target).length,0)
})
test('termination during a partial chunk leaves no published content and supports retry',async t=>{
  const f=await fixture(t),first=await f.start(),info=await first.provider.info(),bytes=randomBytes(CHUNK_BYTES),hash=digest(bytes)
  let req
  const stopped=new Promise(resolve=>{
    req=request(first.url+'/v1/chunks/'+hash,{method:'PUT',headers:{authorization:`Bearer ${f.token}`,'x-ephemeris-namespace':'test','x-ephemeris-epoch':info.epoch,'content-type':'application/octet-stream','content-length':bytes.length}},res=>{res.resume();resolve()})
    req.on('error',resolve);req.write(bytes.subarray(0,10000))
  })
  await f.kill(first.child);req.destroy();await stopped
  const second=await f.start()
  assert.equal(await second.provider.hasChunk(hash,info.epoch),false)
  await second.provider.putChunk(hash,bytes,info.epoch)
  assert.deepEqual(Buffer.from(await second.provider.getChunk(hash,info.epoch)),bytes)
})
test('client CLI synchronises with the actual server and reports a completed pass',async t=>{
  const f=await fixture(t),server=await f.start(),file=path.join(f.root,'client.json')
  writeFileSync(file,JSON.stringify({url:server.url,token:f.token,namespace:'test'}),{mode:0o600})
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.resolve('native/sync-client.js'),f.v.directory,file],{windowsHide:true,stdio:['ignore','pipe','pipe']})
    let output='',errors='';child.stdout.on('data',data=>{output+=data});child.stderr.on('data',data=>{errors+=data})
    child.once('error',reject);child.once('exit',code=>resolve({code,output,errors}))
  })
  assert.equal(result.code,0,result.errors)
  const resultJson=JSON.parse(result.output)
  assert.equal(resultJson.hasMore,false);assert.equal(resultJson.waiting,0);assert.equal(resultJson.uploaded,1)
})
