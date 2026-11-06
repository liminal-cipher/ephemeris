import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { regularFile } from './paths.js'

export function readSyncConfig(file) {
  if(typeof file!=='string'||!path.isAbsolute(file))throw new Error('Expected an absolute private configuration path')
  regularFile(file)
  const relative=path.relative(realpathSync(path.resolve(import.meta.dirname,'..')),realpathSync(file))
  if(!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative))throw new Error('Keep private sync configuration outside the repository')
  if(regularFile(file).size>64*1024)throw new Error('Sync configuration is too large')
  try{return JSON.parse(readFileSync(file,'utf8'))}catch{throw new Error('Invalid sync configuration JSON')}
}
