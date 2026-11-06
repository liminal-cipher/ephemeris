import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { NativeVault } from '../vault.js'

function fixture(t) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'ephemeris-mcp-')), directory = path.join(root, 'vault'), vault = NativeVault.create(directory)
  const doc = new Y.Doc(), paragraph = new Y.XmlElement('paragraph'), text = new Y.XmlText(), link = new Y.XmlElement('mention')
  text.insert(0, '[ ] 한국어 source task\n[x] Completed task\nPrivate synthetic text')
  link.setAttribute('id', 'target'); link.setAttribute('label', 'Target')
  paragraph.insert(0, [text, link]); doc.getXmlFragment('default').insert(0, [paragraph])
  vault.create({ id: 'source', metadata: { title: 'Source', tags: ['local'], project: 'MCP' }, document: Y.encodeStateAsUpdate(doc) })
  vault.create({ id: 'target', metadata: { title: 'Target' } }); doc.destroy()
  t.after(() => { vault.close(); rmSync(root, { recursive: true, force: true }) })
  return { directory, vault }
}
function client(directory, scopes) {
  const child = spawn(process.execPath, ['native/mcp.js', '--vault', directory, ...(scopes ? ['--tools', scopes] : [])], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = once(child, 'exit'), pending = new Map(), unsolicited = []
  let next = 0, stderr = ''
  child.stderr.on('data', data => { stderr += data.toString() })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    const response = JSON.parse(line), item = pending.get(response.id)
    if (item) { pending.delete(response.id); clearTimeout(item.timeout); item.resolve(response) }
    else unsolicited.push(response)
  })
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++next, timeout = setTimeout(() => { pending.delete(id); reject(new Error('MCP response timed out')) }, 5000)
    pending.set(id, { resolve, reject, timeout }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n')
  })
  const initialise = async () => {
    const response = await request('initialize', { protocolVersion: '2025-11-25', clientInfo: { name: 'synthetic-test', version: '1' }, capabilities: {} })
    assert.equal(response.result.protocolVersion, '2025-11-25')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    return response
  }
  return { child, request, initialise, unsolicited, stderr: () => stderr, close: async () => { child.stdin.end(); await exited; lines.close() } }
}
const content = response => JSON.parse(response.result.content[0].text)

test('real stdio subprocess negotiates MCP, pages reads and exposes only bounded read-only tools', async t => {
  const { directory, vault } = fixture(t), before = vault.verify(), rpc = client(directory)
  try {
    assert.equal((await rpc.request('tools/list')).error.code, -32002)
    const initial = await rpc.initialise()
    assert.match(initial.result.instructions, /may transmit/)
    const tools = (await rpc.request('tools/list')).result.tools
    assert.equal(tools.length, 7)
    assert.ok(tools.every(tool => tool.annotations.readOnlyHint && !tool.annotations.openWorldHint))
    const call = (name, args = {}) => rpc.request('tools/call', { name, arguments: args })
    assert.equal(content(await call('list_notes', { limit: 1 })).nextOffset, 1)
    assert.equal(content(await call('search_notes', { query: '한국어' })).notes[0].id, 'source')
    const read = content(await call('read_note', { id: 'source', length: 5 }))
    assert.equal([...read.text].length, 5); assert.equal(read.nextOffset, 5)
    assert.deepEqual(content(await call('note_metadata', { id: 'source', fields: ['tags'] })).metadata, { tags: ['local'] })
    assert.deepEqual(content(await call('note_links', { id: 'source' })).noteIds, ['target'])
    assert.equal(content(await call('note_links', { id: 'target', direction: 'backlinks' })).notes[0].id, 'source')
    const tasks = content(await call('project_tasks', { project: 'MCP', completed: false })).notes[0].tasks
    assert.equal(tasks.length, 1); assert.equal(tasks[0].sourceLine, 1); assert.equal(tasks[0].text, '한국어 source task')
    assert.ok(content(await call('recent_changes')).changes.length >= 2)
    for (const args of [{ id: '../private' }, { id: 'source', sql: 'DROP TABLE notes' }, { id: 'source', length: 100000 }]) assert.equal((await call('read_note', args)).result.isError, true)
    assert.equal((await call('delete_note', { id: 'source' })).error.code, -32602)
    const large = vault.create({ id: 'large', metadata: { custom: 'private synthetic payload'.repeat(2000) } })
    assert.equal((await call('note_metadata', { id: large.id })).result.isError, true)
    assert.ok(rpc.stderr().length === 0, 'No note data or diagnostics on stderr during normal requests')
    assert.equal(rpc.unsolicited.length, 0)
    assert.deepEqual(vault.read('source').metadata, { title: 'Source', parentId: null, tags: ['local'], project: 'MCP' })
    assert.equal(vault.verify().notes, before.notes + 1)
  } finally { await rpc.close() }
})

test('tool allowlist is enforced independently of discovery and malformed messages do not disclose input', async t => {
  const { directory, vault } = fixture(t), before = vault.verify(), rpc = client(directory, 'list_notes')
  try {
    await rpc.initialise()
    assert.deepEqual((await rpc.request('tools/list')).result.tools.map(tool => tool.name), ['list_notes'])
    assert.equal((await rpc.request('tools/call', { name: 'read_note', arguments: { id: 'source' } })).error.code, -32602)
    rpc.child.stdin.write('private malformed input\n')
    await rpc.request('ping')
    assert.equal(rpc.unsolicited[0].error.code, -32700)
    assert.ok(!JSON.stringify(rpc.unsolicited).includes('private malformed'))
    assert.deepEqual(vault.verify(), before)
  } finally { await rpc.close() }
})
