import { mkdirSync, lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'

// The caller selects a trusted local directory. IDs never become file paths.
export function directoryPath(directory, create = false) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || [...directory].some(char => char.charCodeAt(0) < 32) || directory.split(/[\\/]/).includes('..')) throw new Error('Expected an absolute Vault directory without traversal')
  const resolved = path.resolve(directory)
  if (resolved === path.parse(resolved).root || (process.platform === 'win32' && (resolved.startsWith('\\\\') || resolved.slice(2).includes(':')))) throw new Error('Invalid Vault directory')
  let current = path.parse(resolved).root
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    if (create && current === resolved) break
    const stat = lstatSync(current)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Vault paths must be real local directories')
  }
  if (create) mkdirSync(resolved, { mode: 0o700 })
  return realpathSync(resolved)
}

export function regularFile(file) {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Expected a regular file without links')
  return stat
}
