import { createReactBlockSpec } from '@blocknote/react';
import { IconWorld } from '@tabler/icons-react';

export const Embed = createReactBlockSpec(
  {
    type: 'embed',
    propSchema: {
      url: { default: '' },
      type: { default: '' },
    },
    content: 'none',
  },
  {
    render: (props) => {
      const { url } = props.block.props;

      return (
        <div contentEditable={false}>
          {!url ? (
            /* Empty state: icon + input */
            <div className="embed-input-wrapper-empty">
              <IconWorld size={20} className="embed-icon" />
              <input
                value={url}
                onChange={(e) =>
                  props.editor.updateBlock(props.block, {
                    props: { url: e.target.value },
                  })
                }
                placeholder="Embed anything (PDFs, Google Docs, Google Maps, Spotify...)"
                className="embed-input"
                style={{
                  width: '100%',
                  padding: '0',
                  border: 'none',
                  borderRadius: '0.375rem',
                  fontSize: '0.875rem',
                  background: 'transparent',
                  color: 'inherit',
                }}
              />
            </div>
          ) : (
            /* Populated state */
            <div
              style={{
                position: 'relative',
                paddingBottom: '56.25%',
                height: 0,
                overflow: 'hidden',
                borderRadius: '0.5rem',
                border: '1px solid #e2e8f0',
              }}
            >
              <iframe
                src={url}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: '100%',
                  border: 'none',
                }}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                title="Embedded content"
              />
            </div>
          )}
        </div>
      );
    },
  }
);
