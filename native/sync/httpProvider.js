import { createServer } from 'node:http'
import { createServer as createSecureServer } from 'node:https'
import { digest, identifier } from '../validation.js'
import { DurableStore } from './durableStore.js'
import { CHUNK_BYTES, contentHash } from './payloads.js'
import { ProviderError, MAX_PAGE_BYTES, byteLimit } from './limits.js'

const STATUS={UNAUTHENTICATED:401,FORBIDDEN:403,REVOKED:403,NOT_FOUND:404,EPOCH_CHANGED:409,CURSOR_EXPIRED:410,INVALID_OPERATION:400,OPERATION_TOO_LARGE:413,QUOTA_EXCEEDED:507,UNAVAILABLE:503,CORRUPT_STORAGE:503}
export const HTTP_PAGE_BYTES=4*1024*1024
const loopback=host=>['127.0.0.1','::1','[::1]'].includes(host)
const lengthOf=headers=>{
  const value=headers.get?headers.get('content-length'):headers['content-length']
  if(value==null)return null
  if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value)))throw new ProviderError('INVALID_OPERATION','Invalid content length')
  return Number(value)
}
function readRequest(req,maxBytes) {
  const length=lengthOf(req.headers)
  if(length!==null&&length>maxBytes)throw new ProviderError('OPERATION_TOO_LARGE')
  return new Promise((resolve,reject)=>{
    const chunks=[];let bytes=0
    const cleanup=()=>{req.off('data',data);req.off('end',end);req.off('error',error);req.off('aborted',aborted)}
    const error=err=>{cleanup();req.pause();reject(err)}
    const aborted=()=>error(new ProviderError('UNAVAILABLE','Request aborted'))
    const data=chunk=>{bytes+=chunk.length;if(bytes>maxBytes)error(new ProviderError('OPERATION_TOO_LARGE'));else chunks.push(chunk)}
    const end=()=>{cleanup();resolve(Buffer.concat(chunks,bytes))}
    req.on('data',data);req.once('end',end);req.once('error',error);req.once('aborted',aborted)
  })
}
async function requestJson(req,maxBytes) {
  if(req.headers['content-type']!=='application/json')throw new ProviderError('INVALID_OPERATION','Expected JSON')
  const bytes=await readRequest(req,maxBytes)
  try{return JSON.parse(bytes.toString('utf8'))}catch{throw new ProviderError('INVALID_OPERATION','Invalid JSON')}
}

