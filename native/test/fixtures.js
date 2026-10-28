import * as Y from 'yjs'
import 'fake-indexeddb/auto'
import { BrowserVault } from '../../src/storage/browserVault.js'
import { createBackup } from '../../src/storage/backupFormat.js'
import { digest } from '../validation.js'

export function documentBytes(text = 'Native body') {
  const doc = new Y.Doc()
  try {
    doc.getText('body').insert(0, text)
    const widget = new Y.XmlElement('future-widget')
    widget.setAttribute('reference', 'child')
    doc.getXmlFragment('default').insert(0, [widget])
    doc.getMap('attachments').set('image', 'data:image/png;base64,aGVsbG8=')
    return Y.encodeStateAsUpdate(doc)
  } finally { doc.destroy() }
}

export async function browserBackup() {
  const browser = new BrowserVault({ prefix: `native-fixture-${crypto.randomUUID()}`, broadcast: false })
  try {
    await browser.ready
    const image = 'data:image/png;base64,aGVsbG8='
    browser.workspace.doc.getMap('pages').set('parent', { title: 'Parent', parentId: null, emoji: image, custom: { tags: ['keep'] } })
    browser.workspace.doc.getMap('pages').set('child', { title: 'Child', parentId: 'parent' })
    browser.workspace.doc.getMap('pages').set('legacy', { title: 'Legacy', parentId: null })
    browser.workspace.doc.getMap('recoveryDocuments').set('orphan', { originalId: 'old' })
    for (const id of ['parent', 'child', 'orphan']) {
      const document = browser.openDocument(id)
      await document.ready
      Y.applyUpdate(document.doc, documentBytes(id))
    }
    await browser.delete('child')
    const legacy = [{ id: 'parent', title: 'Original title', content: 'original recovery bytes' },
      { id: 'legacy', content: '{"type":"future-unsupported"}' }]
    const backup = await createBackup(browser, legacy, { ephemeris_custom_emojis: JSON.stringify([image]) })
    return { backup, text: JSON.stringify(backup) }
  } finally { await browser.close() }
}

export function rehash(backup) {
  backup.sha256 = digest(JSON.stringify(backup.payload))
  return JSON.stringify(backup)
}
