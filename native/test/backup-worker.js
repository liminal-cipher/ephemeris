import fs from 'node:fs'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'

const [mode, source, destination] = process.argv.slice(2)
if (mode === 'export') {
  const rename = fs.renameSync
  fs.renameSync = (from, to) => {
    if (path.basename(to) === 'manifest.json') process.exit(18)
    return rename(from, to)
  }
} else {
  const unlink = fs.unlinkSync
  fs.unlinkSync = file => {
    if (path.basename(file) === '.restoring') process.exit(19)
    return unlink(file)
  }
}
syncBuiltinESMExports()
const { NativeVault } = await import('../vault.js')
const { restoreNativeBackup } = await import('../backup.js')
if (mode === 'export') await NativeVault.open(source).exportBackup(destination)
else await restoreNativeBackup(source, destination)
