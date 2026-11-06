import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { DatabaseSync, backup } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import { request, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NativeVault } from '../vault.js'
import { startSyncServer, HttpProvider } from '../sync/httpProvider.js'
import { synchronise, providerTargetId } from '../sync/engine.js'
import { digest } from '../validation.js'
import { CHUNK_BYTES } from '../sync/payloads.js'
import { providerConformance } from './provider-conformance.js'
import { DurableStore } from '../sync/durableStore.js'

async function fixture(t,options={}) {
  const root=mkdtempSync(path.join(realpathSync(tmpdir()),'ephemeris-http-')),vaults=[]
  const token=randomBytes(32).toString('base64url'),otherToken=randomBytes(32).toString('base64url')
  const principals=[{tokenHash:digest(token),namespace:'alpha'},{tokenHash:digest(otherToken),namespace:'beta'}]
  let server
  const start=async()=>{server=await startSyncServer({directory:path.join(root,'server'),principals,...options});return new HttpProvider({url:server.url,token,namespace:'alpha'})}
  const provider=await start()
  const create=name=>{const v=NativeVault.create(path.join(root,name));vaults.push(v);v.enableSync();v.enableRecovery();v.enablePayloads();return v}
  const v=create('v');v.create({id:'n'});v.connectSync('fixture','epoch')
  t.after(async()=>{await server?.close();vaults.forEach(v=>v.close());rmSync(root,{recursive:true,force:true})})
  return {v,root,token,otherToken,provider,create,get server(){return server},operation:v.pendingSync('fixture')[0],reopen:async()=>{await server.close();return start()}}
}
providerConformance('HTTP SQLite provider',fixture)

