import { test, expect } from '@playwright/test'
import { mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NativeVault } from '../native/vault.js'
import { startCompanion } from '../native/companion.js'
import { WRITE_PERMISSIONS } from '../native/companion-operations.js'

// Intercept only synthetic local traffic to deterministically hold real replies.
test.use({ serviceWorkers: 'block' })
const origin = 'http://127.0.0.1:4179'
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
// The bundled Firefox crashed on locator.dispatchEvent for this React modal;
// constructing the same synthetic composition key in the page realm succeeds.
const composingKey = (locator, key) => locator.evaluate((element, key) => element.dispatchEvent(
  new KeyboardEvent('keydown', { key, isComposing: true, bubbles: true, cancelable: true })), key)
async function fixture() {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'ephemeris-ui-resilience-'))
  const directory = path.join(root, 'vault'), vault = NativeVault.create(directory)
  const companion = await startCompanion({ directory, origin, permissions: WRITE_PERMISSIONS })
  const session = { format: 'ephemeris-companion-session', version: 2, url: companion.url, token: companion.token,
    origin, expiresAt: companion.expiresAt, vaultId: companion.vaultId, permissions: companion.permissions }
  return { vault, companion, file: { name: 'synthetic-session.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(session)) },
    close: async () => { await companion.close(); vault.close(); rmSync(root, { recursive: true, force: true }) } }
}
async function connect(page, file) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Native workspace', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Native workspace' })
  await dialog.getByLabel('Private session file').setInputFiles(file)
  await dialog.getByRole('button', { name: 'Connect for editing' }).click()
  await expect(dialog.getByRole('button', { name: 'New native note', exact: true })).toBeEnabled()
  return dialog
}

