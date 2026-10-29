import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, realpathSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { request } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { NativeVault } from '../vault.js'
import { startCompanion } from '../companion.js'
import { documentBytes } from './fixtures.js'

async function setup(t) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'ephemeris-companion-'))
  const directory = path.join(root, 'vault'), vault = NativeVault.create(directory)
  const note = vault.create({ id: 'note', metadata: { title: 'Native read only' }, document: documentBytes('한국어 search') })
  vault.putAttachment(note.id, { id: 'blob', bytes: new Uint8Array([1, 2, 3]) }, note)
  const before = vault.verify()
  const origin = 'http://127.0.0.1:4179', companion = await startCompanion({ directory, origin })
  t.after(async () => { await companion.close(); vault.close(); rmSync(root, { recursive: true, force: true }) })
  const headers = { Origin: origin, Authorization: `Bearer ${companion.token}` }
  return { vault, before, directory, companion, origin, headers }
}

test('scoped companion reads notes, metadata, search, attachments and changes without writes', async t => {
  const { vault, before, companion, headers } = await setup(t)
  for (const url of ['/v1/notes', '/v1/note?id=note', '/v1/search?q=한국어', '/v1/changes']) {
    const response = await fetch(companion.url + url, { headers })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const result = await response.json()
    if (url.includes('/note?')) {
      assert.equal(result.id, 'note')
      assert.equal(result.preview.coverage, 'partial')
      assert.equal(result.document, Buffer.from(vault.read('note').document).toString('base64'))
    } else assert.ok(result.length > 0)
  }
  const attachment = await fetch(companion.url + '/v1/attachment?noteId=note&id=blob', { headers })
  assert.deepEqual(new Uint8Array(await attachment.arrayBuffer()), new Uint8Array([1, 2, 3]))
  assert.equal(attachment.headers.get('content-type'), 'application/octet-stream')
  assert.deepEqual(vault.verify(), before)
})

test('rejects missing credentials, wrong origin/host, writes and arbitrary filesystem/SQL requests', async t => {
  const { companion, headers } = await setup(t)
  for (const [changed, status] of [[{}, 403], [{ Origin: headers.Origin }, 401], [{ ...headers, Authorization: 'Bearer invalid' }, 401],
    [{ ...headers, Origin: 'http://evil.example' }, 403], [{ ...headers, Origin: 'null' }, 403]]) {
    assert.equal((await fetch(companion.url + '/v1/notes', { headers: changed })).status, status)
  }
  const badHost = await new Promise((resolve, reject) => {
    const req = request(companion.url + '/v1/notes', { headers: { ...headers, Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode) })
    req.on('error', reject); req.end()
  })
  assert.equal(badHost, 403)
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await fetch(companion.url + '/v1/notes', { method, headers })).status, 405)
  for (const url of ['/v1/note?id=..%2Fsecret', '/v1/notes?path=C%3A%2Fprivate', '/v1/notes?sql=DROP', '/v1/notes?limit=101', '/v1/search?q=a&q=b']) {
    assert.equal((await fetch(companion.url + url, { headers })).status, 400, url)
  }
  assert.equal((await fetch(companion.url + '/files/secret', { headers })).status, 404)
})

test('preflight allows only the configured origin, GET and Authorization', async t => {
  const { companion, origin } = await setup(t)
  const headers = { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' }
  const good = await fetch(companion.url + '/v1/notes', { method: 'OPTIONS', headers })
  assert.equal(good.status, 204)
  assert.equal(good.headers.get('access-control-allow-origin'), origin)
  assert.equal((await fetch(companion.url + '/v1/notes', { method: 'OPTIONS', headers: { ...headers, 'Access-Control-Request-Method': 'POST' } })).status, 403)
  assert.equal((await fetch(companion.url + '/v1/notes', { method: 'OPTIONS', headers: { ...headers, Origin: 'http://evil.example' } })).status, 403)
})

test('termination and restart rotate session credentials; old credentials never regain access', async t => {
  const { directory, origin, companion, headers } = await setup(t)
  const port = Number(new URL(companion.url).port)
  await companion.close()
  await assert.rejects(fetch(companion.url + '/v1/notes', { headers }))
  const restarted = await startCompanion({ directory, origin, port })
  try {
    assert.notEqual(restarted.token, companion.token)
    assert.equal((await fetch(restarted.url + '/v1/notes', { headers })).status, 401)
    assert.equal((await fetch(restarted.url + '/v1/notes', { headers: { ...headers, Authorization: `Bearer ${restarted.token}` } })).status, 200)
  } finally { await restarted.close() }
})

test('public origins and invalid ports cannot start a companion', async () => {
  for (const origin of ['*', 'null', 'https://example.com', 'http://localhost:4179/path', 'http://127.0.0.1:4179/']) await assert.rejects(startCompanion({ directory: '/unused', origin }))
  await assert.rejects(startCompanion({ directory: '/unused', origin: 'http://localhost:4179', port: -1 }))
})

test('serve CLI writes a private session file and never logs its bearer token', { timeout: 15000 }, async t => {
  const { directory, origin } = await setup(t)
  const file = path.join(path.dirname(directory), 'session.json')
  const child = spawn(process.execPath, ['native/serve.js', directory, origin, file], { stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = once(child, 'exit')
  try {
    const [line] = await once(child.stdout, 'data')
    const session = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(session.format, 'ephemeris-companion-session')
    assert.equal(session.token.length, 43)
    assert.equal(line.toString().includes(session.token), false)
    assert.equal((await fetch(session.url + '/v1/notes', { headers: { Origin: origin, Authorization: `Bearer ${session.token}` } })).status, 200)
  } finally { child.kill(); await exited }
})
