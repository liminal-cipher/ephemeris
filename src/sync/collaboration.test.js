import { afterEach, describe, it, expect, vi } from 'vitest'
import { connectDocument, disableCollaboration, enableCollaboration, validateConfiguration, useCollaboration } from './collaboration'

const mocked = vi.hoisted(() => ({ constructor: vi.fn(), disconnect: vi.fn(), destroy: vi.fn(), awarenessDestroy: vi.fn() }))
vi.mock('y-webrtc', () => ({ WebrtcProvider: class {
  constructor(...args) { mocked.constructor(...args); this.disconnect = mocked.disconnect; this.destroy = mocked.destroy; this.awareness = { destroy: mocked.awarenessDestroy } }
} }))
afterEach(() => { disableCollaboration(); vi.clearAllMocks() })
const config = () => ({ room: crypto.randomUUID(), password: 'long-explicit-secret', signaling: 'wss://example.test' })

describe('explicit network boundary', () => {
  it('does not even construct a provider by default', async () => {
    expect(await connectDocument('workspace', { ready: Promise.resolve(), doc: {} })).toBeNull()
    expect(mocked.constructor).not.toHaveBeenCalled()
    expect(useCollaboration.getState().enabled).toBe(false)
  })
  it.each([
    { signaling: '' }, { signaling: 'https://example.test' },
    { signaling: 'ws://public.example' }, { signaling: 'wss://user:secret@example.test' },
    { room: 'ephemeris-workspace-room' }, { password: '' },
  ])('rejects unsafe or incomplete configuration %o', changes => {
    expect(() => validateConfiguration({ ...config(), ...changes })).toThrow()
    expect(mocked.constructor).not.toHaveBeenCalled()
  })
  it('uses only the configured signalling server, then disconnects immediately', async () => {
    const configuration = config()
    enableCollaboration(configuration)
    await connectDocument('workspace', { ready: Promise.resolve(), doc: {} })
    expect(mocked.constructor).toHaveBeenCalledWith(`${configuration.room}:workspace`, {}, expect.objectContaining({
      signaling: ['wss://example.test/'], password: configuration.password, peerOpts: { config: { iceServers: [] } },
    }))
    disableCollaboration()
    expect(mocked.disconnect).toHaveBeenCalled()
    expect(mocked.destroy).toHaveBeenCalled()
    expect(useCollaboration.getState().enabled).toBe(false)
  })
  it('disabling during asynchronous setup prevents a late connection', async () => {
    let resolve
    enableCollaboration(config())
    const pending = connectDocument('note', { ready: new Promise(done => { resolve = done }), doc: {} })
    disableCollaboration()
    resolve()
    expect(await pending).toBeNull()
    expect(mocked.constructor).not.toHaveBeenCalled()
  })
  it('reports provider setup failures without throwing into the local editor', async () => {
    mocked.constructor.mockImplementationOnce(() => { throw new Error('Transport unavailable') })
    enableCollaboration(config())
    expect(await connectDocument('note', { ready: Promise.resolve(), doc: {} })).toBeNull()
    expect(useCollaboration.getState().error).toBe('Transport unavailable')
  })
})