test('native actions retain ownership until the real write finishes', async ({ page }, testInfo) => {
  const f = await fixture(), held = deferred(), reached = deferred(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    const dialog = await connect(page, f.file)
    await dialog.getByRole('button', { name: 'New native note', exact: true }).focus()
    await page.keyboard.press('Delete')
    await expect(page.locator('.custom-modal-overlay')).toHaveCount(0)
    await page.route(f.companion.url + '/v1/write/create', async route => {
      const response = await route.fetch(); reached.resolve(); await held.promise; await route.fulfill({ response })
    })
    await dialog.getByRole('button', { name: 'New native note', exact: true }).click()
    await reached.promise
    expect(f.vault.list()).toHaveLength(1)
    await expect(dialog.getByRole('button', { name: 'Close native workspace' })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    held.resolve()
    await expect(dialog.getByText('Saved to Native Vault', { exact: true })).toBeVisible()
    await dialog.getByLabel('Native note title', { exact: true }).fill('Single acknowledged note')
    await dialog.getByLabel('Native note title', { exact: true }).press('ControlOrMeta+s')
    await expect(dialog.getByText('Saved to Native Vault', { exact: true })).toBeVisible()
    expect(f.vault.list()).toHaveLength(1)
    await page.screenshot({ path: testInfo.outputPath('native-acknowledged.png'), fullPage: true })
    expect(errors).toEqual([])
  } finally { held.resolve(); try { await page.unrouteAll({ behavior: 'wait' }) } finally { await f.close() } }
})

test('new native notes reset the parent input and rejected moves remain recoverable', async ({ page }, testInfo) => {
  const f = await fixture(), held = deferred(), reached = deferred()
  f.vault.create({ id: 'parent', metadata: { title: 'Parent' } })
  f.vault.create({ id: 'child', metadata: { title: 'Existing child', parentId: 'parent' } })
  try {
    const dialog = await connect(page, f.file)
    await dialog.getByRole('button', { name: 'Existing child', exact: true }).click()
    await expect(dialog.getByLabel('Move to parent note ID')).toHaveValue('parent')
    await dialog.getByRole('button', { name: 'New native note', exact: true }).click()
    await expect(dialog.getByLabel('Native note title', { exact: true })).toBeEnabled()
    await expect(dialog.getByLabel('Move to parent note ID')).toHaveValue('')
    await dialog.getByLabel('Native note title', { exact: true }).fill('Safe draft')
    await dialog.getByRole('textbox', { name: 'Native rich text editor', exact: true }).fill('한국어 preserved after rejected move')
    await dialog.getByRole('textbox', { name: 'Native rich text editor', exact: true }).press('ControlOrMeta+s')
    await expect(dialog.getByText('Saved to Native Vault', { exact: true })).toBeVisible()
    // A toolbar action must not steal focus back on a later animation frame.
    await dialog.evaluate(async element => {
      element.querySelector('[aria-label="Native bold"]').click()
      element.querySelector('input[placeholder="Empty for workspace root"]').focus()
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    await expect(dialog.getByLabel('Move to parent note ID')).toBeFocused()
    await page.route(f.companion.url + '/v1/write/update', async route => {
      const response = await route.fetch(); reached.resolve(); await held.promise; await route.fulfill({ response })
    })
    await dialog.getByLabel('Move to parent note ID').fill('nonexistent-parent')
    await dialog.getByRole('button', { name: 'Move native note', exact: true }).click()
    await reached.promise
    await expect(dialog.getByLabel('Native note title', { exact: true })).toBeDisabled()
    await expect(dialog.getByRole('textbox', { name: 'Native rich text editor', exact: true })).toHaveAttribute('contenteditable', 'false')
    held.resolve()
    await expect(dialog.getByRole('alert')).toContainText('404')
    await expect(dialog.getByRole('alert')).toBeInViewport()
    await expect(dialog.getByLabel('Native note title', { exact: true })).toBeEnabled()
    await expect(dialog.getByRole('textbox', { name: 'Native rich text editor', exact: true })).toContainText('한국어 preserved')
    await page.screenshot({ path: testInfo.outputPath('native-rejected-move.png'), fullPage: true })
    await page.unrouteAll({ behavior: 'wait' })
    await dialog.getByLabel('Move to parent note ID').fill('parent')
    await dialog.getByRole('button', { name: 'Move native note', exact: true }).click()
    await expect(dialog.getByRole('button', { name: 'Edit native note', exact: true })).toBeEnabled()
    expect(f.vault.list().find(note => note.metadata.title === 'Safe draft').metadata.parentId).toBe('parent')
    await dialog.getByLabel('Attach local file').setInputFiles({ name: 'oversized.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(4 * 1024 * 1024 + 1) })
    await expect(dialog.getByRole('alert')).toContainText('limited to 4 MiB')
    await dialog.getByLabel('Attach local file').setInputFiles({ name: 'small.txt', mimeType: 'text/plain', buffer: Buffer.from('safe') })
    await expect(dialog.getByRole('button', { name: 'Download attachment small.txt' })).toBeEnabled()
  } finally { held.resolve(); try { await page.unrouteAll({ behavior: 'wait' }) } finally { await f.close() } }
})

test('confirmation and search keep keyboard focus and respect IME composition', async ({ page }, testInfo) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'New Page', exact: true }).click()
  await page.getByPlaceholder('Untitled').fill('Keyboard safety')
  await composingKey(page.getByPlaceholder('Untitled'), 'Enter')
  await expect(page.getByPlaceholder('Untitled')).toBeFocused()
  const body = page.locator('.tiptap[contenteditable="true"]')
  await body.fill('한국어 선택 영역과 포커스')
  await body.press('ControlOrMeta+a')
  await expect(page.getByRole('button', { name: 'Format Bold', exact: true })).toBeVisible()
  await page.evaluate(async () => {
    document.querySelector('[aria-label="Format Bold"]').click()
    document.querySelector('[aria-label="Page title"]').focus()
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  await expect(page.getByPlaceholder('Untitled')).toBeFocused()
  await expect(body.locator('strong')).toHaveText('한국어 선택 영역과 포커스')
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  const trigger = page.getByRole('button', { name: 'Delete Page', exact: true })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: 'Delete Page', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await dialog.getByRole('button', { name: 'Delete', exact: true }).focus()
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: 'Close dialog' })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toBeFocused()
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByRole('dialog', { name: 'Command Palette' })).toHaveCount(0)
  await composingKey(dialog, 'Escape')
  await expect(dialog).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('keyboard-confirmation.png'), fullPage: true, animations: 'disabled' })
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog', { name: 'Command Palette' })
  const search = palette.getByLabel('Search pages', { exact: true })
  await expect(search).toBeFocused()
  await search.fill('Keyboard safety')
  await composingKey(search, 'Enter')
  await expect(palette).toBeVisible()
  await page.keyboard.press('Tab')
  expect(await palette.evaluate(element => element.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  const graphTrigger = page.getByRole('button', { name: 'Graph View', exact: true })
  await graphTrigger.click()
  const graph = page.getByRole('dialog', { name: 'Graph View' })
  await expect(graph.getByRole('button', { name: 'Close graph' })).toBeFocused()
  await page.keyboard.press('ControlOrMeta+k')
  await expect(palette).toHaveCount(0)
  await page.keyboard.press('Tab')
  await expect(graph.getByRole('button', { name: 'Close graph' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(graph).toHaveCount(0)
  await expect(graphTrigger).toBeFocused()
  expect(errors).toEqual([])
})

test('invalid session files clear the previous choice and a valid retry connects', async ({ page }) => {
  const f = await fixture()
  try {
    await page.goto('/')
    await page.getByRole('button', { name: 'Native workspace', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Native workspace' })
    await dialog.getByLabel('Private session file').setInputFiles(f.file)
    await expect(dialog.getByRole('button', { name: 'Connect for editing' })).toBeEnabled()
    await dialog.getByLabel('Private session file').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{}') })
    await expect(dialog.getByRole('alert')).toContainText('Session is invalid')
    await expect(dialog.getByRole('button', { name: 'Connect read only' })).toBeDisabled()
    await dialog.getByLabel('Private session file').setInputFiles(f.file)
    await dialog.getByRole('button', { name: 'Connect for editing' }).click()
    await expect(dialog.getByRole('button', { name: 'New native note', exact: true })).toBeEnabled()
  } finally { await f.close() }
})

test('a failed optional collaboration module leaves local editing and persistence available', async ({ page }) => {
  await page.route('**/assets/y-webrtc-*.js', route => route.abort('failed'))
  await page.goto('/')
  await page.getByRole('button', { name: 'New Page', exact: true }).click()
  await page.getByPlaceholder('Untitled').fill('Local editing despite transport failure')
  await page.getByText('Local only', { exact: true }).click()
  await page.getByLabel('Signalling server', { exact: true }).fill('ws://127.0.0.1:1')
  await page.getByRole('button', { name: 'Generate room ID' }).click()
  await page.getByLabel('Shared secret', { exact: true }).fill('synthetic-secret-for-local-test')
  await page.getByRole('button', { name: 'Enable collaboration for this session' }).click()
  await expect(page.getByText('Collaboration unavailable; local editing continues', { exact: true })).toBeVisible()
  const editor = page.locator('.tiptap[contenteditable="true"]')
  await editor.fill('네트워크 오류 후에도 로컬 저장')
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  await page.reload()
  await page.locator('.sidebar-item').filter({ hasText: 'Local editing despite transport failure' }).click()
  await expect(editor).toContainText('네트워크 오류 후에도 로컬 저장')
})

test('recovery storage failure blocks leaving until the pending draft is downloaded', async ({ page }, testInfo) => {
  const f = await fixture(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    const dialog = await connect(page, f.file)
    await dialog.getByRole('button', { name: 'New native note', exact: true }).click()
    await expect(dialog.getByText('Saved to Native Vault', { exact: true })).toBeVisible()
    // Inject a quota failure only into this profile's synthetic recovery journal.
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (...args) {
        if (this.transaction.db.name === 'ephemeris-native-recovery') throw new DOMException('Synthetic recovery quota failure', 'QuotaExceededError')
        return put.apply(this, args)
      }
    })
    await dialog.getByLabel('Native note title', { exact: true }).fill('저장 실패 시 반드시 보존')
    await expect(dialog.getByText('Recovery storage unavailable · download your draft', { exact: true })).toBeVisible()
    await expect(dialog.getByLabel('Native note title', { exact: true })).toBeDisabled()
    await dialog.getByRole('button', { name: 'Close native workspace' }).click()
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('alert').filter({ hasText: 'before leaving' })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('native-storage-failure.png'), fullPage: true })
    const downloading = page.waitForEvent('download')
    await dialog.getByRole('button', { name: 'Download pending draft' }).click()
    const download = await downloading
    const snapshot = JSON.parse(readFileSync(await download.path(), 'utf8'))
    expect(snapshot.metadata.title).toBe('저장 실패 시 반드시 보존')
    expect(snapshot.document.length).toBeGreaterThan(0)
    expect(f.vault.read(snapshot.id).metadata.title).not.toBe(snapshot.metadata.title)
    await dialog.getByRole('button', { name: 'Close native workspace' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Native workspace', exact: true })).toBeFocused()
    expect(errors).toEqual([])
  } finally { await f.close() }
})
