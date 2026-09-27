import { useState, useCallback, useEffect, useRef } from 'react';
import { Input, Switch, Button } from 'antd';
import type { MultipartUploadResult } from '@classmoji/ui-components/upload';

import { useToast } from '~/hooks';
import { CloudUploadOutlined, CheckCircleOutlined, FolderOpenOutlined } from '@ant-design/icons';
import PropertySection, { PropertyRow, PropertyLabel } from '../PropertySection';
import { useElementSelection } from '../ElementSelectionContext';
import { VideoUploadDialog } from '~/components/media/VideoUploadDialog';
import { MediaPickerDialog } from '~/components/media/MediaPickerDialog';
import { playableMediaUrl, type MediaPickItem } from '~/utils/mediaClient';
import {
  VIDEO_FILE_ACCEPT,
  deckAssetTarget,
  deckUploadErrorMessage,
  isMediaSource,
} from '~/utils/mediaUpload';

/** The stored `src` — `element.src` would hand back an absolute URL instead. */
const readSrc = (el: HTMLVideoElement | null) => el?.getAttribute('src') ?? el?.src ?? '';

/**
 * VideoProperties - Property editor for video elements
 *
 * Allows configuring:
 * - Source: a URL, an upload, or a video from the class's media
 * - Autoplay
 * - Loop
 * - Muted
 * - Show controls
 *
 * "Upload video" asks the storage router where the file goes: a classroom with
 * media stores videos there (with the three processing choices), one without
 * keeps a video that fits in the course repository, and anything else is
 * refused with the router's own sentence. Every upload route asks the router
 * again, so this only decides what the author sees first.
 */

