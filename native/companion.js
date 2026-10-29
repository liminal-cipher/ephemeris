import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { Worker } from 'node:worker_threads'

function allowedOrigin(origin) {
  const url = new URL(origin)
  if (url.origin !== origin || url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use an exact local HTTP application origin')
  return origin
}

export async function startCompanion({ directory, origin, port = 0 }) {
  allowedOrigin(origin)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port')
  const token = randomBytes(32).toString('base64url'), expiresAt = Date.now() + 8 * 60 * 60 * 1000
  const worker = new Worker(new URL('./companion-worker.js', import.meta.url), { workerData: { directory } })
  const pending = new Map()
  let nextId = 0, failed = false, server
  const rejectPending = () => {
    failed = true
    for (const item of pending.values()) { clearTimeout(item.timeout); item.reject(new Error('Companion storage worker unavailable')) }
    pending.clear()
  }
  worker.on('error', rejectPending)
  worker.on('exit', rejectPending)
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { worker.terminate(); reject(new Error('Vault opening timed out')) }, 30000)
    const fail = () => { clearTimeout(timeout); reject(new Error('Companion storage worker failed')) }
    worker.once('error', fail); worker.once('exit', fail)
    worker.once('message', message => {
      clearTimeout(timeout); worker.off('error', fail); worker.off('exit', fail)
      if (message.ready) resolve()
      else { worker.terminate(); reject(new Error(message.startupError)) }
    })
  })
  worker.on('message', message => {
    const item = pending.get(message.requestId)
    if (!item) return
    pending.delete(message.requestId); clearTimeout(item.timeout); item.resolve(message)
  })
  const dispatch = (operation, args) => new Promise((resolve, reject) => {
    if (failed || pending.size >= 4) { reject(new Error('Companion is busy or unavailable')); return }
    const requestId = ++nextId
    const timeout = setTimeout(() => { rejectPending(); worker.terminate() }, 10000)
    pending.set(requestId, { resolve, reject, timeout })
    worker.postMessage({ requestId, operation, args })
  })
  server = createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', "default-src 'none'")
    const respond = (status, error) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error })) }
    const host = `127.0.0.1:${server.address()?.port}`
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== host || req.headers.origin !== origin) { respond(403, 'Host or origin rejected'); return }
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    if (req.method === 'OPTIONS') {
      if (req.headers['access-control-request-method'] !== 'GET' || req.headers['access-control-request-headers']?.toLowerCase() !== 'authorization') { respond(403, 'Preflight rejected'); return }
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'Authorization', 'Access-Control-Allow-Private-Network': 'true' }); res.end(); return
    }
    const supplied = req.headers.authorization
    const expected = `Bearer ${token}`
    if (Date.now() >= expiresAt || typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) { respond(401, 'Unauthorised session'); return }
    if (req.method !== 'GET') { respond(405, 'Read-only companion'); return }
    if (req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0') || req.url.length > 2048) { respond(400, 'Invalid request'); return }
    try {
      const url = new URL(req.url, `http://${host}`)
      if (!req.url.startsWith('/') || url.origin !== `http://${host}`) throw new Error('Invalid request')
      const routes = {
        '/v1/notes': ['list', ['limit', 'offset']], '/v1/note': ['read', ['id']],
        '/v1/search': ['search', ['q', 'limit', 'offset']], '/v1/attachment': ['attachment', ['noteId', 'id']],
        '/v1/changes': ['changes', ['after', 'limit']],
      }
      const route = routes[url.pathname]
      if (!route) { respond(404, 'Unknown endpoint'); return }
      const [operation, keys] = route, args = {}
      for (const [key, value] of url.searchParams) {
        if (!keys.includes(key) || Object.hasOwn(args, key)) throw new Error('Invalid request')
        if (['limit', 'offset', 'after'].includes(key)) {
          if (!/^\d+$/.test(value)) throw new Error('Invalid request')
          args[key] = Number(value)
        } else args[key] = value
      }
      if (operation === 'changes' && (args.limit ?? 50) > 100) throw new Error('Invalid request')
      if (operation === 'changes' && args.limit === undefined) args.limit = 50
      const result = await dispatch(operation, args)
      if (result.error) { respond(result.status, result.error); return }
      res.writeHead(200, { 'Content-Type': result.contentType, ...(operation === 'attachment' ? { 'Content-Disposition': 'attachment; filename="attachment.bin"' } : {}) })
      res.end(result.body)
    } catch (error) { respond(error.message === 'Invalid request' ? 400 : 503, error.message === 'Invalid request' ? 'Invalid request' : 'Companion unavailable') }
  })
  server.maxHeadersCount = 20
  server.keepAliveTimeout = 1000
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  } catch (error) { await worker.terminate(); throw error }
  let closed = false
  return {
    url: `http://127.0.0.1:${server.address().port}`, token, origin, expiresAt,
    async close() {
      if (closed) return
      closed = true; rejectPending()
      server.closeAllConnections()
      await Promise.all([new Promise(resolve => server.close(resolve)), worker.terminate()])
    },
  }
}
