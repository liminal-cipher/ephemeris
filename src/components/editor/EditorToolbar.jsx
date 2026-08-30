import React from 'react'
import { BubbleMenu } from '@tiptap/react'
import { Bold, Italic, Underline as UnderlineIcon, Strikethrough } from 'lucide-react'

export default function EditorToolbar({ editor }) {
  if (!editor) return null;

  return (
    <BubbleMenu editor={editor} tippyOptions={{ duration: 100 }} className="bubble-menu">
      <button
        onClick={() => editor.chain().focus().toggleBold().run()}
        className={editor.isActive('bold') ? 'is-active' : ''}
        aria-label="Format Bold"
        aria-pressed={editor.isActive('bold')}
      >
        <Bold size={16} aria-hidden="true" />
      </button>
      <button
        onClick={() => editor.chain().focus().toggleItalic().run()}
        className={editor.isActive('italic') ? 'is-active' : ''}
        aria-label="Format Italic"
        aria-pressed={editor.isActive('italic')}
      >
        <Italic size={16} aria-hidden="true" />
      </button>
      <button
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        className={editor.isActive('underline') ? 'is-active' : ''}
        aria-label="Format Underline"
        aria-pressed={editor.isActive('underline')}
      >
        <UnderlineIcon size={16} aria-hidden="true" />
      </button>
      <button
        onClick={() => editor.chain().focus().toggleStrike().run()}
        className={editor.isActive('strike') ? 'is-active' : ''}
        aria-label="Format Strikethrough"
        aria-pressed={editor.isActive('strike')}
      >
        <Strikethrough size={16} aria-hidden="true" />
      </button>
    </BubbleMenu>
  )
}
