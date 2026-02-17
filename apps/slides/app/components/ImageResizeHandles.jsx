import { useState, useEffect, useCallback, useRef } from 'react';
import { useElementSelection } from './properties/ElementSelectionContext';

/**
 * ImageResizeHandles - Renders resize handles around a selected image
 *
 * This component creates an overlay with draggable handles at the corners
 * and edges of the selected image. Dragging a handle resizes the image.
 *
 * Handle positions:
 * - Corners: nw, ne, sw, se (resize from corner, maintains aspect ratio with Shift)
 * - Edges: n, s, e, w (resize from edge, single dimension)
 */

// Handle size in pixels
const HANDLE_SIZE = 10;

// Handle positions and their cursor styles
const HANDLES = [
  { id: 'nw', cursor: 'nwse-resize', x: 0, y: 0 },
  { id: 'n', cursor: 'ns-resize', x: 0.5, y: 0 },
  { id: 'ne', cursor: 'nesw-resize', x: 1, y: 0 },
  { id: 'e', cursor: 'ew-resize', x: 1, y: 0.5 },
  { id: 'se', cursor: 'nwse-resize', x: 1, y: 1 },
  { id: 's', cursor: 'ns-resize', x: 0.5, y: 1 },
  { id: 'sw', cursor: 'nesw-resize', x: 0, y: 1 },
  { id: 'w', cursor: 'ew-resize', x: 0, y: 0.5 },
];

