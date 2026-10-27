import { readdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

async function walk(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const relative = `${prefix}${entry.name}`
    if (entry.isDirectory()) files.push(...await walk(`${directory}/${entry.name}`, `${relative}/`))
    else if (entry.name !== 'sw.js') files.push(relative)
  }
  return files.sort()
}
const files = await walk('dist')
const digest = createHash('sha256')
for (const file of files) digest.update(file).update(await readFile(`dist/${file}`))
const cache = `ephemeris-shell-${digest.digest('hex').slice(0, 16)}`
await writeFile('dist/sw.js', `// Generated from this build; caches application assets only.
const CACHE = ${JSON.stringify(cache)};
const FILES = ${JSON.stringify(files.map(file => `./${file}`))};
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('ephemeris-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(caches.open(CACHE).then(async cache => {
    const target = request.mode === 'navigate' ? new URL('./index.html', self.registration.scope).href : request;
    // Vite's static server varies responses by Origin. Module fetches and the
    // install-time requests have different modes; these same-origin build
    // assets are identical and must remain available in either mode offline.
    return await cache.match(target, { ignoreVary: true }) || fetch(request);
  }));
});
`)
console.log(`Offline shell: ${files.length} assets`)
