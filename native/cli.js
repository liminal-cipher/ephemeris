import { readFileSync, statSync } from 'node:fs'
import { NativeVault } from './vault.js'
import { importBackupToVault } from './importBackup.js'
import { verifyBackup, restoreNativeBackup } from './backup.js'
import { MAX_BYTES } from './validation.js'

const [command, source, destination, ...extra] = process.argv.slice(2)
let vault
try {
  if (extra.length) throw new Error('Too many arguments')
  if (command === 'rebuild-search' && source && !destination) {
    vault = NativeVault.open(source)
    console.log(JSON.stringify({ indexed: vault.rebuildSearch(), ...vault.verifySearch() }))
  } else if (command === 'export' && source && destination) {
    vault = NativeVault.open(source)
    console.log(JSON.stringify(await vault.exportBackup(destination)))
  } else if (command === 'verify' && source && !destination) {
    console.log(JSON.stringify(await verifyBackup(source)))
  } else if (command === 'restore' && source && destination) {
    console.log(JSON.stringify(await restoreNativeBackup(source, destination)))
  } else if (command === 'create' && source && !destination) {
    vault = NativeVault.create(source)
    console.log('Created empty Vault')
  } else if (command === 'inspect' && source && !destination) {
    vault = NativeVault.open(source)
    const notes = vault.list({ includeDeleted: true, includeRecovery: true })
    console.log(JSON.stringify({ notes: notes.length, deleted: notes.filter(note => note.deleted !== null).length,
      recoveryOnly: notes.filter(note => note.recovery).length,
      legacyOnly: notes.filter(note => note.contentState === 'legacy-only').length }))
  } else if (command === 'import' && source && destination) {
    if (statSync(source).size > MAX_BYTES) throw new Error('Backup exceeds the 50 MiB limit')
    const result = await importBackupToVault(destination, readFileSync(source, 'utf8'))
    vault = result.vault
    console.log(JSON.stringify({ imported: result.imported, count: result.count, sha256: result.sha256 }))
  } else throw new Error('Usage: node native/cli.js create|inspect <absolute-vault-directory> OR import <v2-backup.json> <new-absolute-vault-directory> OR export <vault> <new-backup-directory> OR verify <backup-directory> OR restore <backup-directory> <new-vault-directory>')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally { vault?.close() }
