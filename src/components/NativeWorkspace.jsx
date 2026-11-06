import { useEffect, useRef, useState } from 'react'
import { nativeConnection, parseNativeSession } from '../storage/nativeConnection'
import { NativeDocument, retainedDrafts, decodeDocument, encodeDocument } from '../storage/nativeDocument'
import NativeNoteEditor from './NativeNoteEditor'
import { nativeTemplate } from '../storage/nativeTemplates'
import NativeViews from './NativeViews'
import './NativeWorkspace.css'

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
  const link = document.createElement('a'); link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
const expected = note => ({ version: note.version, contentHash: note.contentHash })

export default function NativeWorkspace({ onClose }) {
  const [session, setSession] = useState(null), [connected, setConnected] = useState(false)
  const [rows, setRows] = useState([]), [note, setNote] = useState(null), [changes, setChanges] = useState(null)
  const [query, setQuery] = useState(''), [offset, setOffset] = useState(0), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [trash, setTrash] = useState(false), [drafts, setDrafts] = useState([]), [model, setModel] = useState(null), [comparison, setComparison] = useState(null)
  const [moveTarget, setMoveTarget] = useState('')
  const [views, setViews] = useState(false)
  const [viewClient, setViewClient] = useState(null)
  const connection = useRef(null), generation = useRef(0), active = useRef(null), dialog = useRef(null)
  const can = permission => session?.version === 2 && session.permissions.includes(permission)
  const refreshDrafts = async () => { if (session?.vaultId) setDrafts(await retainedDrafts(session.vaultId)) }
  const release = async () => {
    if (active.current?.status === 'storage-error' && active.current.exportedRevision !== active.current.revision) throw new Error('Download the pending draft before leaving: browser recovery storage is unavailable.')
    await active.current?.flush()
    if (active.current?.status === 'storage-error' && active.current.exportedRevision !== active.current.revision) throw new Error('Download the pending draft before leaving: browser recovery storage is unavailable.')
    active.current?.dispose(); active.current = null; setModel(null); setComparison(null)
    await refreshDrafts()
  }
  useEffect(() => {
    const previous = document.activeElement
    dialog.current?.querySelector('button')?.focus()
    const unload = event => { if (active.current?.dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', unload)
    return () => {
      window.removeEventListener('beforeunload', unload)
      // The modal owns the latest editor/connection, including replacements.
      generation.current++; active.current?.dispose(); connection.current?.close() // eslint-disable-line react-hooks/exhaustive-deps
      setTimeout(() => previous?.focus(), 0)
    }
  }, [])
  const perform = async action => {
    const current = generation.current
    setBusy(true); setError('')
    try { await action(current) }
    catch (failure) { if (current === generation.current) setError(failure.message === 'Failed to fetch' ? 'Companion unavailable. Pending drafts and browser notes are retained.' : failure.message) }
    finally { if (current === generation.current) setBusy(false) }
  }
  const disconnect = async () => {
    await release()
    generation.current++; connection.current?.close(); connection.current = null
    setViewClient(null)
    setSession(null); setConnected(false); setRows([]); setNote(null); setChanges(null); setError(''); setBusy(false); setOffset(0); setDrafts([])
  }
  const load = async (client, nextOffset, current, deleted = trash) => {
    const result = await client.get(query.trim() && !deleted ? 'search' : 'notes', { ...(query.trim() && !deleted ? { q: query } : { deleted }), limit: 20, offset: nextOffset })
    if (current === generation.current) { setRows(result); setOffset(nextOffset); setConnected(true); setTrash(deleted) }
  }
  const connect = () => perform(async current => {
    connection.current?.close()
    const client = nativeConnection(session); connection.current = client
    setViewClient(client)
    const info = await client.get('info')
    if (session.version === 2) {
      if (info.vaultId !== session.vaultId || JSON.stringify(info.permissions) !== JSON.stringify(session.permissions)) throw new Error('The selected Vault or permissions changed. Load a fresh session.')
      setDrafts(await retainedDrafts(info.vaultId))
    }
    else setSession(previous => ({ ...previous, vaultId: info.vaultId }))
    await load(client, 0, current)
  })
  const edit = (value, draft) => {
    const next = new NativeDocument(connection.current, session.vaultId, value, { draft })
    next.subscribe(() => {
      if (next.status !== 'saved') return
      setRows(previous => previous.map(row => row.id === next.id ? { ...row, metadata: next.metadata, version: next.base.version } : row))
      setNote(previous => previous?.id === next.id ? { ...previous, ...next.snapshot(), version: next.base.version, contentHash: next.base.contentHash } : previous)
    })
    active.current = next; setModel(next); setComparison(null)
  }
  const select = (id, draft) => perform(async current => {
    await release()
    const result = await connection.current.get('note', { id })
    if (current === generation.current) {
      setViews(false); setNote(result); setChanges(null); setMoveTarget(result.metadata.parentId || '')
      if (draft) edit(result, draft)
    }
  })
  const create = (kind = 'note') => perform(async current => {
    await release()
    const template = nativeTemplate(kind), id = template.id
    let result
    try { result = await connection.current.write('create', template) }
    catch (failure) {
      // A lost create acknowledgement must not produce a duplicate on retry.
      try { result = await connection.current.get('note', { id }) } catch { throw failure }
    }
    if (current === generation.current) {
      await load(connection.current, 0, current, false)
      setViews(false); setNote(result); setChanges(null)
      if (result.deleted === null) edit(result)
      else setError('This daily note is in the trash. Restore it explicitly to continue.')
    }
  })
  const mutate = (operation, fields = {}) => perform(async current => {
    if (active.current && !(await active.current.flush())) throw new Error('Save or recover the pending draft before changing this note.')
    const result = await connection.current.write(operation, { id: note.id, expected: active.current?.base || expected(note), ...fields })
    await release()
    if (current === generation.current) {
      setNote(result); setChanges(null); setMoveTarget(result.metadata.parentId || '')
      await load(connection.current, 0, current)
    }
  })
  return <section ref={dialog} className="native-workspace" role="dialog" aria-modal="true" aria-label="Native workspace" onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !event.nativeEvent.isComposing) {
      event.preventDefault(); event.stopPropagation(); dialog.current.querySelector('[aria-label="Search native notes"]')?.focus()
    }
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); perform(async () => { await release(); onClose() }) }
    if (event.key === 'Tab') {
      const controls = [...dialog.current.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[contenteditable="true"],summary')].filter(element => element.getClientRects().length)
      const first = controls[0], last = controls.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
  }}>
    <header><h2>Native workspace · {session?.version === 2 ? 'Editing session' : 'Read only'}</h2><button onClick={() => perform(async () => { await release(); onClose() })}>Close native workspace</button></header>
    <details open={!connected}><summary>Connection and recovery</summary>
    <p>Your browser notes stay in their existing workspace. Select a private session for the local Vault you want to use.</p>
    <label>Private session file <input type="file" accept="application/json,.json" disabled={connected || busy} onChange={event => {
      const file = event.target.files?.[0]
      if (!file) return
      perform(async current => {
        if (file.size > 4096) throw new Error('Invalid session file')
        const parsed = parseNativeSession(await file.text())
        if (current === generation.current) setSession(parsed)
      })
      event.target.value = ''
    }} /></label>
    {!connected && <button onClick={connect} disabled={!session || busy}>{session?.version === 2 ? 'Connect for editing' : 'Connect read only'}</button>}
    {session && <button onClick={() => perform(disconnect)}>Disconnect and forget session</button>}
    </details>
    {error && <p role="alert">{error}</p>}
    {busy && <p role="status">Working with native Vault…</p>}
    {connected && <>
      <p role="status">Connected · {session.version === 2 ? 'Explicit editing permissions · expires ' + new Date(session.expiresAt).toLocaleTimeString() : 'Read only'}</p>
      {can('notes:create') && <div className="native-actions">
        <button disabled={busy} onClick={() => create()}>New native note</button>
        <button disabled={busy} onClick={() => create('capture')}>Quick Capture</button>
        <button disabled={busy} onClick={() => create('daily')}>Daily Note</button>
        <button disabled={busy} onClick={() => create('meeting')}>Meeting template</button>
      </div>}
      <button disabled={busy} onClick={() => perform(async () => { await release(); setViews(true); setNote(null); setChanges(null) })}>Open views</button>
      {drafts.length > 0 && <details className="native-recovery" open><summary>Retained drafts ({drafts.length})</summary>
        <p>Recover a draft or download it. A conflicting saved version is never overwritten automatically.</p>
        {drafts.map(draft => <div key={draft.key}><button disabled={busy} onClick={() => select(draft.id, draft)}>Recover draft: {draft.metadata?.title || draft.id}</button>
          <button onClick={() => download(JSON.stringify(draft, null, 2), 'native-retained-draft.json')}>Download retained draft</button></div>)}
      </details>}
      <form onSubmit={event => { event.preventDefault(); perform(current => load(connection.current, 0, current)) }}>
        <label>Search native notes <input aria-label="Search native notes" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <button disabled={busy}>Search native Vault</button>
        <button type="button" disabled={busy} onClick={() => perform(current => load(connection.current, 0, current, !trash))}>{trash ? 'Show active notes' : 'Open native trash'}</button>
      </form>
      <div className="native-columns"><nav aria-label="Native notes">
        <h3>{trash ? 'Trash' : 'Notes'}</h3>
        <ul>{rows.map(row => <li key={row.id}><button aria-current={note?.id === row.id ? 'page' : undefined} disabled={busy} onClick={() => select(row.id)}>{row.metadata.title || 'Untitled'}</button>
          {row.coverage && row.coverage !== 'complete' && <small> · {row.coverage} text</small>}</li>)}</ul>
        {!rows.length && <p>No matching native notes.</p>}
        <button disabled={busy || offset === 0} onClick={() => perform(current => load(connection.current, offset - 20, current))}>Previous</button>
        <button disabled={busy || rows.length < 20 || offset >= 10000} onClick={() => perform(current => load(connection.current, offset + 20, current))}>Next</button>
        <button disabled={busy} onClick={() => perform(async current => {
          await release()
          const result = await connection.current.get('changes', { limit: 50 })
          if (current === generation.current) { setViews(false); setChanges(result); setNote(null) }
        })}>Inspect changes</button>
      </nav><article aria-label="Native note preview">
        {views && <NativeViews client={viewClient} session={session} onSelect={select} />}
        {!note && !changes && !views && <p>Select a note, or create one with an editing session.</p>}
        {note && <>
          {model ? <NativeNoteEditor document={model} busy={busy} onDownload={download}
            onReview={() => perform(async () => setComparison(await connection.current.get('note', { id: note.id })))}
            onCopy={() => perform(async current => {
              const snapshot = model.snapshot(), id = crypto.randomUUID()
              const result = await connection.current.write('create', { id, metadata: { ...snapshot.metadata, title: (snapshot.metadata.title || 'Untitled') + ' (recovered copy)', parentId: null }, document: snapshot.document })
              await release()
              if (current === generation.current) { setNote(result); edit(result); await load(connection.current, 0, current) }
            })} /> : <>
            <h3>{note.metadata.title || 'Untitled'}</h3>
            <p>Version {note.version} · Text coverage: {note.preview.coverage}</p>
            {note.preview.coverage !== 'complete' && <p role="status">Some content cannot be displayed: {note.preview.reasons.join(', ')}. Original data remains available for recovery.</p>}
            <pre>{note.preview.text || 'No supported text preview.'}</pre>
            {can('notes:update') && note.deleted === null && <button onClick={() => perform(async () => edit(note))}>Edit native note</button>}
          </>}
          {comparison && <section aria-label="Saved version comparison"><h3>Saved version · {comparison.metadata.title}</h3><pre>{comparison.preview.text}</pre>
            <p>Saved version {comparison.version}; your draft remains in the editor above.</p></section>}
          <details><summary>Metadata</summary><pre>{JSON.stringify(note.metadata, null, 2)}</pre></details>
          <button onClick={() => download(decodeDocument(note.document), 'native-document.yjs')}>Download original Yjs</button>
          <button onClick={() => download(JSON.stringify(note, null, 2), 'native-note-recovery.json')}>Download recovery data</button>
          {can('notes:update') && note.deleted === null && <form onSubmit={event => { event.preventDefault(); mutate('update', { metadata: { parentId: moveTarget || null } }) }}>
            <label>Move to parent note ID <input value={moveTarget} onChange={event => setMoveTarget(event.target.value)} placeholder="Empty for workspace root" /></label>
            <button disabled={busy}>Move native note</button>
            <p className="native-hint">Note ID: {note.id}. Moving changes the parent; deleting a note keeps its children.</p>
          </form>}
          {can('notes:delete') && note.deleted === null && <button disabled={busy} onClick={() => mutate('delete')}>Move note to trash</button>}
          {can('notes:restore') && note.deleted !== null && <button disabled={busy} onClick={() => mutate('restore')}>Restore native note to root</button>}
          {can('attachments:create') && note.deleted === null && <label>Attach local file <input type="file" disabled={busy} onChange={event => {
            const file = event.target.files?.[0]; event.target.value = ''
            if (!file) return
            perform(async () => {
              if (file.size > 4 * 1024 * 1024) throw new Error('Browser attachment upload is limited to 4 MiB.')
              await mutate('attach', { attachment: { id: crypto.randomUUID(), metadata: { name: file.name, type: file.type }, bytes: encodeDocument(new Uint8Array(await file.arrayBuffer())) } })
            })
          }} /></label>}
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
