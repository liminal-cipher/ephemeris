import { expect } from '@playwright/test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NativeVault } from '../../native/vault.js'
import { startCompanion } from '../../native/companion.js'
import { WRITE_PERMISSIONS } from '../../native/companion-operations.js'

export const APP_ORIGIN = 'http://127.0.0.1:4179'

export async function createEditingFixture() {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'ephemeris-edit-e2e-'))
  const directory = path.join(root, 'vault')
  let vault, companion
  const close = async () => {
    try { await companion?.close() }
    finally { try { vault?.close() } finally { rmSync(root, { recursive: true, force: true }) } }
  }
  const file = () => ({ name: 'synthetic-editing-session.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
    format: 'ephemeris-companion-session', version: 2, url: companion.url, token: companion.token,
    origin: APP_ORIGIN, expiresAt: companion.expiresAt, permissions: companion.permissions, vaultId: companion.vaultId,
  })) })
  const restart = async () => {
    await companion?.close()
    companion = await startCompanion({ directory, origin: APP_ORIGIN, permissions: WRITE_PERMISSIONS })
    return file()
  }
  try {
    vault = NativeVault.create(directory)
    await restart()
    return { vault, get companion() { return companion }, get file() { return file() }, restart, close }
  } catch (error) { await close(); throw error }
}

// The caller owns navigation: crash/reload tests must reconnect to that page.
export async function connectEditingWorkspace(page, file) {
  await page.getByRole('button', { name: 'Native workspace', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Native workspace' })
  await dialog.getByLabel('Private session file').setInputFiles(file)
  await dialog.getByRole('button', { name: 'Connect for editing' }).click()
  await expect(dialog.getByRole('button', { name: 'New native note', exact: true })).toBeEnabled()
  return dialog
}
