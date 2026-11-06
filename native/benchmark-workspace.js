import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir, platform, arch, cpus } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { randomBytes, createHash } from 'node:crypto'
import * as Y from 'yjs'
import { NativeVault } from './vault.js'
import { restoreNativeBackup } from './backup.js'

const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'ephemeris-workspace-bench-')), handles = []
const measure = operation => { const start = performance.now(); const value = operation(); return { ms: +(performance.now() - start).toFixed(2), value } }
const times = operation => {
  const samples = Array.from({ length: 20 }, () => measure(operation).ms).sort((a, b) => a - b)
  return { medianMs: samples[10], p95Ms: samples[18], maxMs: samples[19] }
}
try {
  const vault = NativeVault.create(path.join(root, 'vault')); handles.push(vault)
  const doc = new Y.Doc(), paragraph = new Y.XmlElement('paragraph'), text = new Y.XmlText()
  text.insert(0, '한국어 synthetic workspace search. '.repeat(12)); paragraph.insert(0, [text]); doc.getXmlFragment('default').push([paragraph])
  const bytes = Y.encodeStateAsUpdate(doc); doc.destroy()
  const create = measure(() => {
    for (let index = 0; index < 3000; index++) vault.create({ id: 'note-' + String(index).padStart(4, '0'), document: bytes,
      metadata: { title: 'Synthetic ' + index, tags: [index % 2 ? 'odd' : 'even'], project: 'benchmark', status: index % 3 ? 'todo' : 'done', parentId: index > 0 && index < 256 ? 'note-' + String(index - 1).padStart(4, '0') : null } })
  })
  const list = times(() => vault.listPage({ limit: 20 })), search = times(() => vault.search('한국어', { limit: 50 })), shortSearch = times(() => vault.search('어', { limit: 50 }))
  const view = times(() => vault.queryNotes({ tag: 'odd', status: 'todo', limit: 30 })), recentView = times(() => vault.queryNotes({ sort: 'recent', limit: 30 }))
  const other = NativeVault.open(path.join(root, 'vault')); handles.push(other)
  const edits = measure(() => { for (let index = 0; index < 100; index++) { const client = index % 2 ? other : vault; client.rename('note-0000', 'Edit ' + index, client.read('note-0000')) } })
  const attachment = randomBytes(8 * 1024 * 1024), hash = createHash('sha256').update(attachment).digest('hex')
  const attach = measure(() => vault.putAttachment('note-0000', { id: 'large', bytes: attachment }, vault.read('note-0000')))
  const backupStart = performance.now(); await vault.exportBackup(path.join(root, 'backup')); const backupMs = +(performance.now() - backupStart).toFixed(2)
  const restoreStart = performance.now(); await restoreNativeBackup(path.join(root, 'backup'), path.join(root, 'restored')); const restoreMs = +(performance.now() - restoreStart).toFixed(2)
  const restored = NativeVault.open(path.join(root, 'restored')); handles.push(restored)
  if (createHash('sha256').update(restored.readAttachment('note-0000', 'large').bytes).digest('hex') !== hash) throw new Error('Attachment round-trip mismatch')
  restored.rename('note-0000', 'Editable after restore', restored.read('note-0000'))
  if (restored.listPage({ limit: 1 })[0].metadata.title !== 'Editable after restore') throw new Error('Restored edit failed')
  console.log(JSON.stringify({ environment: { platform: platform(), arch: arch(), node: process.version, cpu: cpus()[0].model },
    notes: 3000, hierarchyDepth: 256, createMs: create.ms, list, search, shortSearch, view, recentView,
    sequentialEditsAcrossTwoHandles: 100, editMs: edits.ms, attachmentBytes: attachment.length, attachMs: attach.ms, backupMs, restoreMs,
    verifiedAttachmentAndSubsequentEdit: true, maxRssKiB: process.resourceUsage().maxRSS }, null, 2))
} finally { handles.forEach(vault => vault.close()); rmSync(root, { recursive: true, force: true }) }
