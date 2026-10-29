import { describe, it, expect, vi, afterEach } from 'vitest'
import { nativeConnection, parseNativeSession } from './nativeConnection'

const origin = 'http://127.0.0.1:4179'
const session = () => ({ format: 'ephemeris-companion-session', version: 1, url: 'http://127.0.0.1:43210', origin, token: 'a'.repeat(43), expiresAt: Date.now() + 10000 })
afterEach(() => vi.unstubAllGlobals())
describe('native session boundary', () => {
  it('accepts only a current local session for this exact app origin', () => {
    const valid = session()
    expect(parseNativeSession(JSON.stringify(valid), origin)).toEqual(valid)
    for (const change of [{ url: 'https://evil.example' }, { url: valid.url + '/path' }, { url: 'http://localhost:43210' },
      { origin: 'http://127.0.0.1:9999' }, { expiresAt: 0 }, { token: '' }, { version: 2 }]) {
      expect(() => parseNativeSession(JSON.stringify({ ...valid, ...change }), origin)).toThrow()
    }
  })
  it('uses only authenticated GET, omits cookies, and never puts the token in the URL', async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => [] }))
    vi.stubGlobal('fetch', fetch)
    const client = nativeConnection(session())
    await client.get('notes', { limit: 20 })
    const [url, options] = fetch.mock.calls[0]
    expect(url).not.toContain(session().token)
    expect(options).toMatchObject({ method: 'GET', credentials: 'omit', cache: 'no-store', headers: { Authorization: `Bearer ${session().token}` } })
    client.close()
    expect(options.signal.aborted).toBe(true)
    await expect(client.get('delete')).rejects.toThrow()
  })
})
