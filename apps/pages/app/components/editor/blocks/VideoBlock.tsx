import { useRef, useState } from 'react';
import { createReactBlockSpec } from '@blocknote/react';
import { videoConfig } from '@classmoji/page-schema';
import { IconPlayerPlay } from '@tabler/icons-react';
import { useResolvedFileUrl } from './useResolvedFileUrl.ts';
import { usePageMedia } from '../media/PageMedia.tsx';
import { toast } from 'react-toastify';
import { extensionsOfKind } from '@classmoji/services/media/router';
import { isMediaRef, playsAsNativeVideo } from '~/utils/mediaRefs.ts';
import { UploadCancelled, UploadRefused } from '../media/uploadRouting.ts';
import { MediaDownloadLink } from '~/components/viewer/MediaDownloadLink.tsx';
import { currentPageOrigin, decideFrame } from './safeFrame.ts';
import { SafeFrame } from './frameElement.ts';
import { fieldBlockView, readerCanShowMedia } from './readOnlyGates.ts';

/** What a failed upload says when there is no refusal sentence to show. */
const UPLOAD_INTERRUPTED = 'The upload could not finish. Check your connection and try again.';

/**
 * Formats the upload picker offers: `video/*`, plus every video extension the
 * store knows by name (several have no `video/` type a browser matches on).
 * The store's own list, through the router — which also decides where each goes.
 */
const VIDEO_ACCEPT = ['video/*', ...extensionsOfKind('VIDEO').map(ext => `.${ext}`)].join(',');

/** A small text button in the empty state, matching the input beside it. */
const EMPTY_STATE_BUTTON =
  'shrink-0 rounded px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700';

export const Video = createReactBlockSpec(videoConfig, {
  // A NAMED function so React (and the hooks lint) sees a component — the
  // hook below is only legal inside one.
  render: function VideoRenderer(props) {
    const { url, caption } = props.block.props;
    const isEditable = props.editor.isEditable;
    const media = usePageMedia();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [uploading, setUploading] = useState<string | null>(null);

    // The block stores a reference; this is the URL to play it from.
    // BlockNote calls `resolveFileUrl` for its own file blocks only, so a
    // custom block that puts a stored reference straight into `src` asks the
    // browser to fetch a repo path relative to the pages origin — a 404.
    const resolvedUrl = useResolvedFileUrl(url, props.editor.resolveFileUrl);

    // Which branch renders is decided by what the AUTHOR stored, never by what
    // the reference resolved to, so resolution can never flip a block between
    // the <video> and <iframe> layouts. A media reference is a native video
    // by its scheme — it has no extension to judge, and its signed URL ends
    // in a variant name rather than the format.
    //
    // No delivery origin here: `url` is what the author stored — a `media://`
    // reference or a pasted link — so the scheme and the extension decide, and
    // a media-shaped URL is judged like any other link (a signed one is saved
    // back as its reference).
    const nativeVideo = playsAsNativeVideo(url, null);
    // Until its display URL is known a media reference has nothing playable;
    // `media://` in `src` is a scheme no browser fetches.
    const videoSrc = isMediaRef(resolvedUrl) ? undefined : resolvedUrl;

    const setUrl = (next: string) => {
      try {
        props.editor.updateBlock(props.block, { props: { url: next } });
      } catch {
        // The block was deleted while the upload ran; nothing to update.
      }
    };

    // Through the editor's own `uploadFile` — the page editor's storage
    // router — so a file chosen here lands exactly where one dropped on the
    // page would: the repository, or media on a Pro classroom. It toasts its
    // own refusals and progress.
    const upload = async (file: File) => {
      const uploadFile = props.editor.uploadFile;
      if (!uploadFile) return;
      setUploading(file.name);
      try {
        const result = await uploadFile(file, props.block.id);
        const next =
          typeof result === 'string'
            ? result
            : (result as { props?: { url?: unknown } })?.props?.url;
        if (typeof next === 'string' && next) setUrl(next);
      } catch (error) {
        // A refusal was toasted by the upload handler with its reason, and a
        // cancel says nothing. Anything else (the network dropped, the
        // server fell over) would otherwise vanish without a word.
        if (!(error instanceof UploadRefused) && !(error instanceof UploadCancelled)) {
          toast.error(UPLOAD_INTERRUPTED);
        }
      } finally {
        setUploading(null);
      }
    };

    const chooseFromMedia = async () => {
      const item = await media.choose('VIDEO');
      if (item) setUrl(item.ref);
    };

    const view = fieldBlockView(isEditable, Boolean(url));
    // A reader of an empty video gets nothing: the URL box is an author's.
    if (view === 'nothing') return null;

    // The iframe branch: https only, sandboxed, never our own media
    // (safeFrame.ts). A recognised provider is converted from the stored URL;
    // anything else frames from what the reference resolved to.
    const frame = nativeVideo ? null : decideFrame(url, resolvedUrl, currentPageOrigin());

    // A reader is never handed a player for media that cannot play: a
    // reference still unresolved, or the placeholder for one that could not
    // be signed. Nothing renders instead of a broken element.
    if (!isEditable) {
      if (nativeVideo && !readerCanShowMedia(url, resolvedUrl)) return null;
      if (frame?.kind === 'none') return null;
    }

    return (
      <div contentEditable={false}>
        {view === 'empty-state' ? (
          /* Empty state: icon + input, and the two ways to bring a file */
          <div className="video-input-wrapper-empty">
            <IconPlayerPlay size={20} className="video-icon" />
            {uploading ? (
              <div className="flex min-w-0 flex-1 items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
                <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
                <span className="truncate">Uploading {uploading}</span>
              </div>
            ) : (
              <>
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
                {isEditable && props.editor.uploadFile && (
                  <>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept={VIDEO_ACCEPT}
                      className="hidden"
                      onChange={e => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (file) void upload(file);
                      }}
                    />
                    <button
                      type="button"
                      className={EMPTY_STATE_BUTTON}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      Upload
                    </button>
                  </>
                )}
                {isEditable && media.canUseMedia && (
                  <button
                    type="button"
                    className={EMPTY_STATE_BUTTON}
                    onClick={() => void chooseFromMedia()}
                  >
                    Choose from media
                  </button>
                )}
              </>
            )}
          </div>
        ) : (
          /* Populated state */
          <>
            {frame ? (
              <SafeFrame decision={frame} title="Video" editable={isEditable} storedUrl={url} />
            ) : (
              // eslint-disable-next-line jsx-a11y/media-has-caption -- user-uploaded content
              <video
                src={videoSrc}
                controls
                style={{
                  width: '100%',
                  borderRadius: '0.5rem',
                }}
              />
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

            {/* A reader's Download button — only in the viewer, and only
                  for a media video its uploader let students download (the
                  teaching team always). No provider in the editor: none. */}
            {!isEditable && <MediaDownloadLink fileRef={url} />}
          </>
        )}
      </div>
    );
  },
});
