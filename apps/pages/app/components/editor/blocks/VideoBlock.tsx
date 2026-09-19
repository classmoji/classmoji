import { createReactBlockSpec } from '@blocknote/react';
import { IconPlayerPlay } from '@tabler/icons-react';
import { useResolvedFileUrl } from './useResolvedFileUrl.ts';

/**
 * Convert YouTube/Vimeo URLs to embeddable URLs
 */
function getEmbedUrl(url: string): string {
  if (!url) return '';

  // YouTube
  const ytMatch = url.match(
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]+)/
  );
  if (ytMatch) return `https://www.youtube.com/embed/${ytMatch[1]}`;

  // Vimeo
  const vimeoMatch = url.match(/vimeo\.com\/(\d+)/);
  if (vimeoMatch) return `https://player.vimeo.com/video/${vimeoMatch[1]}`;

  // Direct video URL or already embeddable
  return url;
}

function isDirectVideo(url: string): boolean {
  return /\.(mp4|webm|ogg)(\?|$)/i.test(url);
}

export const Video = createReactBlockSpec(
  {
    type: 'video',
    propSchema: {
      url: { default: '' },
      caption: { default: '' },
    },
    content: 'none',
  },
  {
    // A NAMED function so React (and the hooks lint) sees a component — the
    // hook below is only legal inside one.
    render: function VideoRenderer(props) {
      const { url, caption } = props.block.props;
      const isEditable = props.editor.isEditable;
      const embedUrl = getEmbedUrl(url);

      // The block stores a reference; this is the URL to play it from.
      // BlockNote calls `resolveFileUrl` for its own file blocks only, so a
      // custom block that puts a stored reference straight into `src` asks the
      // browser to fetch a repo path relative to the pages origin — a 404.
      const resolvedUrl = useResolvedFileUrl(url, props.editor.resolveFileUrl);

      // Which branch renders is decided by what the AUTHOR typed, never by what
      // the reference resolved to, so resolution can never flip a deck between
      // the <video> and <iframe> layouts.
      //
      // `getEmbedUrl` returning the input unchanged means it recognized no
      // provider — and that passthrough case is exactly where a repo path can
      // appear. A real YouTube/Vimeo embed is external by construction and is
      // left alone.
      const embedSrc = embedUrl === url ? resolvedUrl : embedUrl;

      return (
        <div contentEditable={false}>
          {!url ? (
            /* Empty state: icon + input */
            <div className="video-input-wrapper-empty">
              <IconPlayerPlay size={20} className="video-icon" />
              <input
                value={url}
                onChange={e =>
                  props.editor.updateBlock(props.block, {
                    props: { url: e.target.value },
                  })
                }
                placeholder="Paste a video URL (YouTube, Vimeo, or direct link)"
                className="video-url-input"
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
            <>
              {isDirectVideo(url) ? (
                // eslint-disable-next-line jsx-a11y/media-has-caption -- user-uploaded content
                <video
                  src={resolvedUrl}
                  controls
                  style={{
                    width: '100%',
                    borderRadius: '0.5rem',
                  }}
                />
              ) : (
                <div
                  style={{
                    position: 'relative',
                    paddingBottom: '56.25%',
                    height: 0,
                    overflow: 'hidden',
                    borderRadius: '0.5rem',
                  }}
                >
                  <iframe
                    src={embedSrc}
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
                    title="Video"
                  />
                </div>
              )}

              {/* Caption */}
              {isEditable ? (
                <input
                  value={caption}
                  onChange={e =>
                    props.editor.updateBlock(props.block, {
                      props: { caption: e.target.value },
                    })
                  }
                  placeholder="Add a caption..."
                  className="media-block-caption"
                />
              ) : (
                caption && <p className="media-block-caption-view">{caption}</p>
              )}
            </>
          )}
        </div>
      );
    },
  }
);
