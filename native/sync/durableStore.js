import { DatabaseSync } from 'node:sqlite'
import { randomUUID, randomBytes, createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { directoryPath, regularFile } from '../paths.js'
import { identifier, digest } from '../validation.js'
import { canonical, validateOperation } from './protocol.js'
import { ProviderError, byteLimit, MAX_PAGE_BYTES } from './limits.js'
import { CHUNK_BYTES, contentHash, verifyContent } from './payloads.js'

const APPLICATION_ID=1162892121
export const DEFAULT_PROVIDER_LIMITS=Object.freeze({operationBytes:2*1024*1024,totalOperationBytes:256*1024*1024,operations:100000,chunkBytes:512*1024*1024,chunks:262144,databaseBytes:2*1024*1024*1024})
export class DurableStore {
  #db
  #identity
  #now
  #ttl
  constructor(directory,{limits={},now=Date.now,cursorTtlMs=7*24*60*60*1000}={}) {
    const [major,minor]=process.versions.node.split('.').map(Number)
    if(major<24||(major===24&&minor<15))throw new Error('Sync provider requires Node >=24.15')
    this.limits={...DEFAULT_PROVIDER_LIMITS,...limits}
    if(Object.keys(this.limits).some(key=>!Object.hasOwn(DEFAULT_PROVIDER_LIMITS,key)||!Number.isSafeInteger(this.limits[key])||this.limits[key]<1||this.limits[key]>DEFAULT_PROVIDER_LIMITS[key]))throw new Error('Invalid provider limits')
    if(!Number.isSafeInteger(cursorTtlMs)||cursorTtlMs<1||cursorTtlMs>30*24*60*60*1000)throw new Error('Invalid cursor lifetime')
    this.#now=now;this.#ttl=cursorTtlMs
    const root=directoryPath(directory,!existsSync(directory)),file=path.join(root,'provider.sqlite'),create=!existsSync(file)
    if(!create)regularFile(file)
    for(const suffix of ['-wal','-shm','-journal'])if(existsSync(file+suffix))regularFile(file+suffix)
    this.#db=new DatabaseSync(file,{timeout:5000,allowExtension:false})
    try {
      if(!create&&(this.#db.prepare('PRAGMA application_id').get().application_id!==APPLICATION_ID||this.#db.prepare('PRAGMA user_version').get().user_version!==1))throw new Error('Unsupported provider database')
      this.#db.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL')
      if(create)this.#transaction(()=>{
        this.#db.exec(`
          PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;
          CREATE TABLE identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL, epoch TEXT NOT NULL, cursor_key BLOB NOT NULL) STRICT;
          CREATE TABLE operations (namespace TEXT NOT NULL, position INTEGER NOT NULL, id TEXT NOT NULL, client_id TEXT NOT NULL, sequence INTEGER NOT NULL, payload TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(namespace,position), UNIQUE(namespace,id), UNIQUE(namespace,client_id,sequence)) STRICT;
          CREATE TABLE chunks (namespace TEXT NOT NULL, sha256 TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(namespace,sha256)) STRICT;
          CREATE TABLE content (namespace TEXT NOT NULL, sha256 TEXT NOT NULL, manifest TEXT NOT NULL, PRIMARY KEY(namespace,sha256)) STRICT;
          CREATE TABLE revoked (token_hash TEXT PRIMARY KEY) STRICT;
        `)
        this.#db.prepare('INSERT INTO identity VALUES(1,?,?,?)').run(randomUUID(),randomUUID(),randomBytes(32))
      })
      if(this.#db.prepare('PRAGMA application_id').get().application_id!==APPLICATION_ID||this.#db.prepare('PRAGMA user_version').get().user_version!==1)throw new Error('Unsupported provider database')
      if(this.#db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw new Error('Corrupt provider database')
      if(this.#db.prepare("SELECT name FROM sqlite_schema WHERE type IN ('trigger','view')").all().length)throw new Error('Unsupported provider executable schema')
      this.#identity=this.#db.prepare('SELECT * FROM identity WHERE singleton=1').get()
      identifier(this.#identity.id);identifier(this.#identity.epoch)
      if(this.#identity.cursor_key.length!==32)throw new Error('Invalid provider cursor key')
      const pages=Math.floor(this.limits.databaseBytes/this.#db.prepare('PRAGMA page_size').get().page_size)
      if(this.#db.prepare('PRAGMA page_count').get().page_count>pages)throw new Error('Provider database exceeds page budget')
      this.#db.exec(`PRAGMA max_page_count=${pages}`)
    } catch(error){this.#db.close();throw error}
  }
  #transaction(action) {
    this.#db.exec('BEGIN IMMEDIATE')
    try{const result=action();this.#db.exec('COMMIT');return result}
    catch(error){if(this.#db.isTransaction)this.#db.exec('ROLLBACK');throw error}
  }
  #refreshEpoch(){this.#identity.epoch=this.#db.prepare('SELECT epoch FROM identity WHERE singleton=1').get().epoch}
  info(namespace) { identifier(namespace);this.#refreshEpoch();return {id:this.#identity.id,epoch:this.#identity.epoch,namespace,protocols:[1,2,3],chunkBytes:CHUNK_BYTES,operationBytes:this.limits.operationBytes} }
  #epoch(epoch) { this.#refreshEpoch();if(epoch!==this.#identity.epoch)throw new ProviderError('EPOCH_CHANGED','Remote epoch changed; explicit recovery required') }
  revoked(tokenHash) {return Boolean(this.#db.prepare('SELECT token_hash FROM revoked WHERE token_hash=?').get(tokenHash))}
  revoke(tokenHash) {contentHash(tokenHash);this.#transaction(()=>this.#db.prepare('INSERT OR IGNORE INTO revoked VALUES(?)').run(tokenHash))}
  rotateEpoch(expected) {
    this.#epoch(expected)
    const epoch=randomUUID()
    this.#transaction(()=>{this.#epoch(expected);this.#db.prepare('UPDATE identity SET epoch=? WHERE singleton=1').run(epoch)})
    this.#identity.epoch=epoch;return epoch
  }
  hasChunk(namespace,hash,epoch) {this.#epoch(epoch);contentHash(hash);return Boolean(this.#db.prepare('SELECT sha256 FROM chunks WHERE namespace=? AND sha256=?').get(namespace,hash))}
  getChunk(namespace,hash,epoch) {
    this.#epoch(epoch);contentHash(hash)
    const row=this.#db.prepare('SELECT bytes FROM chunks WHERE namespace=? AND sha256=?').get(namespace,hash)
    if(!row)throw new ProviderError('NOT_FOUND','Missing content chunk')
    if(digest(row.bytes)!==hash)throw new ProviderError('CORRUPT_STORAGE','Content integrity failure')
    return row.bytes
  }
  putChunk(namespace,hash,bytes,epoch) {
    this.#epoch(epoch);contentHash(hash)
    if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>CHUNK_BYTES||digest(bytes)!==hash)throw new ProviderError('INVALID_OPERATION','Invalid chunk')
    return this.#transaction(()=>{
      this.#epoch(epoch)
      if(this.hasChunk(namespace,hash,epoch)){this.getChunk(namespace,hash,epoch);return {sha256:hash,epoch}}
      const usage=this.#db.prepare('SELECT count(*) AS count,coalesce(sum(length(bytes)),0) AS bytes FROM chunks WHERE namespace=?').get(namespace)
      if(usage.count>=this.limits.chunks||usage.bytes+bytes.length>this.limits.chunkBytes)throw new ProviderError('QUOTA_EXCEEDED','Provider chunk quota exceeded')
      this.#db.prepare('INSERT INTO chunks VALUES(?,?,?)').run(namespace,hash,bytes)
      return {sha256:hash,epoch}
    })
  }
  publish(namespace,operation,epoch) {
    this.#epoch(epoch)
    let text
    try{validateOperation(operation);text=canonical(operation)}catch{throw new ProviderError('INVALID_OPERATION','Invalid sync operation')}
    const size=Buffer.byteLength(text)
    if(size>this.limits.operationBytes)throw new ProviderError('OPERATION_TOO_LARGE')
    return this.#transaction(()=>{
      this.#epoch(epoch)
      const prior=this.#db.prepare('SELECT payload FROM operations WHERE namespace=? AND (id=? OR (client_id=? AND sequence=?))').all(namespace,operation.id,operation.clientId,operation.sequence)
      if(prior.length){if(prior.length!==1||prior[0].payload!==text)throw new ProviderError('INVALID_OPERATION','Provider idempotency collision');return {id:operation.id,sha256:operation.sha256,epoch}}
      const usage=this.#db.prepare('SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes,coalesce(max(position),0) AS position FROM operations WHERE namespace=?').get(namespace)
      if(usage.count>=this.limits.operations||usage.bytes+size>this.limits.totalOperationBytes)throw new ProviderError('QUOTA_EXCEEDED','Provider operation quota exceeded')
      for(const a of operation.snapshot.attachments)if(a.content) {
        const manifest=canonical(a.content),old=this.#db.prepare('SELECT manifest FROM content WHERE namespace=? AND sha256=?').get(namespace,a.sha256)
        if(old && old.manifest!==manifest)throw new ProviderError('INVALID_OPERATION','Content identity reused')
        if(!old) {
          try{verifyContent(a.content,a.sha256,hash=>this.getChunk(namespace,hash,epoch))}catch{throw new ProviderError('INVALID_OPERATION','Missing or damaged content')}
          this.#db.prepare('INSERT INTO content VALUES(?,?,?)').run(namespace,a.sha256,manifest)
        }
      }
      this.#db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?,?)').run(namespace,usage.position+1,operation.id,operation.clientId,operation.sequence,text,size)
      return {id:operation.id,sha256:operation.sha256,epoch}
    })
  }
  #signature(text) {return createHmac('sha256',this.#identity.cursor_key).update(text).digest('base64url')}
  #cursor(namespace,offset) {
    const body=Buffer.from(JSON.stringify({namespace,epoch:this.#identity.epoch,offset,expires:this.#now()+this.#ttl})).toString('base64url')
    return body+'.'+this.#signature(body)
  }
  #offset(cursor,namespace,max) {
    if(cursor===null)return 0
    try {
      if(typeof cursor!=='string'||cursor.length>4096)throw new Error()
      const parts=cursor.split('.');if(parts.length!==2)throw new Error()
      const [body,signature]=parts,expected=this.#signature(body)
      if(signature.length!==expected.length||!timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))throw new Error()
      const value=JSON.parse(Buffer.from(body,'base64url').toString())
      if(value.namespace!==namespace||value.epoch!==this.#identity.epoch||!Number.isSafeInteger(value.offset)||value.offset<0||value.offset>max||!Number.isSafeInteger(value.expires)||value.expires<=this.#now())throw new Error()
      return value.offset
    }catch{throw new ProviderError('CURSOR_EXPIRED','Invalid or expired cursor')}
  }
  pull(namespace,cursor,{epoch,limit=50,maxBytes=MAX_PAGE_BYTES}={}) {
    this.#epoch(epoch)
    try{byteLimit(maxBytes);if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error()}catch{throw new ProviderError('INVALID_OPERATION','Invalid provider byte limit or count')}
    const max=this.#db.prepare('SELECT coalesce(max(position),0) AS position FROM operations WHERE namespace=?').get(namespace).position
    const offset=this.#offset(cursor,namespace,max)
    const rows=this.#db.prepare('SELECT position,bytes FROM operations WHERE namespace=? AND position>? ORDER BY position LIMIT ?').all(namespace,offset,limit)
    const operations=[];let bytes=0,end=offset
    for(const row of rows) {
      if(bytes+row.bytes>maxBytes){if(!operations.length)throw new ProviderError('OPERATION_TOO_LARGE');break}
      operations.push(JSON.parse(this.#db.prepare('SELECT payload FROM operations WHERE namespace=? AND position=?').get(namespace,row.position).payload))
      bytes+=row.bytes;end=row.position
    }
    return {epoch,operations,cursor:this.#cursor(namespace,end),hasMore:end<max}
  }
  close(){this.#db.close()}
}
