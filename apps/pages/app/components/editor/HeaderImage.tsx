import React, { useState, useRef, useCallback } from 'react';
import { useFetcher } from 'react-router';
import type { UploadCapability } from '@classmoji/services/media/router';
import useHeaderImageDrag from '~/hooks/useHeaderImageDrag.ts';
import { usePageMedia } from './media/PageMedia.tsx';
import { useCoverUpload, type LiveCoverTarget } from './media/useCoverUpload.ts';

/**
 * Header/banner image with Notion-style drag-to-reposition.
 *
 * Handles: no image (add cover button), display, upload, reposition, remove.
 * All mutations go through the route action via useFetcher.
 */
interface HeaderImageProps {
  imageUrl: string | null;
  position: number;
  editMode: boolean;
  pageId: string;
  /** Where a new cover goes (`storageTargetFor`); null routes it to the repository. */
  uploadCapability?: UploadCapability | null;
  /**
   * Live editing: every change is a write to the live document's cover
   * (`target.setCover`), and `storedUrl` is the reference it stores —
   * `imageUrl` is only the URL it is displayed with.
   */
  live?: { storedUrl: string | null; target: LiveCoverTarget } | null;
  /** A rendered preview marks the cover it changes (never a diff). */
  highlighted?: boolean;
}

const HeaderImage = ({
  imageUrl,
  position,
  editMode,
  pageId: _pageId,
  uploadCapability = null,
  live = null,
  highlighted = false,
}: HeaderImageProps) => {
  const [isHovering, setIsHovering] = useState(false);
  const [isRepositioning, setIsRepositioning] = useState(false);
  const [localPosition, setLocalPosition] = useState(position);

  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fetcher = useFetcher();
  const media = usePageMedia();
  // Uploads through the storage router, and owns this fetcher's failure toast
  // (the 409 "page changed — try again" from the cover CAS write included).
  const cover = useCoverUpload(fetcher, uploadCapability, live?.target ?? null);
  const positionBeforeReposition = useRef(position);

  // Sync localPosition when prop changes (e.g. after save + revalidation)
  // but not while actively repositioning
  const lastPropPosition = useRef(position);
  if (position !== lastPropPosition.current && !isRepositioning) {
    lastPropPosition.current = position;
    setLocalPosition(position);
  }

  const { handleMouseDown, handleTouchStart } = useHeaderImageDrag({
    position: localPosition,
    onPositionChange: setLocalPosition,
    enabled: isRepositioning,
    containerRef,
  });

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // Reset input so same file can be re-selected
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (file) cover.upload(file);
    },
    [cover]
  );

  const handleStartReposition = useCallback(() => {
    positionBeforeReposition.current = localPosition;
    setIsRepositioning(true);
  }, [localPosition]);

  const handleSavePosition = useCallback(() => {
    setIsRepositioning(false);
    if (live) {
      if (live.storedUrl) live.target.setCover({ url: live.storedUrl, position: localPosition });
      return;
    }
    fetcher.submit(
      { intent: 'set-header-image', url: imageUrl, position: localPosition },
      { method: 'POST', encType: 'application/json' }
    );
  }, [fetcher, imageUrl, localPosition, live]);

  const handleCancelReposition = useCallback(() => {
    setLocalPosition(positionBeforeReposition.current);
    setIsRepositioning(false);
  }, []);

  const handleRemove = useCallback(() => {
    if (live) {
      live.target.setCover(null);
      return;
    }
    fetcher.submit(
      { intent: 'set-header-image', url: null, position: 50 },
      { method: 'POST', encType: 'application/json' }
    );
  }, [fetcher, live]);

  const handleAddCover = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleChangeCover = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  // An image the classroom already stores in media, as the cover. The stored
  // cover is the `media://` reference; the loader signs it like any other.
  const handleChooseFromMedia = useCallback(async () => {
    const item = await media.choose('IMAGE');
    if (!item) return;
    if (live) {
      // `choose` has already fetched the display URL for the reference.
      live.target.setCover({ url: item.ref, position: 50 });
      return;
    }
    fetcher.submit(
      { intent: 'set-header-image', url: item.ref, position: 50 },
      { method: 'POST', encType: 'application/json' }
    );
  }, [fetcher, media, live]);

  // Hidden file input (shared by add + change)
  const fileInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept="image/*"
      onChange={handleFileSelect}
      className="hidden"
    />
  );

  // --- No image ---
  if (!imageUrl) {
    if (!editMode) return null;

    const uploading = fetcher.state !== 'idle' || cover.uploading;

    // Edit mode: "Add cover" button with upload spinner
    return (
      <div className="w-full flex justify-center py-1.5">
        {fileInput}
        {uploading ? (
          <div className="flex items-center gap-2 px-3 py-1 text-sm text-gray-500 dark:text-gray-400">
            <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
            <span>Uploading...</span>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleAddCover}
            className="
              px-3 py-1 text-sm text-gray-500 dark:text-gray-400
              hover:bg-gray-100 dark:hover:bg-gray-800
              rounded-md transition-colors
            "
          >
            Add cover
          </button>
        )}
      </div>
    );
  }

  // --- Has image ---
  const isBusy = fetcher.state !== 'idle' || cover.uploading;

  return (
    <div
      ref={containerRef}
      className="page-header-image relative w-full overflow-hidden"
      style={{
        backgroundImage: `url(${imageUrl})`,
        backgroundPosition: `center ${localPosition}%`,
      }}
      onMouseEnter={() => !isRepositioning && setIsHovering(true)}
      onMouseLeave={() => !isRepositioning && setIsHovering(false)}
      onMouseDown={isRepositioning ? handleMouseDown : undefined}
      onTouchStart={isRepositioning ? handleTouchStart : undefined}
    >
      {fileInput}

      {highlighted && (
        <div
          data-testid="preview-cover-changed"
          className="pointer-events-none absolute inset-0 z-10 shadow-[inset_0_0_0_3px_rgb(245,158,11)] dark:shadow-[inset_0_0_0_3px_rgb(251,191,36)]"
        >
          <span className="absolute left-3 top-3 rounded-full bg-amber-500 px-2 py-0.5 text-xs font-semibold text-white dark:bg-amber-400 dark:text-amber-950">
            Cover changed
          </span>
        </div>
      )}

      {/* Uploading spinner overlay */}
      {isBusy && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-20">
          <div className="w-8 h-8 border-3 border-white border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* Repositioning mode overlay */}
      {editMode && isRepositioning && !isBusy && (
        <div
          className="absolute inset-0 bg-black/30 flex flex-col items-center justify-center z-10"
          style={{ cursor: 'ns-resize' }}
        >
          <span className="text-white text-sm font-medium mb-3 select-none pointer-events-none">
            Drag image to reposition
          </span>
          <div className="flex gap-2 pointer-events-auto">
            <button type="button" onClick={handleSavePosition} className="header-image-btn">
              Save position
            </button>
            <button type="button" onClick={handleCancelReposition} className="header-image-btn">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Hover controls (edit mode, not repositioning) */}
      {editMode && isHovering && !isRepositioning && !isBusy && (
        <div className="absolute inset-0 bg-black/10 flex items-center justify-center gap-2 z-10">
          <button type="button" onClick={handleChangeCover} className="header-image-btn">
            Change cover
          </button>
          {media.canUseMedia && (
            <button type="button" onClick={handleChooseFromMedia} className="header-image-btn">
              Choose from media
            </button>
          )}
          <button type="button" onClick={handleStartReposition} className="header-image-btn">
            Reposition
          </button>
          <button type="button" onClick={handleRemove} className="header-image-btn">
            Remove
          </button>
        </div>
      )}
    </div>
  );
};

export default HeaderImage;
