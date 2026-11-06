import { test, expect } from '@playwright/test'
import { mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NativeVault } from '../native/vault.js'
import { startCompanion } from '../native/companion.js'
import { WRITE_PERMISSIONS } from '../native/companion-operations.js'

const origin = 'http://127.0.0.1:4179'
async function setup() {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'ephemeris-edit-e2e-'))
  const directory = path.join(root, 'vault'), vault = NativeVault.create(directory)
  let companion = await startCompanion({ directory, origin, permissions: WRITE_PERMISSIONS })
  const file = () => ({ name: 'editing-session.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'ephemeris-companion-session', version: 2,
    url: companion.url, token: companion.token, origin, expiresAt: companion.expiresAt, permissions: companion.permissions, vaultId: companion.vaultId })) })
  return { vault, companion, file: file(), restart: async () => { companion = await startCompanion({ directory, origin, permissions: WRITE_PERMISSIONS }); return file() },
    close: async () => { await companion.close(); vault.close(); rmSync(root, { recursive: true, force: true }) } }
}
async function connect(page, file) {
  await page.getByRole('button', { name: 'Native workspace', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Native workspace' })
  await dialog.getByLabel('Private session file').setInputFiles(file)
  await dialog.getByRole('button', { name: 'Connect for editing' }).click()
  await expect(dialog.getByRole('button', { name: 'New native note', exact: true })).toBeVisible()
  return dialog
}
const editor = dialog => dialog.getByRole('textbox', { name: 'Native rich text editor', exact: true })

test('native note lifecycle, Korean input, attachment, refresh and responsive editing', async ({ page }, testInfo) => {
  const fixture = await setup(), errors = [], external = [], failed = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('requestfailed', request => failed.push(request.url()))
  page.on('request', request => { if (![origin + '/', fixture.companion.url + '/'].some(prefix => request.url().startsWith(prefix))) external.push(request.url()) })
  fixture.vault.create({ id: 'project', metadata: { title: 'Project parent' } })
  try {
    await page.goto('/')
    let dialog = await connect(page, fixture.file)
    await dialog.getByRole('button', { name: 'New native note', exact: true }).click()
    await dialog.getByLabel('Native note title', { exact: true }).fill('매일 쓰는 메모')
    await editor(dialog).fill('English and 한국어 본문')
    await editor(dialog).press('End')
    await editor(dialog).dispatchEvent('compositionstart', { data: '' })
    await page.keyboard.insertText(' 조합 입력')
    await editor(dialog).dispatchEvent('compositionend', { data: '조합 입력' })
    await editor(dialog).press('ControlOrMeta+s')
    await expect(dialog.getByText('Saved to Native Vault', { exact: true })).toBeVisible()
    await editor(dialog).press('ControlOrMeta+k')
    await expect(dialog.getByRole('textbox', { name: 'Search native notes', exact: true })).toBeFocused()
    const id = fixture.vault.list().find(note => note.metadata.title === '매일 쓰는 메모').id
    expect(fixture.vault.preview(id).text).toContain('조합 입력')
    await page.screenshot({ path: testInfo.outputPath('native-edit-desktop.png'), fullPage: true })
    await editor(dialog).press('End')
    await page.keyboard.insertText(' undo check')
    await expect(dialog.getByText('Saved to Native Vault', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(editor(dialog)).not.toContainText('undo check')
    await expect(editor(dialog)).toContainText('조합 입력')
    await dialog.getByRole('button', { name: 'Redo', exact: true }).click()
    await expect(editor(dialog)).toContainText('undo check')
    await dialog.getByRole('button', { name: 'Undo', exact: true }).click()
    await dialog.getByLabel('Move to parent note ID').fill('project')
    await dialog.getByRole('button', { name: 'Move native note', exact: true }).click()
    await expect.poll(() => fixture.vault.read(id).metadata.parentId).toBe('project')
    // setInputFiles bypasses actionability; wait for the move's UI acknowledgement
    // just as a person must before choosing a file in this disabled control.
    await expect(dialog.getByLabel('Attach local file')).toBeEnabled()
    await dialog.getByLabel('Attach local file').setInputFiles({ name: '한국어.txt', mimeType: 'text/plain', buffer: Buffer.from('첨부파일 exact bytes') })
    const attachmentButton = dialog.getByRole('button', { name: 'Download attachment 한국어.txt' })
    await expect(attachmentButton).toBeVisible()
    const event = page.waitForEvent('download'); await attachmentButton.click()
    const download = await event
    expect(readFileSync(await download.path()).toString()).toBe('첨부파일 exact bytes')
    await page.reload(); dialog = await connect(page, fixture.file)
    await dialog.getByRole('button', { name: '매일 쓰는 메모', exact: true }).click()
    await expect(dialog.getByRole('article')).toContainText('조합 입력')
    await dialog.getByRole('button', { name: 'Edit native note', exact: true }).click()
    await page.setViewportSize({ width: 420, height: 880 })
    await expect(editor(dialog)).toContainText('English and 한국어')
    await editor(dialog).scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('native-edit-narrow.png'), fullPage: true })
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ path: testInfo.outputPath('native-edit-dark.png'), fullPage: true })
    await dialog.getByRole('button', { name: 'Move note to trash', exact: true }).click()
    await expect.poll(() => fixture.vault.read(id).deleted !== null).toBe(true)
    await dialog.getByRole('button', { name: 'Restore native note to root', exact: true }).click()
    await expect.poll(() => fixture.vault.read(id).deleted).toBe(null)
    expect(fixture.vault.preview(id).text).toContain('조합 입력')
    await dialog.getByRole('button', { name: 'Close native workspace' }).focus()
    await page.keyboard.press('Shift+Tab')
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
    expect(errors).toEqual([]); expect(external).toEqual([]); expect(failed).toEqual([])
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(fixture.companion.token)
  } finally { await fixture.close() }
})

