import { createReactBlockSpec } from '@blocknote/react';
import { IconWorld } from '@tabler/icons-react';
import { useResolvedFileUrl } from './useResolvedFileUrl.ts';

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
    // A NAMED function so React (and the hooks lint) sees a component — the
    // hook below is only legal inside one.
    render: function EmbedRenderer(props) {
      const { url } = props.block.props;

      // The block stores a reference; this is the URL to frame it from. An
      // embed is usually a foreign page (a Google Doc, a CodeSandbox) and those
      // are never in the display map, so they come back untouched — but an
      // embed can just as easily name a PDF in the content repo, and that one
      // was being handed to the iframe as a bare repo path: a 404 resolved
      // against the pages origin. BlockNote calls `resolveFileUrl` for its own
      // file blocks only, so a custom block has to make the call itself.
      const resolvedUrl = useResolvedFileUrl(url, props.editor.resolveFileUrl);

      return (
        <div contentEditable={false}>
          {!url ? (
            /* Empty state: icon + input */
            <div className="embed-input-wrapper-empty">
              <IconWorld size={20} className="embed-icon" />
              <input
                value={url}
                onChange={e =>
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
                src={resolvedUrl}
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