test('authenticated HTTP synchronises real independent Vaults and chunked attachments',async t=>{
  const f=await fixture(t),b=f.create('b'),bytes=randomBytes(CHUNK_BYTES*3+7)
  f.v.putAttachment('n',{id:'image',bytes},f.v.read('n'))
  await synchronise(f.v,f.provider,{namespace:'alpha'});await synchronise(b,f.provider,{namespace:'alpha'})
  b.rename('n','remote edit',b.read('n'))
  await synchronise(b,f.provider,{namespace:'alpha'});await synchronise(f.v,f.provider,{namespace:'alpha'})
  assert.equal(f.v.read('n').metadata.title,'remote edit')
  assert.deepEqual(Buffer.from(b.readAttachment('n','image').bytes),bytes)
  const restarted=await f.reopen();await synchronise(f.v,restarted,{namespace:'alpha'})
  f.v.verify();b.verify()
})
test('authentication, namespace binding, browser origins and persistent revocation fail closed',async t=>{
  const f=await fixture(t),info=await f.provider.info()
  const bad=new HttpProvider({url:f.server.url,token:randomBytes(32).toString('base64url'),namespace:'alpha'})
  await assert.rejects(bad.info(),{code:'UNAUTHENTICATED'})
  const wrong=new HttpProvider({url:f.server.url,token:f.token,namespace:'beta'})
  await assert.rejects(wrong.publish(f.operation,info.epoch),{code:'FORBIDDEN'})
  const beta=new HttpProvider({url:f.server.url,token:f.otherToken,namespace:'beta'})
  await f.provider.publish(f.operation,info.epoch)
  assert.equal((await beta.pull(null,{epoch:info.epoch})).operations.length,0)
  const response=await fetch(f.server.url+'/v1/info',{headers:{authorization:`Bearer ${f.token}`,'x-ephemeris-namespace':'alpha',origin:'https://untrusted.invalid'}})
  assert.equal(response.status,403);await response.body.cancel()
  f.server.revoke(digest(f.token))
  await assert.rejects(f.provider.info(),{code:'REVOKED'})
  const restarted=await f.reopen();await assert.rejects(restarted.info(),{code:'REVOKED'})
})
test('chunk access and signed cursors are tenant bound',async t=>{
  const f=await fixture(t),info=await f.provider.info(),bytes=randomBytes(10),hash=digest(bytes)
  const beta=new HttpProvider({url:f.server.url,token:f.otherToken,namespace:'beta'})
  await f.provider.putChunk(hash,bytes,info.epoch)
  assert.equal(await beta.hasChunk(hash,info.epoch),false)
  await assert.rejects(beta.getChunk(hash,info.epoch),{code:'NOT_FOUND'})
  await f.provider.publish(f.operation,info.epoch)
  const page=await f.provider.pull(null,{epoch:info.epoch})
  await assert.rejects(beta.pull(page.cursor,{epoch:info.epoch}),{code:'CURSOR_EXPIRED'})
  await assert.rejects(f.provider.pull(page.cursor+'x',{epoch:info.epoch}),{code:'CURSOR_EXPIRED'})
})
test('expired cursors and changed epochs require explicit recovery while retaining local history',async t=>{
  let now=1000
  const f=await fixture(t,{now:()=>now,cursorTtlMs:10}),info=await f.provider.info(),target=providerTargetId(info,'alpha')
  await synchronise(f.v,f.provider,{namespace:'alpha'})
  const before=f.v.syncStatus(target),original=f.v.retainedSyncOperation(f.operation.id)
  now=1011
  await assert.rejects(synchronise(f.v,f.provider,{namespace:'alpha'}),{code:'CURSOR_EXPIRED'})
  assert.deepEqual(f.v.syncStatus(target),before)
  f.v.restartSyncTarget(target,info.epoch,info.epoch)
  await synchronise(f.v,f.provider,{namespace:'alpha'})
  const next=f.server.rotateEpoch(info.epoch)
  await assert.rejects(synchronise(f.v,f.provider,{namespace:'alpha'}),/epoch changed/)
  assert.throws(()=>f.v.restartSyncTarget(target,'stale',next),/Stale/)
  f.v.restartSyncTarget(target,info.epoch,next)
  await synchronise(f.v,f.provider,{namespace:'alpha'})
  assert.deepEqual(f.v.retainedSyncOperation(f.operation.id),original)
})
test('large requests are rejected from headers before receiving a body',async t=>{
  const f=await fixture(t),info=await f.provider.info()
  const status=await new Promise((resolve,reject)=>{
    const req=request(f.server.url+'/v1/operations',{method:'POST',headers:{authorization:`Bearer ${f.token}`,'x-ephemeris-namespace':'alpha','x-ephemeris-epoch':info.epoch,'content-type':'application/json','content-length':100000000}},res=>{res.resume();resolve(res.statusCode)})
    req.on('error',reject);req.flushHeaders()
  })
  assert.equal(status,413)
  assert.equal((await f.provider.pull(null,{epoch:info.epoch})).operations.length,0)
})
test('chunked bodies and wrong hashes are bounded; revocation is rechecked after reading',async t=>{
  const f=await fixture(t),info=await f.provider.info(),bytes=randomBytes(CHUNK_BYTES+1)
  const oversized=await fetch(f.server.url+'/v1/chunks/'+digest(bytes),{method:'PUT',headers:{authorization:`Bearer ${f.token}`,'x-ephemeris-namespace':'alpha','x-ephemeris-epoch':info.epoch,'content-type':'application/octet-stream'},body:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close()}}),duplex:'half'})
  assert.equal(oversized.status,413);await oversized.body.cancel()
  await assert.rejects(f.provider.putChunk('0'.repeat(64),Buffer.from('wrong'),info.epoch),{code:'INVALID_OPERATION'})
  const body=JSON.stringify(f.operation)
  const status=await new Promise((resolve,reject)=>{
    const req=request(f.server.url+'/v1/operations',{method:'POST',headers:{authorization:`Bearer ${f.token}`,'x-ephemeris-namespace':'alpha','x-ephemeris-epoch':info.epoch,'content-type':'application/json'}},res=>{res.resume();resolve(res.statusCode)})
    req.on('error',reject);req.write(body.slice(0,10))
    setImmediate(()=>{f.server.revoke(digest(f.token));req.end(body.slice(10))})
  })
  assert.equal(status,403)
})
test('SQLite full errors never acknowledge data and the server reopens consistently',async t=>{
  const f=await fixture(t,{limits:{databaseBytes:128*1024}}),info=await f.provider.info(),bytes=randomBytes(CHUNK_BYTES)
  await f.provider.publish(f.operation,info.epoch)
  await assert.rejects(f.provider.putChunk(digest(bytes),bytes,info.epoch),{code:'UNAVAILABLE'})
  assert.equal(await f.provider.hasChunk(digest(bytes),info.epoch),false)
  const reopened=await f.reopen(),page=await reopened.pull(null,{epoch:info.epoch})
  assert.deepEqual(page.operations,[f.operation])
})
test('HTTP client enforces transport security and cancelled requests leave uploads pending',async t=>{
  const f=await fixture(t)
  assert.throws(()=>new HttpProvider({url:'http://example.com',token:f.token,namespace:'alpha'}),/HTTPS/)
  const signal=AbortSignal.abort(new Error('cancelled'))
  await assert.rejects(synchronise(f.v,f.provider,{namespace:'alpha',signal}),/cancelled/)
  const info=await f.provider.info();assert.equal((await f.provider.pull(null,{epoch:info.epoch})).operations.length,0)
})
test('SQLite page-budget failure is SQLITE_FULL and leaves earlier rows committed',async t=>{
  const f=await fixture(t),store=new DurableStore(path.join(f.root,'bounded'),{limits:{databaseBytes:128*1024}})
  try {
    const epoch=store.info('alpha').epoch,bytes=randomBytes(CHUNK_BYTES)
    store.publish('alpha',f.operation,epoch)
    assert.throws(()=>store.putChunk('alpha',digest(bytes),bytes,epoch),error=>error.errcode===13)
    assert.deepEqual(store.pull('alpha',null,{epoch}).operations,[f.operation])
  }finally{store.close()}
})
test('provider quotas preserve pending deliveries without scheduling futile retries',async t=>{
  const f=await fixture(t,{limits:{operations:1}}),info=await f.provider.info(),target=providerTargetId(info,'alpha')
  await synchronise(f.v,f.provider,{namespace:'alpha'})
  f.v.rename('n','pending',f.v.read('n'))
  const before=f.v.syncStatus(target)
  await assert.rejects(synchronise(f.v,f.provider,{namespace:'alpha'}),{code:'QUOTA_EXCEEDED'})
  assert.deepEqual(f.v.syncStatus(target),before)
  assert.equal((await f.provider.pull(null,{epoch:info.epoch})).operations.length,1)
})
test('HTTP client refuses redirects and oversized streamed responses',async t=>{
  const f=await fixture(t)
  let redirect=true
  const server=createServer((_req,res)=>{
    if(redirect){res.writeHead(302,{location:f.server.url+'/v1/info'});res.end()}
    else {res.writeHead(200,{'content-type':'application/json'});res.write(' '.repeat(9000));res.end('{}')}
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
  const provider=new HttpProvider({url:`http://127.0.0.1:${server.address().port}`,token:f.token,namespace:'alpha'})
  await assert.rejects(provider.info(),/fetch failed/)
  redirect=false
  await assert.rejects(provider.info(),{code:'OPERATION_TOO_LARGE'})
})
test('an older server snapshot recovers lost operations from retained client history',async t=>{
  const f=await fixture(t),info=await f.provider.info(),target=providerTargetId(info,'alpha')
  await synchronise(f.v,f.provider,{namespace:'alpha'})
  const file=path.join(f.root,'server','provider.sqlite'),snapshot=path.join(f.root,'checkpoint.sqlite'),source=new DatabaseSync(file,{readOnly:true})
  try{await backup(source,snapshot)}finally{source.close()}
  const sealed=new DatabaseSync(snapshot);sealed.exec('PRAGMA journal_mode=DELETE');sealed.close()
  f.v.rename('n','surviving edit',f.v.read('n'));await synchronise(f.v,f.provider,{namespace:'alpha'})
  await f.server.close()
  copyFileSync(snapshot,file) // Isolated fixture: simulate restoring an older server backup.
  const restarted=await f.reopen()
  assert.equal((await restarted.pull(null,{epoch:info.epoch})).operations.length,1)
  const next=f.server.rotateEpoch(info.epoch)
  await assert.rejects(synchronise(f.v,restarted,{namespace:'alpha'}),/epoch changed/)
  f.v.restartSyncTarget(target,info.epoch,next)
  await synchronise(f.v,restarted,{namespace:'alpha'})
  assert.equal((await restarted.pull(null,{epoch:next})).operations.length,2)
  const fresh=f.create('fresh');await synchronise(fresh,restarted,{namespace:'alpha'})
  assert.equal(fresh.read('n').metadata.title,'surviving edit');f.v.verify();fresh.verify()
})
test('opening an unrelated SQLite database refuses it without changing its bytes',async t=>{
  const f=await fixture(t),directory=path.join(f.root,'foreign');mkdirSync(directory)
  const file=path.join(directory,'provider.sqlite'),db=new DatabaseSync(file)
  db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE original (value TEXT); INSERT INTO original VALUES (\'retain\')');db.close()
  const before=readFileSync(file)
  assert.throws(()=>new DurableStore(directory),/Unsupported provider database/)
  assert.deepEqual(readFileSync(file),before)
})
