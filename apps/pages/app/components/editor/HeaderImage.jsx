import { useState, useRef, useCallback } from 'react';
import { useFetcher } from 'react-router';
import useHeaderImageDrag from '~/hooks/useHeaderImageDrag.js';

/**
 * Header/banner image with Notion-style drag-to-reposition.
 *
 * Handles: no image (add cover button), display, upload, reposition, remove.
 * All mutations go through the route action via useFetcher.
 */
const HeaderImage = ({ imageUrl, position, editMode, pageId }) => {
  const [isHovering, setIsHovering] = useState(false);
  const [isRepositioning, setIsRepositioning] = useState(false);
  const [localPosition, setLocalPosition] = useState(position);

  const containerRef = useRef(null);
  const fileInputRef = useRef(null);
  const fetcher = useFetcher();
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

  const handleFileSelect = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('intent', 'upload-header-image');
    formData.append('file', file);

    fetcher.submit(formData, {
      method: 'POST',
      encType: 'multipart/form-data',
    });

    // Reset input so same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [fetcher]);

  const handleStartReposition = useCallback(() => {
    positionBeforeReposition.current = localPosition;
    setIsRepositioning(true);
  }, [localPosition]);

  const handleSavePosition = useCallback(() => {
    setIsRepositioning(false);
    fetcher.submit(
      { intent: 'set-header-image', url: imageUrl, position: localPosition },
      { method: 'POST', encType: 'application/json' },
    );
  }, [fetcher, imageUrl, localPosition]);

  const handleCancelReposition = useCallback(() => {
    setLocalPosition(positionBeforeReposition.current);
    setIsRepositioning(false);
  }, []);

  const handleRemove = useCallback(() => {
    fetcher.submit(
      { intent: 'set-header-image', url: null, position: 50 },
      { method: 'POST', encType: 'application/json' },
    );
  }, [fetcher]);

  const handleAddCover = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleChangeCover = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

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

    const uploading = fetcher.state !== 'idle';

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
  const isBusy = fetcher.state !== 'idle';

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
            <button
              type="button"
              onClick={handleSavePosition}
              className="header-image-btn"
            >
              Save position
            </button>
            <button
              type="button"
              onClick={handleCancelReposition}
              className="header-image-btn"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Hover controls (edit mode, not repositioning) */}
      {editMode && isHovering && !isRepositioning && !isBusy && (
        <div className="absolute inset-0 bg-black/10 flex items-center justify-center gap-2 z-10">
          <button
            type="button"
            onClick={handleChangeCover}
            className="header-image-btn"
          >
            Change cover
          </button>
          <button
            type="button"
            onClick={handleStartReposition}
            className="header-image-btn"
          >
            Reposition
          </button>
          <button
            type="button"
            onClick={handleRemove}
            className="header-image-btn"
          >
            Remove
          </button>
        </div>
      )}
    </div>
  );
};

export default HeaderImage;
