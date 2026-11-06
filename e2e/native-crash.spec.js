import { test, expect, chromium } from '@playwright/test'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NativeVault } from '../native/vault.js'
import { startCompanion } from '../native/companion.js'
import { WRITE_PERMISSIONS } from '../native/companion-operations.js'

const origin = 'http://127.0.0.1:4179'
async function launch(profile) {
  const child = spawn(chromium.executablePath(), ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--no-sandbox'],
  { windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'] })
  const exited = once(child, 'exit')
  let running = true
  child.once('exit', () => { running = false })
  const kill = async () => {
    if (!running) return
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    else process.kill(-child.pid, 'SIGKILL')
    await exited
  }
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let output = ''
      const timeout = setTimeout(() => reject(new Error('Isolated Chromium did not start')), 15000)
      child.stderr.on('data', chunk => {
        output = (output + chunk.toString()).slice(-8192)
        const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/.exec(output)
        if (match) { clearTimeout(timeout); resolve(match[1]) }
      })
    })
    const browser = await chromium.connectOverCDP(endpoint)
    const context = browser.contexts()[0], page = context.pages()[0] || await context.newPage()
    await page.setViewportSize({ width: 1280, height: 900 })
    return { page, kill }
  } catch (error) { await kill(); throw error }
}

test('forced Chromium process termination retains an offline native draft in an isolated profile', async ({ browserName }, testInfo) => {
  expect(browserName).toBe('chromium')
  test.setTimeout(60000)
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'ephemeris-native-crash-')), directory = path.join(root, 'vault')
  const vault = NativeVault.create(directory)
  vault.create({ id: 'crash-note', metadata: { title: 'Crash recovery' } })
  let companion, browser
  const connect = async page => {
    await page.goto(origin)
    await page.getByRole('button', { name: 'Native workspace', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Native workspace' })
    await dialog.getByLabel('Private session file').setInputFiles({ name: 'synthetic.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
      format: 'ephemeris-companion-session', version: 2, url: companion.url, token: companion.token, origin,
      expiresAt: companion.expiresAt, permissions: companion.permissions, vaultId: companion.vaultId,
    })) })
    await dialog.getByRole('button', { name: 'Connect for editing' }).click()
    return dialog
  }
  try {
    companion = await startCompanion({ directory, origin, permissions: WRITE_PERMISSIONS })
    browser = await launch(path.join(root, 'isolated-profile'))
    let dialog = await connect(browser.page)
    await dialog.getByRole('button', { name: 'Crash recovery', exact: true }).click()
    await dialog.getByRole('button', { name: 'Edit native note', exact: true }).click()
    await expect(dialog.getByText('Saved to Native Vault', { exact: true })).toBeVisible()
    await companion.close()
    await dialog.getByRole('textbox', { name: 'Native rich text editor', exact: true }).fill('강제 종료 뒤 복구할 내용')
    await expect(dialog.getByText('Offline or session expired · draft retained', { exact: true })).toBeVisible()
    await browser.page.screenshot({ path: testInfo.outputPath('native-crash-before.png') })
    await browser.kill()
    companion = await startCompanion({ directory, origin, permissions: WRITE_PERMISSIONS })
    browser = await launch(path.join(root, 'isolated-profile'))
    dialog = await connect(browser.page)
    await dialog.getByRole('button', { name: 'Recover draft: Crash recovery', exact: true }).click()
    await expect(dialog.getByRole('textbox', { name: 'Native rich text editor', exact: true })).toContainText('강제 종료 뒤 복구할 내용')
    await dialog.getByRole('button', { name: 'Save / retry', exact: true }).click()
    await expect(dialog.getByText('Saved to Native Vault', { exact: true })).toBeVisible()
    expect(vault.preview('crash-note').text).toContain('강제 종료 뒤 복구할 내용')
    await dialog.getByLabel('Native note title', { exact: true }).scrollIntoViewIfNeeded()
    await browser.page.screenshot({ path: testInfo.outputPath('native-crash-recovered.png') })
  } finally { await browser?.kill(); await companion?.close(); vault.close(); rmSync(root, { recursive: true, force: true }) }
})