// Credentials are injected by the caller, never returned by the server or
// written to logs. Only revocation hashes are persisted beside provider data.
export async function startSyncServer({directory,principals,host='127.0.0.1',port=0,tls,authority,...options}) {
  if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid provider port')
  if(!loopback(host)&&!tls)throw new Error('Non-loopback sync requires TLS')
  if(!Array.isArray(principals)||!principals.length)throw new Error('Provider principals required')
  const tokens=new Map()
  for(const p of principals){contentHash(p.tokenHash);identifier(p.namespace);if(tokens.has(p.tokenHash))throw new Error('Duplicate principal');tokens.set(p.tokenHash,{...p})}
  const store=new DurableStore(directory,options)
  let closing=false,active=0,expectedHost
  const authenticate=req=>{
    if(closing)throw new ProviderError('UNAVAILABLE')
    if(req.headers.host!==expectedHost||req.headers.origin||req.headers['sec-fetch-site'])throw new ProviderError('FORBIDDEN')
    for(const key of ['authorization','x-ephemeris-namespace','x-ephemeris-epoch'])if((req.headersDistinct[key]?.length??0)>1)throw new ProviderError('INVALID_OPERATION')
    const match=/^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(req.headers.authorization??'')
    if(!match)throw new ProviderError('UNAUTHENTICATED')
    const tokenHash=digest(match[1]),principal=tokens.get(tokenHash)
    if(!principal)throw new ProviderError('UNAUTHENTICATED')
    if(principal.revoked||store.revoked(tokenHash))throw new ProviderError('REVOKED')
    if(req.headers['x-ephemeris-namespace']!==principal.namespace)throw new ProviderError('FORBIDDEN')
    return principal.namespace
  }
  const handler=async(req,res)=>{
    res.setHeader('Cache-Control','no-store')
    let counted=false
    const release=()=>{if(counted){active--;counted=false}}
    const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value))}
    try {
      const namespace=authenticate(req)
      if(active>=16)throw new ProviderError('UNAVAILABLE')
      active++;counted=true
      res.once('finish',release);res.once('close',release)
      req.setTimeout(10000,()=>req.destroy())
      const epoch=req.headers['x-ephemeris-epoch']
      if(req.method==='GET'&&req.url==='/v1/info'){json(200,store.info(namespace));return}
      if(req.method==='POST'&&req.url==='/v1/operations') {
        const op=await requestJson(req,store.limits.operationBytes);authenticate(req)
        json(200,store.publish(namespace,op,epoch));return
      }
      if(req.method==='POST'&&req.url==='/v1/pull') {
        const body=await requestJson(req,8192);authenticate(req)
        if(!body||Object.keys(body).sort().join(',')!=='cursor,limit,maxBytes')throw new ProviderError('INVALID_OPERATION')
        byteLimit(body.maxBytes)
        json(200,store.pull(namespace,body.cursor,{...body,maxBytes:Math.min(body.maxBytes,HTTP_PAGE_BYTES),epoch}));return
      }
      const match=/^\/v1\/chunks\/([a-f0-9]{64})$/.exec(req.url??'')
      if(match) {
        const hash=match[1]
        if(req.method==='HEAD'){res.writeHead(store.hasChunk(namespace,hash,epoch)?200:404);res.end();return}
        if(req.method==='GET') {
          const bytes=store.getChunk(namespace,hash,epoch)
          res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':bytes.length});res.end(bytes);return
        }
        if(req.method==='PUT') {
          if(req.headers['content-type']!=='application/octet-stream')throw new ProviderError('INVALID_OPERATION')
          const bytes=await readRequest(req,CHUNK_BYTES);authenticate(req)
          json(200,store.putChunk(namespace,hash,bytes,epoch));return
        }
      }
      throw new ProviderError('NOT_FOUND')
    }catch(error) {
      const code=error instanceof ProviderError&&Object.hasOwn(STATUS,error.code)?error.code:'UNAVAILABLE'
      if(!res.headersSent&&!res.destroyed){res.setHeader('Connection','close');json(STATUS[code],{code,message:code==='CURSOR_EXPIRED'?'Invalid or expired cursor':code})}
      else res.destroy()
    }finally{if(res.destroyed)release()}
  }
  let server
  try {
    server=tls?createSecureServer({...tls,maxHeaderSize:8192},handler):createServer({maxHeaderSize:8192},handler)
    server.maxConnections=64;server.maxRequestsPerSocket=100;server.requestTimeout=10000;server.headersTimeout=5000
    server.on('checkContinue',(req,res)=>{res.setHeader('Connection','close');res.writeHead(417);res.end()})
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve)})
    const address=server.address(),hostname=host.includes(':')?`[${host}]`:host
    expectedHost=authority??`${hostname}:${address.port}`
    return {url:`${tls?'https':'http'}://${expectedHost}`,info:namespace=>store.info(namespace),
      revoke:hash=>store.revoke(hash),rotateEpoch:expected=>store.rotateEpoch(expected),
      close:async()=>{if(closing)return;closing=true;server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));store.close()}}
  }catch(error){server?.close();store.close();throw error}
}

