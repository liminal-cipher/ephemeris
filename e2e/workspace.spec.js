import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'

const editor = page => page.locator('.tiptap[contenteditable="true"]')
async function open(page) {
  await page.goto('/')
  await expect(editor(page)).toBeVisible()
}
async function newNote(page, title, body) {
  await page.getByRole('button', { name: 'New Page', exact: true }).click()
  await page.getByPlaceholder('Untitled').fill(title)
  await editor(page).fill(body)
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
}

test('default startup makes no external requests or WebSocket connections; graph renders', async ({ page }) => {
  const external = [], sockets = [], errors = []
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:4179/')) external.push(request.url()) })
  page.on('websocket', socket => sockets.push(socket.url()))
  page.on('pageerror', error => errors.push(error.message))
  await open(page)
  await page.getByRole('button', { name: 'Graph View', exact: true }).click()
  await expect(page.locator('.graph-body canvas')).toBeVisible()
  expect(external).toEqual([])
  expect(sockets).toEqual([])
  expect(errors).toEqual([])
})

test('creates, edits, restarts and searches while offline', async ({ page, context }) => {
  await open(page)
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => new Promise(resolve => {
    if (navigator.serviceWorker.controller) resolve()
    else navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })
  })))
  await context.setOffline(true)
  await newNote(page, 'Offline note', 'Durable local text')
  await page.reload()
  await page.locator('.sidebar-item').filter({ hasText: 'Offline note' }).click()
  await expect(editor(page)).toContainText('Durable local text')
  await page.keyboard.press('Control+k')
  await page.getByRole('dialog', { name: 'Command Palette' }).getByLabel('Search pages', { exact: true }).fill('Durable local')
  await expect(page.locator('.command-palette-item-title')).toHaveText('Offline note')
  await page.keyboard.press('Escape')
  await context.setOffline(false)
  await expect(editor(page)).toContainText('Durable local text')
})

test('two real tabs converge on text and metadata without external networking', async ({ page, context }) => {
  await open(page)
  await newNote(page, 'Shared local note', 'Base paragraph')
  const second = await context.newPage()
  await open(second)
  await second.locator('.sidebar-item').filter({ hasText: 'Shared local note' }).click()
  await expect(editor(second)).toContainText('Base paragraph')
  await Promise.all([
    page.getByPlaceholder('Untitled').fill('Renamed in tab one'),
    editor(second).press('Control+End').then(() => second.keyboard.insertText(' from tab two')),
  ])
  await expect(page.getByPlaceholder('Untitled')).toHaveValue('Renamed in tab one')
  await expect(second.getByPlaceholder('Untitled')).toHaveValue('Renamed in tab one')
  await expect(editor(page)).toContainText('from tab two')
  await Promise.all([
    editor(page).press('Control+End').then(() => page.keyboard.insertText(' A')),
    editor(second).press('Control+End').then(() => second.keyboard.insertText(' B')),
  ])
  await expect.poll(async () => (await editor(page).innerText()) === (await editor(second).innerText())).toBe(true)
  await expect(editor(page)).toContainText(' A')
  await expect(editor(page)).toContainText(' B')
  await second.close()
})

test('export/import preserves the actual editor body in an independent browser context', async ({ page, browser }) => {
  await open(page)
  await newNote(page, 'Round trip', 'Text that exists only in the real editor')
  const downloadPromise = page.waitForEvent('download')
  await page.getByTitle('Export Backup').click()
  const download = await downloadPromise
  const bytes = await readFile(await download.path())
  const backup = JSON.parse(bytes.toString())
  expect(backup.version).toBe(2)
  const other = await browser.newContext()
  try {
    const restored = await other.newPage()
    await open(restored)
    await restored.locator('input[type=file]').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: bytes })
    await expect(restored.getByText(/Successfully imported/)).toBeVisible()
    await restored.keyboard.press('Control+k')
    await restored.getByRole('dialog', { name: 'Command Palette' }).getByLabel('Search pages', { exact: true }).fill('exists only in the real editor')
    await expect(restored.locator('.command-palette-item-title')).toHaveText('Round trip')
    await restored.keyboard.press('Escape')
    await restored.locator('.sidebar-item').filter({ hasText: 'Round trip' }).click()
    await expect(editor(restored)).toContainText('Text that exists only in the real editor')
    await restored.reload()
    await restored.locator('.sidebar-item').filter({ hasText: 'Round trip' }).click()
    await expect(editor(restored)).toContainText('Text that exists only in the real editor')
  } finally { await other.close() }
})

test('deletion remains deleted after reload and can be restored with its text', async ({ page }) => {
  await open(page)
  await newNote(page, 'Recover this', 'Retained after deletion')
  await page.getByRole('button', { name: 'Delete Page', exact: true }).last().click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.locator('.sidebar-item').filter({ hasText: 'Recover this' })).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.sidebar-item').filter({ hasText: 'Recover this' })).toHaveCount(0)
  await page.getByText('Deleted pages (1)', { exact: true }).click()
  await page.getByRole('button', { name: 'Restore page', exact: true }).click()
  await page.locator('.sidebar-item').filter({ hasText: 'Recover this' }).click()
  await expect(editor(page)).toContainText('Retained after deletion')
})
