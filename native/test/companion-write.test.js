import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NativeVault } from '../vault.js'
import { startCompanion } from '../companion.js'
import { WRITE_PERMISSIONS } from '../companion-operations.js'
import { documentBytes } from './fixtures.js'

const origin = 'http://127.0.0.1:4179'
async function fixture(t, permissions = WRITE_PERMISSIONS, lifetimeMs) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'ephemeris-write-'))
  const directory = path.join(root, 'vault'), vault = NativeVault.create(directory), servers = []
  t.after(async () => { for (const server of servers) await server.close(); vault.close(); rmSync(root, { recursive: true, force: true }) })
  const start = async () => { const server = await startCompanion({ directory, origin, permissions, lifetimeMs }); servers.push(server); return server }
  const server = await start()
  const headers = { Origin: origin, Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' }
  const write = (operation, body, overrides = {}) => fetch(`${server.url}/v1/write/${operation}`, { method: 'POST', headers: { ...headers, ...overrides }, body: JSON.stringify(body) })
  return { vault, server, headers, write, start }
}

test('explicit editing session supports note lifecycle, exact Yjs and attachments with CAS', async t => {
  const { vault, server, headers, write, start } = await fixture(t)
  assert.ok(server.expiresAt <= Date.now() + 900000)
  const bytes = documentBytes('한국어 preserved')
  let response = await write('create', { id: 'one', metadata: { title: 'First' }, document: Buffer.from(bytes).toString('base64') })
  assert.equal(response.status, 200)
  let note = await response.json()
  const expected = () => ({ version: note.version, contentHash: note.contentHash })
  assert.deepEqual(vault.read('one').document, bytes)
  assert.equal((await write('create', { id: 'one' })).status, 409)
  await write('create', { id: 'parent' })
  response = await write('update', { id: note.id, expected: expected(), metadata: { title: 'Renamed', parentId: 'parent' } })
  assert.equal(response.status, 200); note = await response.json()
  assert.equal(note.metadata.parentId, 'parent')
  const old = expected()
  response = await write('attach', { id: note.id, expected: old, attachment: { id: 'file', metadata: { name: '../unsafe.html' }, bytes: Buffer.from('content').toString('base64') } })
  assert.equal(response.status, 200); note = await response.json()
  assert.equal((await write('delete', { id: note.id, expected: old })).status, 409)
  response = await write('delete', { id: note.id, expected: expected() }); note = await response.json()
  assert.notEqual(note.deleted, null)
  const deleted = await fetch(`${server.url}/v1/notes?deleted=true`, { headers }).then(r => r.json())
  assert.equal(deleted[0].id, note.id)
  response = await write('restore', { id: note.id, expected: expected() }); note = await response.json()
  assert.equal(note.deleted, null)
  assert.equal(note.metadata.parentId, null)
  assert.deepEqual(vault.read('one').document, bytes)
  assert.equal(vault.readAttachment('one', 'file').metadata.name, '../unsafe.html')
  await server.close()
  const reopened = await start()
  assert.equal(reopened.vaultId, server.vaultId)
  assert.notEqual(reopened.token, server.token)
})

test('permission, origin, content-type, unknown fields and missing versions fail closed', async t => {
  const { vault, server, write } = await fixture(t, ['notes:create'])
  const before = vault.changes().length
  for (const [operation, body, overrides, status] of [
    ['delete', { id: 'one' }, {}, 403],
    ['create', { id: 'one' }, { Origin: 'http://untrusted.example' }, 403],
    ['create', { id: 'one' }, { 'Content-Type': 'text/plain' }, 400],
    ['create', { id: 'one', path: '/private' }, {}, 400],
    ['create', { id: '../one' }, {}, 400],
    ['constructor', {}, {}, 404],
  ]) assert.equal((await write(operation, body, overrides)).status, status)
  assert.equal(vault.changes().length, before)
  const preflight = await fetch(`${server.url}/v1/write/create`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,authorization' } })
  assert.equal(preflight.status, 204)
})

test('independent writers cannot overwrite a newer version, even with the same content hash', async t => {
  const { vault, write } = await fixture(t)
  const note = vault.create({ id: 'race' }), expected = { version: note.version, contentHash: note.contentHash }
  const responses = await Promise.all(['A', 'B'].map(title => write('update', { id: 'race', expected, metadata: { title } })))
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409])
  assert.equal(vault.read('race').version, 2)
  assert.equal((await write('update', { id: 'race', metadata: { title: 'No version' } })).status, 400)
})

test('expired and excessive permissions cannot grant writes', async t => {
  await assert.rejects(startCompanion({ directory: '/unused', origin, permissions: ['filesystem:write'] }), /permissions/)
  await assert.rejects(startCompanion({ directory: '/unused', origin, permissions: ['notes:update'], lifetimeMs: 900001 }), /lifetime/)
  const { vault, write } = await fixture(t, ['notes:create'], 1)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal((await write('create', { id: 'expired' })).status, 401)
  assert.equal(vault.list().length, 0)
})
