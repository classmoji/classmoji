import { createReactBlockSpec } from '@blocknote/react';
import { IconPlayerPlay } from '@tabler/icons-react';

/**
 * Convert YouTube/Vimeo URLs to embeddable URLs
 */
function getEmbedUrl(url) {
  if (!url) return '';

  // YouTube
  const ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]+)/);
  if (ytMatch) return `https://www.youtube.com/embed/${ytMatch[1]}`;

  // Vimeo
  const vimeoMatch = url.match(/vimeo\.com\/(\d+)/);
  if (vimeoMatch) return `https://player.vimeo.com/video/${vimeoMatch[1]}`;

  // Direct video URL or already embeddable
  return url;
}

function isDirectVideo(url) {
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
    render: (props) => {
      const { url, caption } = props.block.props;
      const isEditable = props.editor.isEditable;
      const embedUrl = getEmbedUrl(url);

      return (
        <div contentEditable={false}>
          {!url ? (
            /* Empty state: icon + input */
            <div className="video-input-wrapper-empty">
              <IconPlayerPlay size={20} className="video-icon" />
              <input
                value={url}
                onChange={(e) =>
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
                <video
                  src={url}
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
                    src={embedUrl}
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
                  onChange={(e) =>
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
