import { ReactRenderer } from '@tiptap/react';
import tippy from 'tippy.js';
import SlashCommandList from './SlashCommandList.jsx';
import { 
  Heading1, Heading2, Heading3, 
  Code2, Calculator, List, 
  ListOrdered, Quote 
} from 'lucide-react';

export default {
  items: ({ query }) => {
    return [
      {
        title: 'Heading 1',
        description: 'Big section heading.',
        icon: Heading1,
        command: ({ editor, range }) => {
          editor.chain().focus().deleteRange(range).setNode('heading', { level: 1 }).run();
        },
      },
      {
        title: 'Heading 2',
        description: 'Medium section heading.',
        icon: Heading2,
        command: ({ editor, range }) => {
          editor.chain().focus().deleteRange(range).setNode('heading', { level: 2 }).run();
        },
      },
      {
        title: 'Heading 3',
        description: 'Small section heading.',
        icon: Heading3,
        command: ({ editor, range }) => {
          editor.chain().focus().deleteRange(range).setNode('heading', { level: 3 }).run();
        },
      },
      {
        title: 'Bullet List',
        description: 'Create a simple bulleted list.',
        icon: List,
        command: ({ editor, range }) => {
          editor.chain().focus().deleteRange(range).toggleBulletList().run();
        },
      },
      {
        title: 'Numbered List',
        description: 'Create a list with numbering.',
        icon: ListOrdered,
        command: ({ editor, range }) => {
          editor.chain().focus().deleteRange(range).toggleOrderedList().run();
        },
      },
      {
        title: 'Blockquote',
        description: 'Capture a quote.',
        icon: Quote,
        command: ({ editor, range }) => {
          editor.chain().focus().deleteRange(range).setBlockquote().run();
        },
      },
      {
        title: 'Code Block',
        description: 'Capture a code snippet.',
        icon: Code2,
        command: ({ editor, range }) => {
          editor.chain().focus().deleteRange(range).setCodeBlock().run();
        },
      },
      {
        title: 'Math Formula',
        description: 'Insert a LaTeX math formula.',
        icon: Calculator,
        command: ({ editor, range }) => {
          editor.chain().focus().deleteRange(range).insertContent({ type: 'inlineMath', attrs: { latex: 'E = mc^2' } }).run();
        },
      },
    ].filter(item => item.title.toLowerCase().includes(query.toLowerCase())).slice(0, 10);
  },

  render: () => {
    let component;
    let popup;

    return {
      onStart: props => {
        component = new ReactRenderer(SlashCommandList, {
          props,
          editor: props.editor,
        });

        if (!props.clientRect) {
          return;
        }

        popup = tippy('body', {
          getReferenceClientRect: props.clientRect,
          appendTo: () => document.body,
          content: component.element,
          showOnCreate: true,
          interactive: true,
          trigger: 'manual',
          placement: 'bottom-start',
        });
      },

      onUpdate(props) {
        component.updateProps(props);

        if (!props.clientRect) {
          return;
        }

        popup[0].setProps({
          getReferenceClientRect: props.clientRect,
        });
      },

      onKeyDown(props) {
        if (props.event.key === 'Escape') {
          popup[0].hide();
          return true;
        }
        return component.ref?.onKeyDown(props);
      },

      onExit() {
        popup[0].destroy();
        component.destroy();
      },
    };
  },
};
