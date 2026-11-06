import { useEffect, useReducer } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import { yUndoPluginKey } from '@tiptap/y-tiptap'
import Mention from '@tiptap/extension-mention'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import MathExtension from '@aarkue/tiptap-math-extension'
import { lowlight } from 'lowlight'

const labels = { initialising: 'Checking recovery storage…', journaling: 'Securing recovery draft · keep this tab open', saved: 'Saved to Native Vault', queued: 'Waiting to save · recovery draft retained', saving: 'Saving to Native Vault…',
  retained: 'Recovered pending draft · not yet saved', offline: 'Offline or session expired · draft retained', conflict: 'Conflict · draft retained',
  error: 'Save rejected · draft retained', 'storage-error': 'Recovery storage unavailable · download your draft' }

export default function NativeNoteEditor({ document: model, onDownload, onReview, onCopy, busy }) {
  const [, render] = useReducer(value => value + 1, 0)
  useEffect(() => model.subscribe(render), [model])
  const editor = useEditor({
    extensions: [StarterKit.configure({ undoRedo: false, codeBlock: false, link: false }),
      CodeBlockLowlight.configure({ lowlight }), MathExtension.configure({ evaluation: false, katexOptions: { trust: false, strict: 'error', maxExpand: 1000 } }),
      Mention.configure({ HTMLAttributes: { class: 'wiki-link' }, suggestion: { items: () => [] } }),
      Collaboration.configure({ document: model.doc })],
    editorProps: { attributes: { role: 'textbox', 'aria-label': 'Native rich text editor', 'aria-multiline': 'true' },
      handleDOMEvents: {
        compositionstart: () => { model.setComposing(true); return false },
        compositionend: () => { model.setComposing(false); return false },
      } },
  }, [model])
  useEffect(() => model.subscribe(() => {
    // A confirmed save closes the typing group without replacing the editor,
    // selection or undo history. The next edit can be undone independently.
    if (model.status === 'saved' && editor && !editor.isDestroyed) yUndoPluginKey.getState(editor.state)?.undoManager.stopCapturing()
  }), [model, editor])
  useEffect(() => { editor?.setEditable(!['initialising', 'storage-error', 'conflict'].includes(model.status)) })
  return <div className="native-editor" onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !event.nativeEvent.isComposing) { event.preventDefault(); model.flush() }
  }}>
    <p role="status" aria-live="polite">{labels[model.status]}</p>
    {model.error && <p role="alert">{model.error}</p>}
    <label>Native note title <input value={model.metadata.title || ''} disabled={model.status === 'conflict' || model.status === 'storage-error'} onChange={event => model.setMetadata({ title: event.target.value })} /></label>
    <details><summary>Properties and tags</summary><fieldset disabled={['storage-error', 'conflict'].includes(model.status)} className="native-properties">
      <label>Tags (comma separated) <input disabled={model.metadata.tags !== undefined && (!Array.isArray(model.metadata.tags) || model.metadata.tags.some(tag => typeof tag !== 'string'))} defaultValue={Array.isArray(model.metadata.tags) ? model.metadata.tags.join(', ') : ''} onChange={event => {
        const tags = [...new Set(event.target.value.split(',').map(value => value.trim()).filter(Boolean))]
        if (JSON.stringify(tags) !== JSON.stringify(model.metadata.tags || [])) model.setMetadata({ tags })
      }} /></label>
      <label>Status <select aria-label="Status" value={model.metadata.status || ''} onChange={event => model.setMetadata({ status: event.target.value })}>
        <option value="">No status</option><option value="todo">To do</option><option value="doing">In progress</option><option value="done">Done</option>
        {typeof model.metadata.status === 'string' && !['', 'todo', 'doing', 'done'].includes(model.metadata.status) && <option value={model.metadata.status}>{model.metadata.status}</option>}
      </select></label>
      <label>Due date <input type="date" value={model.metadata.dueDate || ''} onChange={event => model.setMetadata({ dueDate: event.target.value })} /></label>
      <label>Project <input value={model.metadata.project || ''} onChange={event => model.setMetadata({ project: event.target.value })} /></label>
      <label><input type="checkbox" checked={model.metadata.favorite === true} onChange={event => model.setMetadata({ favorite: event.target.checked })} />Favourite</label>
    </fieldset></details>
    <fieldset disabled={['storage-error', 'conflict'].includes(model.status)} className="native-format" role="toolbar" aria-label="Native text formatting">
      <button onClick={() => editor?.chain().focus().toggleBold().run()} aria-label="Native bold">Bold</button>
      <button onClick={() => editor?.chain().focus().toggleItalic().run()} aria-label="Native italic">Italic</button>
      <button onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>Heading</button>
      <button onClick={() => editor?.chain().focus().toggleBulletList().run()}>List</button>
      <button onClick={() => editor?.chain().focus().undo().run()}>Undo</button>
      <button onClick={() => editor?.chain().focus().redo().run()}>Redo</button>
    </fieldset>
    <EditorContent editor={editor} className="tiptap-editor" />
    <button onClick={() => model.flush()} disabled={['saved', 'saving', 'conflict', 'storage-error'].includes(model.status)}>Save / retry</button>
    <button onClick={() => { onDownload(JSON.stringify(model.snapshot(), null, 2), 'native-pending-draft.json'); model.markExported() }}>Download pending draft</button>
    {model.status === 'conflict' && <>
      <button disabled={busy} onClick={onReview}>Compare saved version</button>
      <p>The separate note copies text and properties. Attachments stay with the original note.</p>
      <button disabled={busy} onClick={onCopy}>Save draft as a separate note</button>
    </>}
    <p className="native-hint">Ctrl/⌘+S saves. Ctrl/⌘+Z undoes. Pending drafts stay in this browser until the Vault confirms saving; keep this browser data for recovery.</p>
  </div>
}
