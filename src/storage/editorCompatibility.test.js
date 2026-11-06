import { describe, it, expect } from 'vitest'
import { Editor, mergeAttributes } from '@tiptap/core'
import { DOMSerializer } from '@tiptap/pm/model'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import MathExtension from '@aarkue/tiptap-math-extension'
import * as Y from 'yjs'
import { readContent, validateContent } from './noteContent'

describe('editor dependency compatibility and security', () => {
  it('does not promote JSON prototype keys into executable DOM attributes', () => {
    const attrs = mergeAttributes(JSON.parse('{"__proto__":{"onerror":"bad()","src":"https://invalid.example"}}'))
    const { dom } = DOMSerializer.renderSpec(document, ['img', attrs])
    expect(dom.hasAttribute('onerror')).toBe(false)
    expect(dom.hasAttribute('src')).toBe(false)
    expect(Object.getPrototypeOf(attrs)).toBe(Object.prototype)
  })

  it('edits existing Yjs text and maths without replacing identities, attributes or opaque roots', () => {
    const doc = new Y.Doc()
    const paragraph = new Y.XmlElement('paragraph'), text = new Y.XmlText()
    text.insert(0, '한국어 original', { bold: {} })
    const math = new Y.XmlElement('inlineMath')
    for (const [key, value] of Object.entries({ latex: 'x^2 + \\frac{1}{2}', evaluate: 'no', display: 'yes' })) math.setAttribute(key, value)
    paragraph.insert(0, [text, math]); doc.getXmlFragment('default').insert(0, [paragraph])
    doc.getMap('ephemeris').set('retained', 'source metadata')
    const other = new Y.Doc(); Y.applyUpdate(other, Y.encodeStateAsUpdate(doc))
    const editor = new Editor({ element: document.createElement('div'),
      extensions: [StarterKit.configure({ undoRedo: false }), MathExtension, Collaboration.configure({ document: doc })] })
    try {
      expect(editor.getText()).toContain('한국어 original')
      expect(editor.view.dom.querySelector('.katex')).not.toBeNull()
      editor.commands.insertContentAt(1, 'Edited ')
      Y.applyUpdate(other, Y.encodeStateAsUpdate(doc))
      const content = readContent(other)
      expect(validateContent(content).textContent).toContain('Edited 한국어 original')
      expect(content.content[0].content.find(node => node.type === 'inlineMath').attrs)
        .toMatchObject({ latex: 'x^2 + \\frac{1}{2}', evaluate: 'no', display: 'yes' })
      expect(other.getMap('ephemeris').get('retained')).toBe('source metadata')
      expect(doc.getXmlFragment('default').get(0)).toBe(paragraph)
    } finally { editor.destroy(); other.destroy(); doc.destroy() }
  })
})
