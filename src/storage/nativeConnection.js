export function parseNativeSession(text, origin = window.location.origin) {
  if (typeof text !== 'string' || text.length > 4096) throw new Error('Invalid session file')
  const session = JSON.parse(text)
  if (session.format !== 'ephemeris-companion-session' || ![1, 2].includes(session.version) || session.origin !== origin ||
      typeof session.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(session.token) ||
      !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) throw new Error('Session is invalid, expired or belongs to another application origin')
  const endpoint = new URL(session.url)
  if (endpoint.origin !== session.url || endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port) throw new Error('Companion must use an explicit IPv4 loopback port')
  if (session.version === 2 && (!/^[a-f0-9]{64}$/.test(session.vaultId) || !Array.isArray(session.permissions) || !session.permissions.length ||
    session.permissions.some(scope => !['notes:create', 'notes:update', 'notes:delete', 'notes:restore', 'attachments:create'].includes(scope)) || session.expiresAt > Date.now() + 15 * 60 * 1000)) throw new Error('Invalid editing permissions')
  return session
}

export function nativeConnection(session) {
  const controller = new AbortController()
  const request = async (route, { body, binary = false } = {}) => {
    const response = await fetch(`${session.url}/v1/${route}`, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error',
      headers: { Authorization: `Bearer ${session.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
    }).catch(() => { throw new Error('Companion unavailable. Pending drafts and browser notes are retained.') })
    if (!response.ok) {
      const messages = {
        400: 'Native request rejected (400). Check the note properties, parent and file limits.',
        404: 'Native item not found (404). Refresh the note list and check the parent note ID.',
        409: 'Conflict: this note changed in another client. Your draft is retained.',
        413: 'Native request too large (413). Reduce the file or document size; your draft is retained.',
      }
      const error = new Error(messages[response.status] || `Native request failed (${response.status}). Check the companion and load a current session file.`)
      error.status = response.status
      throw error
    }
    return binary ? response.blob() : response.json()
  }
  return {
    close: () => controller.abort(),
    async get(route, params = {}, binary = false) {
      if (!['info', 'views', 'notes', 'note', 'search', 'attachment', 'changes'].includes(route)) throw new Error('Invalid native operation')
      const query = new URLSearchParams(params)
      return request(`${route}${query.size ? `?${query}` : ''}`, { binary })
    },
    async write(operation, body) {
      const scopes = { create: 'notes:create', update: 'notes:update', delete: 'notes:delete', restore: 'notes:restore', attach: 'attachments:create' }
      if (session.version !== 2 || !session.permissions?.includes(scopes[operation])) throw new Error('This session does not permit that write')
      return request(`write/${operation}`, { body })
    },
  }
}
