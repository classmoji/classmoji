import { createReactBlockSpec } from '@blocknote/react';
import { embedConfig } from '@classmoji/page-schema';
import { IconWorld } from '@tabler/icons-react';
import { useResolvedFileUrl } from './useResolvedFileUrl.ts';
import { currentPageOrigin, decideFrame } from './safeFrame.ts';
import { SafeFrame } from './frameElement.ts';
import { fieldBlockView } from './readOnlyGates.ts';

export const Embed = createReactBlockSpec(embedConfig, {
  // A NAMED function so React (and the hooks lint) sees a component — the
  // hook below is only legal inside one.
  render: function EmbedRenderer(props) {
    const { url } = props.block.props;
    const editable = props.editor.isEditable;

    // The block stores a reference; this is the URL to frame it from. An
    // embed is usually a foreign page (a Google Doc, a CodeSandbox) and those
    // are never in the display map, so they come back untouched — but an
    // embed can just as easily name a PDF in the content repo, and that one
    // was being handed to the iframe as a bare repo path: a 404 resolved
    // against the pages origin. BlockNote calls `resolveFileUrl` for its own
    // file blocks only, so a custom block has to make the call itself.
    const resolvedUrl = useResolvedFileUrl(url, props.editor.resolveFileUrl);

    const view = fieldBlockView(editable, Boolean(url));
    // A reader of an empty embed gets nothing: the URL box is an author's.
    if (view === 'nothing') return null;

    if (view === 'empty-state') {
      return (
        <div contentEditable={false}>
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
        </div>
      );
    }

    // https only, sandboxed, never our own media (safeFrame.ts).
    const decision = decideFrame(url, resolvedUrl, currentPageOrigin());
    if (decision.kind === 'none' && !editable) return null;

    return (
      <div contentEditable={false}>
        <SafeFrame
          decision={decision}
          title="Embedded content"
          editable={editable}
          storedUrl={url}
          boxStyle={{ border: '1px solid #e2e8f0' }}
        />
      </div>
    );
  },
});
