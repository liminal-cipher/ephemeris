import { create } from 'zustand'

export const useCollaboration = create(() => ({ enabled: false, status: 'Local only', error: null, generation: 0 }))
let configuration = null
const providers = new Map()

export function validateConfiguration(input) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.room)) throw new Error('Use a generated private room ID (UUID)')
  if (typeof input.password !== 'string' || input.password.length < 16) throw new Error('Use a shared secret of at least 16 characters')
  const url = new URL(input.signaling)
  if (url.username || url.password || url.hash || (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Use wss:// signalling, or ws:// on localhost')
  return { room: input.room, password: input.password, signaling: url.href }
}

export function disableCollaboration() {
  configuration = null
  for (const provider of providers.values()) {
    provider.disconnect()
    provider.awareness.destroy()
    provider.destroy()
  }
  providers.clear()
  useCollaboration.setState(state => ({ enabled: false, status: 'Local only', error: null, generation: state.generation + 1 }))
}

export function enableCollaboration(input) {
  const validated = validateConfiguration(input)
  disableCollaboration()
  configuration = validated
  useCollaboration.setState({ enabled: true, status: 'Experimental collaboration enabled' })
}

export async function connectDocument(id, document) {
  const config = configuration
  if (!config) return null
  await document.ready
  const { WebrtcProvider } = await import('y-webrtc')
  if (configuration !== config) return null
  if (providers.has(id)) return providers.get(id)
  try {
    const provider = new WebrtcProvider(`${config.room}:${id}`, document.doc, {
      signaling: [config.signaling], password: config.password,
      // No implicit public STUN/TURN endpoints. This prototype supports peers
      // reachable without NAT traversal infrastructure.
      peerOpts: { config: { iceServers: [] } },
    })
    providers.set(id, provider)
    return provider
  } catch (error) {
    useCollaboration.setState({ error: error.message, status: 'Collaboration unavailable; local editing continues' })
    return null
  }
}
