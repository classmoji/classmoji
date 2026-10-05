import { createReactBlockSpec } from '@blocknote/react';
import { calloutConfig } from '@classmoji/page-schema';

export const Callout = createReactBlockSpec(calloutConfig, {
  render: props => {
    return (
      <div className="callout-block">
        <div
          className="callout-emoji"
          contentEditable={false}
          onClick={() => {
            // Simple emoji picker: cycle through common emojis
            const emojis = ['💡', '⚡', '🔥', '📌', '🎯', '💬', '🚀', '⭐'];
            const currentIndex = emojis.indexOf(props.block.props.emoji);
            const nextEmoji = emojis[(currentIndex + 1) % emojis.length];
            props.editor.updateBlock(props.block, {
              props: { emoji: nextEmoji },
            });
          }}
          style={{ cursor: 'pointer', fontSize: '1.5rem' }}
        >
          {props.block.props.emoji}
        </div>
        <div className="inline-content" ref={props.contentRef} style={{ flex: 1 }} />
      </div>
    );
  },
});
