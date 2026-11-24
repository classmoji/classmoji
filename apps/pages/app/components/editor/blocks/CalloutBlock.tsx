import { createReactBlockSpec } from '@blocknote/react';
import { calloutConfig } from '@classmoji/page-schema';
import { nextCalloutEmoji } from './readOnlyGates.ts';

export const Callout = createReactBlockSpec(calloutConfig, {
  render: props => {
    // Only an author's click changes the emoji: a reader's would write to a
    // read-only document.
    const editable = props.editor.isEditable;
    return (
      <div className="callout-block">
        <div
          className="callout-emoji"
          contentEditable={false}
          onClick={
            editable
              ? () =>
                  // Simple emoji picker: cycle through common emojis
                  props.editor.updateBlock(props.block, {
                    props: { emoji: nextCalloutEmoji(props.block.props.emoji) },
                  })
              : undefined
          }
          style={{ cursor: editable ? 'pointer' : undefined, fontSize: '1.5rem' }}
        >
          {props.block.props.emoji}
        </div>
        <div className="inline-content" ref={props.contentRef} style={{ flex: 1 }} />
      </div>
    );
  },
});
