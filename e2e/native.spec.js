import { test, expect } from '@playwright/test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { NativeVault } from '../native/vault.js'
import { startCompanion } from '../native/companion.js'

const origin = 'http://127.0.0.1:4179'
function sessionFile(companion) {
  return { name: 'synthetic-session.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
    format: 'ephemeris-companion-session', version: 1, url: companion.url, origin,
    token: companion.token, expiresAt: companion.expiresAt,
  })) }
}

test('browser connects explicitly to a real native Vault and reads without altering either workspace', async ({ page }) => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'ephemeris-native-browser-'))
  const directory = path.join(root, 'vault'), vault = NativeVault.create(directory)
  const doc = new Y.Doc(); doc.getText('body').insert(0, '한국어 프로젝트 Native read only content')
  const first = vault.create({ id: 'native-note', metadata: { title: 'Native synthetic note', tags: ['테스트'] }, document: Y.encodeStateAsUpdate(doc) })
  doc.destroy()
  vault.putAttachment(first.id, { id: 'attachment', bytes: new Uint8Array([1, 2, 3]), metadata: { name: 'sample.bin' } }, first)
  const before = vault.verify()
  const companion = await startCompanion({ directory, origin })
  const requests = []
  page.on('request', request => requests.push({ url: request.url(), method: request.method() }))
  try {
    await page.goto('/')
    await expect(page.locator('.tiptap[contenteditable="true"]')).toBeVisible()
    const browserTitle = await page.getByPlaceholder('Untitled').inputValue()
    expect(requests.some(request => request.url.startsWith(companion.url))).toBe(false)
    await page.getByRole('button', { name: 'Native workspace', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Native workspace' })
    await dialog.getByLabel('Private session file').setInputFiles(sessionFile(companion))
    await dialog.getByRole('button', { name: 'Connect read only' }).click()
    await expect(dialog.getByText('Connected · Read only', { exact: true })).toBeVisible()
    await dialog.getByLabel('Search native notes').fill('프로젝트')
    await dialog.getByRole('button', { name: 'Search native Vault' }).click()
    await dialog.getByRole('button', { name: 'Native synthetic note', exact: true }).click()
    await expect(dialog.getByRole('article')).toContainText('한국어 프로젝트 Native read only content')
    const downloadEvent = page.waitForEvent('download')
    await dialog.getByRole('button', { name: 'Download attachment sample.bin' }).click()
    const downloaded = await downloadEvent
    expect(downloaded.suggestedFilename()).toBe('native-attachment.bin')
    await dialog.getByRole('button', { name: 'Inspect changes' }).click()
    await expect(dialog.getByRole('heading', { name: 'Change records' })).toBeVisible()
    expect(requests.filter(request => request.url.startsWith(companion.url)).every(request => request.method === 'GET' || request.method === 'OPTIONS')).toBe(true)
    const persisted = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))
    expect(persisted).not.toContain(companion.token)
    await dialog.getByRole('button', { name: 'Close native workspace' }).click()
    await expect(page.getByPlaceholder('Untitled')).toHaveValue(browserTitle)
    await page.getByRole('button', { name: 'Native workspace', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Connect read only' })).toBeDisabled()
    expect(vault.verify()).toEqual(before)
  } finally { await companion.close(); vault.close(); rmSync(root, { recursive: true, force: true }) }
})

test('a stopped companion shows an error while the browser editor remains functional', async ({ page }) => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'ephemeris-native-offline-'))
  const directory = path.join(root, 'vault'), vault = NativeVault.create(directory)
  const companion = await startCompanion({ directory, origin })
  const file = sessionFile(companion)
  await companion.close(); vault.close()
  try {
    await page.goto('/')
    await expect(page.locator('.tiptap[contenteditable="true"]')).toBeVisible()
    await page.getByRole('button', { name: 'Native workspace', exact: true }).click()
    await page.getByLabel('Private session file').setInputFiles(file)
    await page.getByRole('button', { name: 'Connect read only' }).click()
    await expect(page.getByRole('alert')).toContainText('Companion unavailable')
    await page.getByRole('button', { name: 'Close native workspace' }).click()
    await page.getByRole('button', { name: 'New Page', exact: true }).click()
    await page.getByPlaceholder('Untitled').fill('Browser still works')
    await page.locator('.tiptap[contenteditable="true"]').fill('Local browser content')
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  } finally { rmSync(root, { recursive: true, force: true }) }
})
