import React from 'react'
import { BubbleMenu } from '@tiptap/react/menus'
import { Bold, Italic, Underline as UnderlineIcon, Strikethrough } from 'lucide-react'

export default function EditorToolbar({ editor }) {
  const format = command => {
    if (!editor || editor.isDestroyed) return
    editor.view.focus()
    command(editor.chain()).run()
  }
  if (!editor) return null;

  return (
    <BubbleMenu editor={editor} className="bubble-menu">
      <button
        onClick={() => format(chain => chain.toggleBold())}
        className={editor.isActive('bold') ? 'is-active' : ''}
        aria-label="Format Bold"
        aria-pressed={editor.isActive('bold')}
      >
        <Bold size={16} aria-hidden="true" />
      </button>
      <button
        onClick={() => format(chain => chain.toggleItalic())}
        className={editor.isActive('italic') ? 'is-active' : ''}
        aria-label="Format Italic"
        aria-pressed={editor.isActive('italic')}
      >
        <Italic size={16} aria-hidden="true" />
      </button>
      <button
        onClick={() => format(chain => chain.toggleUnderline())}
        className={editor.isActive('underline') ? 'is-active' : ''}
        aria-label="Format Underline"
        aria-pressed={editor.isActive('underline')}
      >
        <UnderlineIcon size={16} aria-hidden="true" />
      </button>
      <button
        onClick={() => format(chain => chain.toggleStrike())}
        className={editor.isActive('strike') ? 'is-active' : ''}
        aria-label="Format Strikethrough"
        aria-pressed={editor.isActive('strike')}
      >
        <Strikethrough size={16} aria-hidden="true" />
      </button>
    </BubbleMenu>
  )
}