export default function ImageResizeHandles() {
  const { selectedElement, elementType, onContentChange } = useElementSelection();
  const [bounds, setBounds] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragStateRef = useRef(null);

  // Only show handles for images
  const isImage = elementType === 'image' && selectedElement?.tagName === 'IMG';

  // Update bounds when selected element changes or window resizes
  const updateBounds = useCallback(() => {
    if (!isImage || !selectedElement) {
      setBounds(null);
      return;
    }

    const rect = selectedElement.getBoundingClientRect();
    setBounds({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    });
  }, [isImage, selectedElement]);

  // Initial bounds calculation and event listeners
  useEffect(() => {
    updateBounds();

    // Update on window resize or scroll
    window.addEventListener('resize', updateBounds);
    window.addEventListener('scroll', updateBounds, true);

    // Also observe for slide changes (Reveal.js navigation)
    const observer = new MutationObserver(() => {
      // Debounce updates
      requestAnimationFrame(updateBounds);
    });

    const revealContainer = document.querySelector('.reveal');
    if (revealContainer) {
      observer.observe(revealContainer, {
        attributes: true,
        attributeFilter: ['class'],
        subtree: true,
      });
    }

    return () => {
      window.removeEventListener('resize', updateBounds);
      window.removeEventListener('scroll', updateBounds, true);
      observer.disconnect();
    };
  }, [updateBounds]);

  // Handle mouse down on a resize handle
  const handleMouseDown = useCallback((e, handle) => {
    e.preventDefault();
    e.stopPropagation();

    if (!selectedElement || !bounds) return;

    // Get the current dimensions
    const rect = selectedElement.getBoundingClientRect();
    const computedStyle = window.getComputedStyle(selectedElement);

    // Get natural size for aspect ratio calculations
    const naturalWidth = selectedElement.naturalWidth || rect.width;
    const naturalHeight = selectedElement.naturalHeight || rect.height;
    const aspectRatio = naturalWidth / naturalHeight;

    // Store initial state for dragging
    dragStateRef.current = {
      handle: handle.id,
      startX: e.clientX,
      startY: e.clientY,
      startWidth: rect.width,
      startHeight: rect.height,
      aspectRatio,
      // Get the parent element's bounds to calculate relative positioning
      parentRect: selectedElement.parentElement?.getBoundingClientRect(),
    };

    setIsDragging(true);

    // Add document-level listeners for dragging
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [selectedElement, bounds]);

  // Handle mouse move during drag
  const handleMouseMove = useCallback((e) => {
    if (!dragStateRef.current || !selectedElement) return;

    const { handle, startX, startY, startWidth, startHeight, aspectRatio } = dragStateRef.current;

    // CRITICAL: Get Reveal.js scale factor to convert screen pixels to slide coordinates
    // Without this, dragging feels "floaty" - moving too fast or slow depending on zoom
    const scale = window.Reveal?.getScale() || 1;

    // Convert screen pixel deltas to slide coordinate deltas
    const deltaX = (e.clientX - startX) / scale;
    const deltaY = (e.clientY - startY) / scale;

    let newWidth = startWidth;
    let newHeight = startHeight;

    // Calculate new dimensions based on which handle is being dragged
    switch (handle) {
      case 'e':
        newWidth = Math.max(50, startWidth + deltaX);
        break;
      case 'w':
        newWidth = Math.max(50, startWidth - deltaX);
        break;
      case 's':
        newHeight = Math.max(50, startHeight + deltaY);
        break;
      case 'n':
        newHeight = Math.max(50, startHeight - deltaY);
        break;
      case 'se':
        newWidth = Math.max(50, startWidth + deltaX);
        newHeight = Math.max(50, startHeight + deltaY);
        // Maintain aspect ratio if shift is held
        if (e.shiftKey) {
          newHeight = newWidth / aspectRatio;
        }
        break;
      case 'sw':
        newWidth = Math.max(50, startWidth - deltaX);
        newHeight = Math.max(50, startHeight + deltaY);
        if (e.shiftKey) {
          newHeight = newWidth / aspectRatio;
        }
        break;
      case 'ne':
        newWidth = Math.max(50, startWidth + deltaX);
        newHeight = Math.max(50, startHeight - deltaY);
        if (e.shiftKey) {
          newHeight = newWidth / aspectRatio;
        }
        break;
      case 'nw':
        newWidth = Math.max(50, startWidth - deltaX);
        newHeight = Math.max(50, startHeight - deltaY);
        if (e.shiftKey) {
          newHeight = newWidth / aspectRatio;
        }
        break;
    }

    // Apply the new dimensions directly to the image
    selectedElement.style.width = `${Math.round(newWidth)}px`;
    selectedElement.style.height = `${Math.round(newHeight)}px`;

    // Update bounds for visual feedback
    updateBounds();
  }, [selectedElement, updateBounds]);

  // Handle mouse up - end drag
  const handleMouseUp = useCallback(() => {
    if (dragStateRef.current) {
      // Notify that content changed
      onContentChange?.();
    }

    dragStateRef.current = null;
    setIsDragging(false);

    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  }, [handleMouseMove, onContentChange]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  // Don't render if not an image or no bounds
  if (!isImage || !bounds) {
    return null;
  }

  return (
    <div
      className="image-resize-overlay"
      style={{
        position: 'fixed',
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
        pointerEvents: 'none',
        zIndex: 1000,
      }}
    >
      {/* Selection border */}
      <div
        className="image-resize-border"
        style={{
          position: 'absolute',
          inset: 0,
          border: '2px solid #3b82f6',
          borderRadius: '2px',
          pointerEvents: 'none',
        }}
      />

      {/* Resize handles */}
      {HANDLES.map((handle) => (
        <div
          key={handle.id}
          className={`image-resize-handle image-resize-handle-${handle.id}`}
          style={{
            position: 'absolute',
            width: HANDLE_SIZE,
            height: HANDLE_SIZE,
            backgroundColor: '#ffffff',
            border: '2px solid #3b82f6',
            borderRadius: handle.id.length === 2 ? '2px' : '50%', // Corners square, edges round
            cursor: handle.cursor,
            pointerEvents: 'auto',
            // Position handle at the correct location
            left: handle.x * bounds.width - HANDLE_SIZE / 2,
            top: handle.y * bounds.height - HANDLE_SIZE / 2,
            // Add shadow for visibility
            boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
          }}
          onMouseDown={(e) => handleMouseDown(e, handle)}
        />
      ))}

      {/* Size indicator during drag */}
      {isDragging && (
        <div
          className="image-resize-size-indicator"
          style={{
            position: 'absolute',
            bottom: -24,
            left: '50%',
            transform: 'translateX(-50%)',
            backgroundColor: 'rgba(0,0,0,0.75)',
            color: 'white',
            padding: '2px 8px',
            borderRadius: '4px',
            fontSize: '11px',
            fontFamily: 'monospace',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
          }}
        >
          {Math.round(bounds.width)} × {Math.round(bounds.height)}
        </div>
      )}
    </div>
  );
}