export default function VideoProperties({ element }: { element: HTMLVideoElement }) {
  const toast = useToast();
  const { onContentChange, uploadCapability, classroomId, slideId, onUploadAsset } =
    useElementSelection();

  // State for all properties
  const [url, setUrl] = useState(() => readSrc(element));
  const [autoplay, setAutoplay] = useState(
    () => element?.hasAttribute('autoplay') || element?.hasAttribute('data-autoplay')
  );
  const [loop, setLoop] = useState(() => element?.hasAttribute('loop'));
  const [muted, setMuted] = useState(() => element?.hasAttribute('muted'));
  const [controls, setControls] = useState(() => element?.hasAttribute('controls'));
  const [repoUploading, setRepoUploading] = useState(false);
  const [dialogFile, setDialogFile] = useState<File | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Sync state when element changes
  useEffect(() => {
    if (element) {
      setUrl(readSrc(element));
      setAutoplay(element.hasAttribute('autoplay') || element.hasAttribute('data-autoplay'));
      setLoop(element.hasAttribute('loop'));
      setMuted(element.hasAttribute('muted'));
      setControls(element.hasAttribute('controls'));
    }
  }, [element]);

  /** Point the element at a new source and tell the editor it changed. */
  const applySrc = useCallback(
    (next: string) => {
      if (!element) return;
      element.setAttribute('src', next);
      element.load?.();
      setUrl(next);
      onContentChange?.();
    },
    [element, onContentChange]
  );

  // Update URL
  const handleUrlChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!element) return;
      const newUrl = e.target.value;
      element.src = newUrl;
      setUrl(newUrl);
      onContentChange?.();
    },
    [element, onContentChange]
  );

  /**
   * A media reference → the element. The editor plays it from a signed URL
   * (the save turns that back into the reference); when there is none to give,
   * the reference itself goes in, which is what is saved either way.
   */
  const placeMedia = useCallback(
    async (ref: string) => {
      applySrc(slideId ? await playableMediaUrl(slideId, ref) : ref);
    },
    [applySrc, slideId]
  );

  const handleMediaUploaded = useCallback(
    async (result: MultipartUploadResult) => {
      setDialogFile(null);
      await placeMedia(result.ref);
      toast.success('Video uploaded.');
    },
    [placeMedia, toast]
  );

  const handlePick = useCallback(
    async (item: MediaPickItem) => {
      setPickerOpen(false);
      await placeMedia(item.ref);
    },
    [placeMedia]
  );

  /**
   * The deck's own upload, repository first. It follows the server once: a
   * repository that answers "this belongs in media" (the capability was stale)
   * sends it there with the dialog's default choices.
   */
  const uploadToRepo = useCallback(
    async (file: File) => {
      if (!onUploadAsset) return;
      setRepoUploading(true);
      try {
        applySrc(await onUploadAsset(file, 'repo'));
        toast.success('Video uploaded.');
      } catch (err: unknown) {
        toast.error(
          deckUploadErrorMessage({ error: err instanceof Error ? err.message : String(err) })
        );
      } finally {
        setRepoUploading(false);
      }
    },
    [onUploadAsset, applySrc, toast]
  );

  // A file was picked: route it, then upload it where it belongs.
  const handleFileChosen = useCallback(
    async (file: File | undefined) => {
      if (!file || !uploadCapability) return;
      const target = deckAssetTarget(uploadCapability, file);

      if (target.kind === 'refused') {
        toast.error(target.message);
        return;
      }
      if (target.kind === 'media') {
        setDialogFile(file);
        return;
      }
      await uploadToRepo(file);
    },
    [uploadCapability, uploadToRepo, toast]
  );

  // Media turned the file away and the repository can take it: close the
  // dialog and upload it there.
  const handleUseRepo = useCallback(
    (file: File) => {
      setDialogFile(null);
      void uploadToRepo(file);
    },
    [uploadToRepo]
  );

  // Update autoplay
  const handleAutoplayChange = useCallback(
    (checked: boolean) => {
      if (!element) return;

      if (checked) {
        element.setAttribute('autoplay', '');
        element.setAttribute('data-autoplay', ''); // Reveal.js uses this
      } else {
        element.removeAttribute('autoplay');
        element.removeAttribute('data-autoplay');
      }
      setAutoplay(checked);
      onContentChange?.();
    },
    [element, onContentChange]
  );

  // Update loop
  const handleLoopChange = useCallback(
    (checked: boolean) => {
      if (!element) return;

      if (checked) {
        element.setAttribute('loop', '');
      } else {
        element.removeAttribute('loop');
      }
      setLoop(checked);
      onContentChange?.();
    },
    [element, onContentChange]
  );

  // Update muted
  const handleMutedChange = useCallback(
    (checked: boolean) => {
      if (!element) return;

      if (checked) {
        element.setAttribute('muted', '');
      } else {
        element.removeAttribute('muted');
      }
      element.muted = checked; // Also set the property for immediate effect
      setMuted(checked);
      onContentChange?.();
    },
    [element, onContentChange]
  );

  // Update controls
  const handleControlsChange = useCallback(
    (checked: boolean) => {
      if (!element) return;

      if (checked) {
        element.setAttribute('controls', '');
      } else {
        element.removeAttribute('controls');
      }
      setControls(checked);
      onContentChange?.();
    },
    [element, onContentChange]
  );

  if (!element) {
    return null;
  }

  // Legacy: videos moved to Cloudinary before media storage existed still play
  // from there, and say so. Nothing new is sent to Cloudinary.
  const isCloudinaryUrl = url?.includes('cloudinary.com');
  const inMedia = isMediaSource(url);
  const isMovFile = url.toLowerCase().endsWith('.mov');

  return (
    <div className="space-y-4">
      <PropertySection title="Video">
        {/* Source */}
        <div>
          <PropertyLabel>URL</PropertyLabel>
          {inMedia && (
            <div className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400 mb-1.5">
              <CheckCircleOutlined />
              <span>From this class&apos;s media</span>
            </div>
          )}
          <Input
            value={inMedia ? '' : url}
            onChange={handleUrlChange}
            placeholder={inMedia ? 'Paste a URL to use instead' : 'https://example.com/video.mp4'}
            size="small"
          />
          {isMovFile && !isCloudinaryUrl && (
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
              .mov files may not play in all browsers
            </p>
          )}
          {isCloudinaryUrl && (
            <div className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400 mt-2">
              <CheckCircleOutlined />
              <span>Hosted on Cloudinary</span>
            </div>
          )}

          {uploadCapability && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept={VIDEO_FILE_ACCEPT}
                className="hidden"
                onChange={event => {
                  const file = event.target.files?.[0];
                  // Cleared so picking the same file again still fires.
                  event.target.value = '';
                  void handleFileChosen(file);
                }}
              />
              <Button
                icon={<CloudUploadOutlined />}
                onClick={() => fileInputRef.current?.click()}
                loading={repoUploading}
                size="small"
                className="w-full mt-2"
              >
                {repoUploading ? 'Uploading…' : 'Upload video'}
              </Button>
              {uploadCapability.media && classroomId && (
                <Button
                  icon={<FolderOpenOutlined />}
                  onClick={() => setPickerOpen(true)}
                  size="small"
                  className="w-full mt-2"
                >
                  Choose from media
                </Button>
              )}
            </>
          )}
        </div>

        {/* Autoplay */}
        <PropertyRow label="Autoplay">
          <Switch checked={autoplay} onChange={handleAutoplayChange} size="small" />
        </PropertyRow>
        {autoplay && !muted && (
          <p className="text-xs text-amber-600 dark:text-amber-400 -mt-2 ml-1">
            Browsers block autoplay unless the video is muted
          </p>
        )}

        {/* Loop */}
        <PropertyRow label="Loop">
          <Switch checked={loop} onChange={handleLoopChange} size="small" />
        </PropertyRow>

        {/* Muted */}
        <PropertyRow label="Muted">
          <Switch checked={muted} onChange={handleMutedChange} size="small" />
        </PropertyRow>

        {/* Controls */}
        <PropertyRow label="Show Controls">
          <Switch checked={controls} onChange={handleControlsChange} size="small" />
        </PropertyRow>
      </PropertySection>

      {classroomId && (
        <>
          <VideoUploadDialog
            file={dialogFile}
            classroomId={classroomId}
            capability={uploadCapability}
            onClose={() => setDialogFile(null)}
            onUploaded={handleMediaUploaded}
            onUseRepo={onUploadAsset ? handleUseRepo : undefined}
          />
          <MediaPickerDialog
            open={pickerOpen}
            classroomId={classroomId}
            onClose={() => setPickerOpen(false)}
            onPick={handlePick}
          />
        </>
      )}
    </div>
  );
}
