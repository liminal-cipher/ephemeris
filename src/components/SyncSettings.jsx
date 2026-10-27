import { useState, useEffect } from 'react'
import { connectDocument, disableCollaboration, enableCollaboration, useCollaboration } from '../sync/collaboration'
import { vault } from '../store/workspace'

export default function SyncSettings() {
  const { enabled, status, error, generation } = useCollaboration()
  const [room, setRoom] = useState('')
  const [password, setPassword] = useState('')
  const [signaling, setSignaling] = useState('')
  const [validation, setValidation] = useState('')
  useEffect(() => {
    if (enabled) connectDocument('workspace', vault.workspace).catch(() => {})
  }, [enabled, generation])
  return <details className="sync-settings">
    <summary>{status}</summary>
    <p>Experimental peer collaboration shares this workspace with holders of the room ID and secret. Both peers must open a note to share its text. It is not a backup or durable sync service.</p>
    {enabled ? <button onClick={disableCollaboration}>Disable collaboration</button> : <form onSubmit={event => {
      event.preventDefault()
      try { enableCollaboration({ room, password, signaling }); setValidation(''); setPassword('') }
      catch (failure) { setValidation(failure.message) }
    }}>
      <label>Signalling server<input aria-label="Signalling server" value={signaling} onChange={event => setSignaling(event.target.value)} placeholder="wss://your-server" required /></label>
      <label>Private room ID<input aria-label="Private room ID" value={room} onChange={event => setRoom(event.target.value)} required /></label>
      <button type="button" onClick={() => setRoom(crypto.randomUUID())}>Generate room ID</button>
      <label>Shared secret<input aria-label="Shared secret" type="password" autoComplete="off" value={password} onChange={event => setPassword(event.target.value)} minLength={16} required /></label>
      <p>Settings last only for this session. No public discovery or NAT traversal servers are supplied.</p>
      <button type="submit">Enable collaboration for this session</button>
    </form>}
    {(validation || error) && <p role="alert">{validation || error}</p>}
  </details>
}
