import { DatabaseSync } from 'node:sqlite'
import { NativeVault } from '../vault.js'
import path from 'node:path'
import { readFileSync } from 'node:fs'

const [mode, directory, id, version, value] = process.argv.slice(2)
if (mode === 'uncommitted') {
  const db = new DatabaseSync(path.join(directory, 'vault.sqlite'))
  db.exec('BEGIN IMMEDIATE')
  db.prepare('UPDATE notes SET metadata=? WHERE id=?').run('{"title":"Uncommitted"}', id)
  process.send('written')
  setInterval(() => {}, 1000)
} else if (mode === 'interrupted-import') {
  // Test-only instrumentation terminates the real importer after its first
  // INSERT. No production fault-injection or SQL escape hatch is exposed.
  const prepare = DatabaseSync.prototype.prepare
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = prepare.call(this, sql)
    if (sql.startsWith('INSERT INTO notes')) {
      const run = statement.run.bind(statement)
      statement.run = (...args) => { run(...args); process.exit(17) }
    }
    return statement
  }
  const vault = NativeVault.open(directory)
  await vault.importBackup(readFileSync(id, 'utf8'))
} else {
  const vault = NativeVault.open(directory)
  try {
    if (mode === 'read') process.send(vault.read(id))
    else {
      process.send('ready')
      process.once('message', () => {
        try {
          const expected = { version: Number(version) }
          if (mode === 'rename') vault.rename(id, value, expected)
          else if (mode === 'move') vault.move(id, value, expected)
          else if (mode === 'delete') vault.delete(id, expected)
          process.send('committed')
        } catch (error) { process.send(error.name) }
        finally { vault.close(); process.disconnect() }
      })
    }
  } finally { if (mode === 'read') { vault.close(); process.disconnect() } }
}
