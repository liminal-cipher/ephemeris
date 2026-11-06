import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, symlinkSync, rmSync, unlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { NativeVault } from '../vault.js'

function paths(t) {
  const root=mkdtempSync(path.join(realpathSync(tmpdir()),'ephemeris-path-test-'))
  const alias=path.join(root,'temp-alias')
  symlinkSync(root,alias,process.platform==='win32'?'junction':'dir')
  t.after(()=>{unlinkSync(alias);rmSync(root,{recursive:true,force:true})})
  return {root,alias}
}
test('trusted fixture roots work when the OS temporary path contains a directory alias',t=>{
  const {alias}=paths(t)
  const env={...process.env,TMP:alias,TEMP:alias,TMPDIR:alias}
  delete env.NODE_TEST_CONTEXT
  const result=spawnSync(process.execPath,['--test','--test-name-pattern=^native content, metadata',path.resolve('native/test/vault.test.js')],{
    env,encoding:'utf8',timeout:30000,windowsHide:true,
  })
  assert.equal(result.status,0,result.stdout+result.stderr)
  assert.match(result.stdout,/tests 1/)
})
test('untrusted alias traversal remains rejected for opening and creating production Vaults',t=>{
  const {root,alias}=paths(t),vault=NativeVault.create(path.join(root,'existing'))
  try {
    assert.throws(()=>NativeVault.open(path.join(alias,'existing')),/real local directories/)
    assert.throws(()=>NativeVault.create(path.join(alias,'new')),/real local directories/)
    assert.equal(existsSync(path.join(root,'new')),false)
    const reopened=NativeVault.open(path.join(realpathSync(alias),'existing'))
    reopened.close()
  }finally{vault.close()}
})
