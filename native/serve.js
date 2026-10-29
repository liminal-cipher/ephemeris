import { writeFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { startCompanion } from './companion.js'

const [directory, origin, sessionFile, ...extra] = process.argv.slice(2)
let companion
try {
  if (!directory || !origin || !sessionFile || extra.length || !path.isAbsolute(sessionFile)) throw new Error('Usage: node native/serve.js <absolute-vault-directory> <exact-local-app-origin> <new-absolute-session-file>')
  const target = path.join(realpathSync(path.dirname(sessionFile)), path.basename(sessionFile))
  const relative = path.relative(path.resolve(import.meta.dirname, '..'), target)
  if (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) throw new Error('Store the private session file outside the repository')
  companion = await startCompanion({ directory, origin })
  writeFileSync(target, JSON.stringify({ format: 'ephemeris-companion-session', version: 1,
    url: companion.url, token: companion.token, origin, expiresAt: companion.expiresAt }), { flag: 'wx', mode: 0o600 })
  console.log(`Read-only companion listening at ${companion.url}. Load the private session file in Native workspace. Press Ctrl+C to stop.`)
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, async () => { await companion.close(); process.exit(0) })
} catch (error) {
  await companion?.close()
  console.error(error.message)
  process.exitCode = 1
}
