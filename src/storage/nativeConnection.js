export function parseNativeSession(text, origin = window.location.origin) {
  if (typeof text !== 'string' || text.length > 4096) throw new Error('Invalid session file')
  const session = JSON.parse(text)
  if (session.format !== 'ephemeris-companion-session' || session.version !== 1 || session.origin !== origin ||
      typeof session.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(session.token) ||
      !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) throw new Error('Session is invalid, expired or belongs to another application origin')
  const endpoint = new URL(session.url)
  if (endpoint.origin !== session.url || endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port) throw new Error('Companion must use an explicit IPv4 loopback port')
  return session
}

export function nativeConnection(session) {
  const controller = new AbortController()
  return {
    close: () => controller.abort(),
    async get(route, params = {}, binary = false) {
      if (!['notes', 'note', 'search', 'attachment', 'changes'].includes(route)) throw new Error('Invalid native operation')
      const query = new URLSearchParams(params)
      const response = await fetch(`${session.url}/v1/${route}?${query}`, {
        method: 'GET', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: { Authorization: `Bearer ${session.token}` },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
      })
      if (!response.ok) throw new Error(`Native request failed (${response.status}). Check the companion and load a current session file.`)
      return binary ? response.blob() : response.json()
    },
  }
}