test('offline pending draft survives reload and stale saves offer a non-destructive recovered copy', async ({ page }, testInfo) => {
  const fixture = await setup()
  page.on('dialog', dialog => dialog.accept())
  try {
    await page.goto('/')
    let dialog = await connect(page, fixture.file)
    await dialog.getByRole('button', { name: 'New native note', exact: true }).click()
    await dialog.getByLabel('Native note title', { exact: true }).fill('Recovery note')
    await editor(dialog).fill('Original content')
    await expect(dialog.getByText('Saved to Native Vault', { exact: true })).toBeVisible()
    const id = fixture.vault.list()[0].id
    await fixture.companion.close()
    await editor(dialog).fill('오프라인 복구 초안')
    await expect(dialog.getByText('Offline or session expired · draft retained', { exact: true })).toBeVisible()
    expect(fixture.vault.preview(id).text).toContain('Original content')
    await page.reload()
    dialog = await connect(page, await fixture.restart())
    await dialog.getByRole('button', { name: 'Recover draft: Recovery note', exact: true }).click()
    await expect(editor(dialog)).toContainText('오프라인 복구 초안')
    await dialog.getByRole('button', { name: 'Save / retry', exact: true }).click()
    await expect(dialog.getByText('Saved to Native Vault', { exact: true })).toBeVisible()
    expect(fixture.vault.preview(id).text).toContain('오프라인 복구 초안')
    fixture.vault.rename(id, 'Competing title', fixture.vault.read(id))
    await editor(dialog).fill('My conflicting edit')
    await expect(dialog.getByText('Conflict · draft retained', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Compare saved version' }).click()
    await expect(dialog.getByRole('region', { name: 'Saved version comparison' })).toContainText('Competing title')
    await page.screenshot({ path: testInfo.outputPath('native-conflict.png'), fullPage: true })
    await dialog.getByRole('button', { name: 'Save draft as a separate note' }).click()
    await expect(dialog.getByLabel('Native note title', { exact: true })).toHaveValue('Recovery note (recovered copy)')
    await expect(editor(dialog)).toContainText('My conflicting edit')
    expect(fixture.vault.read(id).metadata.title).toBe('Competing title')
    expect(fixture.vault.preview(id).text).toContain('오프라인 복구 초안')
    await expect.poll(() => fixture.vault.list().length).toBe(2)
  } finally { await fixture.close() }
})

test('capture, daily notes, typed properties and saved table/card/kanban views share the same Vault', async ({ page }, testInfo) => {
  const fixture = await setup()
  try {
    await page.goto('/')
    const dialog = await connect(page, fixture.file)
    await dialog.getByRole('button', { name: 'Quick Capture', exact: true }).click()
    await dialog.getByLabel('Native note title', { exact: true }).fill('출시 준비')
    await editor(dialog).fill('Check the local workspace before launch.')
    await dialog.getByText('Properties and tags', { exact: true }).click()
    await dialog.getByLabel('Tags (comma separated)').fill('inbox, 프로젝트')
    await dialog.getByLabel('Project', { exact: true }).fill('Ephemeris')
    await dialog.getByLabel('Status', { exact: true }).selectOption('doing')
    await dialog.getByLabel('Due date', { exact: true }).fill('2026-12-01')
    await dialog.getByLabel('Favourite', { exact: true }).check()
    await editor(dialog).press('ControlOrMeta+s')
    await expect(dialog.getByText('Saved to Native Vault', { exact: true })).toBeVisible()
    const capture = fixture.vault.list()[0]
    expect(capture.metadata).toMatchObject({ tags: ['inbox', '프로젝트'], project: 'Ephemeris', status: 'doing', favorite: true, dueDate: '2026-12-01' })
    await dialog.getByRole('button', { name: 'Daily Note', exact: true }).click()
    await expect(editor(dialog)).toBeVisible()
    await dialog.getByRole('button', { name: 'Daily Note', exact: true }).click()
    await expect.poll(() => fixture.vault.list().filter(note => note.metadata.kind === 'daily').length).toBe(1)
    await dialog.getByRole('button', { name: 'Meeting template', exact: true }).click()
    await expect(editor(dialog)).toContainText('Next actions')
    await dialog.getByRole('button', { name: 'Open views', exact: true }).click()
    const views = dialog.getByRole('region', { name: 'Native structured views' })
    await views.getByLabel('Filter tag', { exact: true }).fill('프로젝트')
    await views.getByRole('button', { name: 'Apply view', exact: true }).click()
    await expect(views.getByLabel('Filter tag', { exact: true })).toHaveValue('프로젝트')
    await expect(views.getByRole('table')).toContainText('출시 준비')
    await views.getByLabel('View layout').selectOption('cards')
    await views.getByRole('button', { name: 'Apply view', exact: true }).click()
    await expect(views.locator('.native-card')).toHaveCount(1)
    await views.getByLabel('View layout').selectOption('board')
    await views.getByRole('button', { name: 'Apply view', exact: true }).click()
    await views.getByLabel('Status of 출시 준비', { exact: true }).selectOption('done')
    await expect.poll(() => fixture.vault.read(capture.id).metadata.status).toBe('done')
    await views.getByLabel('Save view as', { exact: true }).fill('프로젝트 보드')
    await views.getByRole('button', { name: 'Save view definition', exact: true }).click()
    await expect(views.getByLabel('Saved views')).toContainText('프로젝트 보드')
    await page.screenshot({ path: testInfo.outputPath('native-knowledge-board.png'), fullPage: true })
    await views.locator('.native-board').screenshot({ path: testInfo.outputPath('native-board-cards.png') })
    const saved = fixture.vault.queryNotes({ definitions: true }).rows[0]
    expect(saved.metadata.view).toMatchObject({ tag: '프로젝트', layout: 'board' })
    expect(fixture.vault.preview(capture.id).text).toContain('Check the local workspace')
    await views.getByLabel('Filter tag', { exact: true }).fill('missing')
    await views.getByRole('button', { name: 'Apply view', exact: true }).click()
    await expect(views.getByText('No notes match this view. Change the filters or capture a note.')).toBeVisible()
    await views.getByLabel('Saved views').selectOption(saved.id)
    await expect(views.getByRole('button', { name: '출시 준비', exact: true })).toBeVisible()
  } finally { await fixture.close() }
})