async function responseBytes(response,maxBytes) {
  if((lengthOf(response.headers)??0)>maxBytes){await response.body?.cancel();throw new ProviderError('OPERATION_TOO_LARGE','Provider response exceeds byte limit')}
  let size=0;const chunks=[]
  for await(const chunk of response.body??[]) {
    size+=chunk.length
    if(size>maxBytes)throw new ProviderError('OPERATION_TOO_LARGE','Provider response exceeds byte limit')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks,size)
}
export class HttpProvider {
  #token
  constructor({url,token,namespace,timeoutMs=10000,maxOperationBytes=2*1024*1024}) {
    const base=new URL(url)
    if(base.username||base.password||base.search||base.hash||base.pathname!=='/'||!(base.protocol==='https:'||(base.protocol==='http:'&&loopback(base.hostname))))throw new Error('Provider requires HTTPS or explicit loopback HTTP')
    if(typeof token!=='string'||!/^[A-Za-z0-9_-]{32,256}$/.test(token))throw new Error('Invalid provider token')
    identifier(namespace)
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000||!Number.isSafeInteger(maxOperationBytes)||maxOperationBytes<1||maxOperationBytes>2*1024*1024)throw new Error('Invalid HTTP provider limits')
    this.url=base.origin;this.namespace=namespace;this.timeoutMs=timeoutMs;this.maxOperationBytes=maxOperationBytes;this.#token=token
  }
  async #request(route,{method='GET',body,epoch,signal,binary=false,maxBytes=8192,missing=false}={}) {
    const headers={authorization:`Bearer ${this.#token}`,'x-ephemeris-namespace':this.namespace}
    if(epoch!==undefined)headers['x-ephemeris-epoch']=epoch
    let encoded
    if(body!==undefined){encoded=binary?body:JSON.stringify(body);headers['content-type']=binary?'application/octet-stream':'application/json'}
    if(encoded!==undefined&&Buffer.byteLength(encoded)>(binary?CHUNK_BYTES:route==='/v1/operations'?this.maxOperationBytes:8192))throw new ProviderError('OPERATION_TOO_LARGE')
    const response=await fetch(this.url+route,{method,headers,body:encoded,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(this.timeoutMs)]):AbortSignal.timeout(this.timeoutMs)})
    if(missing&&response.status===404){await response.body?.cancel();return false}
    if(!response.ok) {
      let value
      try{value=JSON.parse((await responseBytes(response,8192)).toString())}catch{throw new ProviderError('INVALID_RESPONSE')}
      const code=Object.hasOwn(STATUS,value?.code)?value.code:'INVALID_RESPONSE'
      throw new ProviderError(code,code==='CURSOR_EXPIRED'?'Invalid or expired cursor':code)
    }
    if(method==='HEAD')return true
    const bytes=await responseBytes(response,maxBytes)
    if(binary&&method==='GET')return bytes
    try{return JSON.parse(bytes.toString())}catch{throw new ProviderError('INVALID_RESPONSE')}
  }
  info(options={}) {return this.#request('/v1/info',options)}
  publish(operation,epoch,options={}) {return this.#request('/v1/operations',{...options,method:'POST',body:operation,epoch})}
  async pull(cursor,{epoch,limit=50,maxBytes=MAX_PAGE_BYTES,signal}={}) {byteLimit(maxBytes);maxBytes=Math.min(maxBytes,HTTP_PAGE_BYTES);return this.#request('/v1/pull',{method:'POST',body:{cursor,limit,maxBytes},epoch,signal,maxBytes:maxBytes+8192})}
  hasChunk(hash,epoch,options={}) {contentHash(hash);return this.#request('/v1/chunks/'+hash,{...options,method:'HEAD',epoch,missing:true})}
  putChunk(hash,bytes,epoch,options={}) {contentHash(hash);return this.#request('/v1/chunks/'+hash,{...options,method:'PUT',body:bytes,binary:true,epoch})}
  async getChunk(hash,epoch,options={}) {
    contentHash(hash)
    const bytes=await this.#request('/v1/chunks/'+hash,{...options,binary:true,epoch,maxBytes:CHUNK_BYTES})
    if(digest(bytes)!==hash)throw new ProviderError('INVALID_RESPONSE','Chunk integrity failure')
    return bytes
  }
}
