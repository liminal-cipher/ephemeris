import { Extension } from '@tiptap/core';
import { Plugin, TextSelection } from '@tiptap/pm/state';

export const TrimSelectionExtension = Extension.create({
  name: 'trimSelection',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleDoubleClick(view) {
            // Wait for native/ProseMirror double-click word selection to finish
            setTimeout(() => {
              const { state, dispatch } = view;
              const { selection, doc } = state;

              if (selection instanceof TextSelection && !selection.empty) {
                let { from, to } = selection;
                const text = doc.textBetween(from, to, ' ');

                const trailingMatch = text.match(/\s+$/);
                const leadingMatch = text.match(/^\s+/);

                if (trailingMatch) {
                  to -= trailingMatch[0].length;
                }
                if (leadingMatch) {
                  from += leadingMatch[0].length;
                }

                if (from < to && (from !== selection.from || to !== selection.to)) {
                  const newSelection = TextSelection.create(doc, from, to);
                  dispatch(state.tr.setSelection(newSelection));
                }
              }
            }, 0);

            return false;
          },
        },
      }),
    ];
  },
});

export default TrimSelectionExtension;
