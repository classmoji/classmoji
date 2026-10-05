import { useMemo } from 'react';
import { ConfigProvider, Popconfirm, theme } from 'antd';

import { useIsDarkMode } from '~/hooks/useIsDarkMode';
import { thumbnailHtml } from '../blocks/slideBlocks';

/**
 * SlideThumbnail - CSS-scaled preview of a slide
 *
 * Uses CSS transform scaling to show a miniature version of the slide.
 * The actual slide DOM is cloned and scaled down for accurate representation.
 */
import type { SlideData } from './hooks/useSlideStructure';

interface SlideThumbnailProps {
  slide: SlideData;
  onClick?: () => void;
  onDelete?: () => void;
  isDragging?: boolean;
  isInStack?: boolean;
  small?: boolean;
  showDelete?: boolean;
  canDelete?: boolean;
}

export default function SlideThumbnail({
  slide,
  onClick,
  onDelete,
  isDragging = false,
  isInStack = false,
  small = false,
  showDelete = true,
  canDelete = true,
}: SlideThumbnailProps) {
  const isDark = useIsDarkMode();
  // The slide's markup, with html blocks kept from running (a placeholder
  // shows instead). Re-read for every parse of the deck (a new `slide`).
  const slideHtml = useMemo(() => {
    if (!slide?.element) return '<p>Empty slide</p>';
    return thumbnailHtml(slide.element);
  }, [slide]);

  // Dimensions based on size
  const containerWidth = small ? 120 : 180;
  const containerHeight = small ? 80 : 120;

  // Original Reveal.js slide dimensions (approximate)
  const originalWidth = 960;
  const originalHeight = 700;

  // Calculate scale
  const scale = containerWidth / originalWidth;

  return (
    <div
      className={`
        relative group cursor-pointer
        ${isDragging ? 'opacity-50' : ''}
      `}
      onClick={onClick}
    >
      {/* Thumbnail container with overflow hidden */}
      <div
        className={`
          overflow-hidden rounded-lg
          border-2 transition-all duration-200
          ${isDragging ? 'border-blue-500 bg-blue-900/20' : 'border-gray-600 hover:border-blue-400'}
          ${isInStack ? '' : ''}
        `}
        style={{
          width: containerWidth,
          height: containerHeight,
        }}
      >
        {/* Scaled content wrapper */}
        <div
          className="bg-white dark:bg-gray-800 origin-top-left pointer-events-none"
          style={{
            width: originalWidth,
            height: originalHeight,
            transform: `scale(${scale})`,
          }}
        >
          {/* Render slide content */}
          <div className="reveal-thumbnail p-8" dangerouslySetInnerHTML={{ __html: slideHtml }} />
        </div>
      </div>

      {/* Delete button overlay. Its events (and the confirm's, which bubble
          through React from a portal) stay here: never a drag, never a click
          on the thumbnail. */}
      {showDelete && canDelete && (
        <span
          className="absolute top-1 right-1"
          onPointerDown={e => e.stopPropagation()}
          onMouseDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
          onKeyDown={e => e.stopPropagation()}
        >
          <ConfigProvider
            theme={{ algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm }}
          >
            <Popconfirm
              title="Delete this slide?"
              okText="Delete"
              okButtonProps={{ danger: true }}
              cancelText="Cancel"
              placement="bottom"
              onConfirm={() => onDelete?.()}
            >
              <button
                type="button"
                data-testid="overview-delete-slide"
                className={`
            p-1.5 rounded-md
            bg-red-600 text-white
            opacity-0 group-hover:opacity-100 focus:opacity-100
            transition-opacity duration-200
            hover:bg-red-700
          `}
                title="Delete slide"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </Popconfirm>
          </ConfigProvider>
        </span>
      )}

      {/* Slide number indicator */}
      {!small && (
        <div className="absolute bottom-1 left-1 px-1.5 py-0.5 text-xs bg-black/60 text-white rounded-sm">
          {slide.hIndex + 1}
          {slide.vIndex > 0 ? `.${slide.vIndex + 1}` : ''}
        </div>
      )}
    </div>
  );
}
