import { useEffect, useRef, useState } from 'react'
import { nativeConnection, parseNativeSession } from '../storage/nativeConnection'
import './NativeWorkspace.css'

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
  const link = document.createElement('a'); link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function NativeWorkspace({ onClose }) {
  const [session, setSession] = useState(null), [connected, setConnected] = useState(false)
  const [rows, setRows] = useState([]), [note, setNote] = useState(null), [changes, setChanges] = useState(null)
  const [query, setQuery] = useState(''), [offset, setOffset] = useState(0), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const connection = useRef(null), generation = useRef(0)
  useEffect(() => () => { generation.current++; connection.current?.close() }, [])
  const disconnect = () => {
    generation.current++; connection.current?.close(); connection.current = null
    setSession(null); setConnected(false); setRows([]); setNote(null); setChanges(null); setError(''); setBusy(false); setOffset(0)
  }
  const perform = async action => {
    const current = generation.current
    setBusy(true); setError('')
    try { await action(current) }
    catch (failure) { if (current === generation.current) setError(failure.message === 'Failed to fetch' ? 'Companion unavailable. Your browser workspace is unchanged.' : failure.message) }
    finally { if (current === generation.current) setBusy(false) }
  }
  const load = async (client, nextOffset, current) => {
    const result = await client.get(query.trim() ? 'search' : 'notes', { ...(query.trim() ? { q: query } : {}), limit: 20, offset: nextOffset })
    if (current === generation.current) { setRows(result); setOffset(nextOffset); setConnected(true); setNote(null); setChanges(null) }
  }
  const connect = () => perform(async current => {
    connection.current?.close()
    const client = nativeConnection(session); connection.current = client
    await load(client, 0, current)
  })
  const select = id => perform(async current => {
    const result = await connection.current.get('note', { id })
    if (current === generation.current) { setNote(result); setChanges(null) }
  })
  return <section className="native-workspace" role="dialog" aria-modal="true" aria-label="Native workspace">
    <header><h2>Native workspace · Read only</h2><button onClick={onClose}>Close native workspace</button></header>
    <p>Your browser notes stay in their existing workspace. This connection only reads the Vault selected when you started the local companion.</p>
    <label>Private session file <input type="file" accept="application/json,.json" disabled={connected || busy} onChange={event => {
      const file = event.target.files?.[0]
      disconnect()
      if (!file) return
      perform(async current => {
        if (file.size > 4096) throw new Error('Invalid session file')
        const parsed = parseNativeSession(await file.text())
        if (current === generation.current) setSession(parsed)
      })
      event.target.value = ''
    }} /></label>
    {!connected && <button onClick={connect} disabled={!session || busy}>Connect read only</button>}
    {session && <button onClick={disconnect}>Disconnect and forget session</button>}
    {error && <p role="alert">{error}</p>}
    {busy && <p role="status">Reading native Vault…</p>}
    {connected && <>
      <p role="status">Connected · Read only</p>
      <form onSubmit={event => { event.preventDefault(); perform(current => load(connection.current, 0, current)) }}>
        <label>Search native notes <input value={query} onChange={event => setQuery(event.target.value)} /></label>
        <button disabled={busy}>Search native Vault</button>
      </form>
      <p>Search includes supported text and metadata. Unsupported content may not appear in text searches; original data remains available for recovery.</p>
      <div className="native-columns"><nav aria-label="Native notes">
        <ul>{rows.map(row => <li key={row.id}><button disabled={busy} onClick={() => select(row.id)}>{row.metadata.title || 'Untitled'}</button>
          {row.coverage && row.coverage !== 'complete' && <small> · {row.coverage} text</small>}</li>)}</ul>
        {!rows.length && <p>No matching native notes.</p>}
        <button disabled={busy || offset === 0} onClick={() => perform(current => load(connection.current, offset - 20, current))}>Previous</button>
        <button disabled={busy || rows.length < 20 || offset >= 10000} onClick={() => perform(current => load(connection.current, offset + 20, current))}>Next</button>
        <button disabled={busy} onClick={() => perform(async current => {
          const result = await connection.current.get('changes', { limit: 50 })
          if (current === generation.current) { setChanges(result); setNote(null) }
        })}>Inspect changes</button>
      </nav><article aria-label="Native note preview">
        {note && <>
          <h3>{note.metadata.title || 'Untitled'}</h3>
          <p>Version {note.version} · Text coverage: {note.preview.coverage}</p>
          {note.preview.coverage !== 'complete' && <p role="status">Some content cannot be displayed: {note.preview.reasons.join(', ')}. Download recovery data to retain the original.</p>}
          <pre>{note.preview.text || 'No supported text preview.'}</pre>
          <details><summary>Metadata</summary><pre>{JSON.stringify(note.metadata, null, 2)}</pre></details>
          <button onClick={() => download(Uint8Array.from(atob(note.document), char => char.charCodeAt(0)), 'native-document.yjs')}>Download original Yjs</button>
          <button onClick={() => download(JSON.stringify(note, null, 2), 'native-note-recovery.json')}>Download recovery data</button>
          <ul>{note.attachments.map(attachment => <li key={attachment.id}><button disabled={busy} onClick={() => perform(async current => {
            const blob = await connection.current.get('attachment', { noteId: note.id, id: attachment.id }, true)
            if (current === generation.current) download(blob, 'native-attachment.bin')
          })}>Download attachment {attachment.metadata?.name || attachment.id}</button></li>)}</ul>
        </>}
        {changes && <><h3>Change records</h3><pre>{JSON.stringify(changes, null, 2)}</pre></>}
      </article></div>
    </>}
  </section>
}
