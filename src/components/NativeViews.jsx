import { useCallback, useEffect, useRef, useState } from 'react'

const empty = { tag: '', project: '', status: '', favorite: false, sort: 'title', layout: 'table' }
const display = value => typeof value === 'string' ? value : ''
const tags = value => Array.isArray(value) ? value.filter(tag => typeof tag === 'string') : []
const statusName = value => ({ todo: 'To do', doing: 'In progress', done: 'Done' })[display(value)] || display(value) || 'No status'
export default function NativeViews({ client, session, onSelect }) {
  const [initialFilter] = useState(() => {
    try { return { ...empty, ...JSON.parse(localStorage.getItem('ephemeris.native-view.' + session.vaultId)) } } catch { return empty }
  })
  const [filter, setFilter] = useState(initialFilter)
  const [result, setResult] = useState({ rows: [], total: 0, offset: 0 }), [saved, setSaved] = useState([])
  const [name, setName] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const requests = useRef({ generation: 0 })
  const can = permission => session.version === 2 && session.permissions.includes(permission)
  const load = useCallback(async (definition, offset = 0) => {
    const current = ++requests.current.generation
    setBusy(true); setError(''); setFilter(definition)
    try {
      const [notes, views] = await Promise.all([client.get('views', { ...definition, offset, limit: 30 }), client.get('views', { definitions: true, limit: 100 })])
      if (requests.current.generation !== current) return
      setResult(notes); setSaved(views.rows)
      localStorage.setItem('ephemeris.native-view.' + session.vaultId, JSON.stringify(definition))
    } catch (failure) { if (requests.current.generation === current) setError(failure.message) }
    finally { if (requests.current.generation === current) setBusy(false) }
  }, [client, session.vaultId, requests])
  // This effect synchronises the panel with the external Companion on mount.
  useEffect(() => {
    const lifetime = requests.current
    load(initialFilter) // eslint-disable-line react/set-state-in-effect
    return () => { lifetime.generation++ }
  }, [load, initialFilter])
  const changeStatus = async (note, status) => {
    setBusy(true); setError('')
    try {
      await client.write('update', { id: note.id, expected: { version: note.version, contentHash: note.contentHash }, metadata: { status } })
      await load(filter, result.offset)
    } catch (failure) { setError(failure.message); setBusy(false) }
  }
  const item = note => <div className="native-card" key={note.id}>
    <button disabled={busy} onClick={() => onSelect(note.id)}>{note.metadata.title || 'Untitled'}</button>
    <p>{tags(note.metadata.tags).join(' · ')}</p>
    <p>{display(note.metadata.project)} {display(note.metadata.dueDate)}</p>
    {can('notes:update') ? <label>Status of {note.metadata.title || 'Untitled'}<select aria-label={'Status of ' + (note.metadata.title || 'Untitled')} disabled={busy} value={display(note.metadata.status)} onChange={event => changeStatus(note, event.target.value)}>
      <option value="">No status</option><option value="todo">To do</option><option value="doing">In progress</option><option value="done">Done</option>
      {!['', 'todo', 'doing', 'done'].includes(display(note.metadata.status)) && <option value={display(note.metadata.status)}>{display(note.metadata.status)}</option>}
    </select></label> : <span>{statusName(note.metadata.status)}</span>}
  </div>
  const groups = [...new Set(['todo', 'doing', 'done', ...result.rows.map(note => display(note.metadata.status))])]
  return <section aria-label="Native structured views">
    <h3>Views over your Vault</h3>
    <p>Notes stay in the same Vault. This page shows {result.rows.length} of {result.total} matching notes; board groups apply to this page.</p>
    <form onSubmit={event => { event.preventDefault(); load(filter) }} className="native-view-filters">
      <label>Filter tag <input value={filter.tag} onChange={event => setFilter({ ...filter, tag: event.target.value })} /></label>
      <label>Filter project <input value={filter.project} onChange={event => setFilter({ ...filter, project: event.target.value })} /></label>
      <label>Filter status <select value={filter.status} onChange={event => setFilter({ ...filter, status: event.target.value })}>
        <option value="">All statuses</option><option value="todo">To do</option><option value="doing">In progress</option><option value="done">Done</option>
      </select></label>
      <label><input type="checkbox" checked={filter.favorite} onChange={event => setFilter({ ...filter, favorite: event.target.checked })} />Favourites only</label>
      <label>Sort notes <select value={filter.sort} onChange={event => setFilter({ ...filter, sort: event.target.value })}>
        <option value="title">Title</option><option value="recent">Recently changed</option><option value="due">Due date</option>
      </select></label>
      <label>View layout <select value={filter.layout} onChange={event => setFilter({ ...filter, layout: event.target.value })}>
        <option value="table">Table</option><option value="cards">Cards</option><option value="board">Kanban</option>
      </select></label>
      <button disabled={busy}>Apply view</button>
    </form>
    <label>Saved views <select value="" disabled={busy} onChange={event => { const chosen = saved.find(note => note.id === event.target.value); if (chosen) load({ ...empty, ...chosen.metadata.view }) }}>
      <option value="">Choose a saved view</option>{saved.map(note => <option key={note.id} value={note.id}>{note.metadata.title}</option>)}
    </select></label>
    {can('notes:create') && <form onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('')
      try { await client.write('create', { id: crypto.randomUUID(), metadata: { title: name.trim(), kind: 'workspace-view', view: filter } }); setName(''); await load(filter) }
      catch (failure) { setError(failure.message); setBusy(false) }
    }}><label>Save view as <input maxLength={100} required value={name} onChange={event => setName(event.target.value)} /></label><button disabled={busy || !name.trim()}>Save view definition</button></form>}
    {error && <p role="alert">{error}</p>}{busy && <p role="status">Loading view…</p>}
    {!result.rows.length && !busy && <p>No notes match this view. Change the filters or capture a note.</p>}
    {filter.layout === 'table' ? <div className="native-table-scroll"><table><thead><tr><th>Note</th><th>Tags</th><th>Project</th><th>Status</th><th>Due date</th></tr></thead>
      <tbody>{result.rows.map(note => <tr key={note.id}><td><button disabled={busy} onClick={() => onSelect(note.id)}>{note.metadata.title || 'Untitled'}</button></td>
        <td>{tags(note.metadata.tags).join(', ')}</td><td>{display(note.metadata.project)}</td><td>{statusName(note.metadata.status)}</td><td>{display(note.metadata.dueDate)}</td></tr>)}</tbody></table></div>
      : filter.layout === 'cards' ? <div className="native-cards">{result.rows.map(item)}</div>
      : <div className="native-board">{groups.map(status => <section aria-label={statusName(status)} key={status}><h4>{statusName(status)}</h4>{result.rows.filter(note => (display(note.metadata.status)) === status).map(item)}</section>)}</div>}
    <button disabled={busy || result.offset === 0} onClick={() => load(filter, Math.max(0, result.offset - 30))}>Previous view page</button>
    <button disabled={busy || result.offset + 30 >= result.total || result.offset >= 9990} onClick={() => load(filter, result.offset + 30)}>Next view page</button>
  </section>
}
