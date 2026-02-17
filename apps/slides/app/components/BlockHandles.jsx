import { useState, useEffect, useCallback, useRef } from 'react';
import { useElementSelection } from './properties/ElementSelectionContext';

/**
 * BlockHandles - Renders resize/move handles around a selected sl-block
 *
 * This component creates an overlay with:
 * - 8 resize handles (corners + edges)
 * - A central move area for dragging the block position
 * - Position/size indicators during operations
 * - Code editing mode for Sandpack blocks (double-click to enter)
 *
 * Key implementation details:
 * - Screen pixels are converted to slide coordinates (960×700 space) using CSS transform scale
 * - Iframes are disabled during drag to prevent them from capturing mouse events
 * - After drag, compensates for Reveal.js slide re-centering to prevent visual "snap back"
 *
 * Note: Delete/Backspace key handling is in ElementSelectionContext.jsx
 */

const HANDLE_SIZE = 10;

// Handle positions: id, cursor, x (0-1), y (0-1)
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

export default function BlockHandles() {
  const { selectedElement, elementType, blockElement, onContentChange } = useElementSelection();
  const [bounds, setBounds] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isMoving, setIsMoving] = useState(false);
  const [currentPosition, setCurrentPosition] = useState({ left: 0, top: 0 });
  const [currentSize, setCurrentSize] = useState({ width: 0, height: 0 });
  const [isEditingCode, setIsEditingCode] = useState(false); // For Sandpack code editing mode
  const dragStateRef = useRef(null);

  // Only show handles for sl-blocks
  // For sandpack elements inside sl-blocks, use the blockElement (the sl-block wrapper)
  const isBlock = elementType === 'block' && selectedElement?.classList?.contains('sl-block');

  // For sandpack: if blockElement wasn't passed, try to find the sl-block from selectedElement
  // This handles cases where selection happens through paths that don't set blockElement
  let effectiveBlockElement = blockElement;
  if (elementType === 'sandpack' && !blockElement && selectedElement) {
    effectiveBlockElement = selectedElement.closest('.sl-block');
  }

  const isSandpackBlock = elementType === 'sandpack' && effectiveBlockElement?.classList?.contains('sl-block');
  const showHandles = isBlock || isSandpackBlock;

  // The actual element to drag/resize (prefer blockElement for sandpack)
  const targetElement = isSandpackBlock ? effectiveBlockElement : selectedElement;

  // Get Reveal.js scale factor for coordinate conversion
  // CRITICAL: Use the actual CSS transform scale, not Reveal.getScale()
  // Reveal.getScale() returns a different value (like 1.05) that doesn't match
  // the actual CSS transform applied to .slides (like 0.98)
  const getScale = useCallback(() => {
    // Extract scale from the .slides transform matrix (most reliable)
    const slides = document.querySelector('.reveal .slides');
    if (slides) {
      const transform = getComputedStyle(slides).transform;
      if (transform && transform !== 'none') {
        // matrix(scaleX, 0, 0, scaleY, tx, ty) - extract scaleX
        const values = transform.replace('matrix(', '').replace(')', '').split(',');
        const scale = parseFloat(values[0]);
        if (!isNaN(scale) && scale > 0) {
          return scale;
        }
      }
    }
    // Fallback to Reveal.js API only if CSS transform not available
    if (window.Reveal?.getScale) {
      return window.Reveal.getScale();
    }
    return 1;
  }, []);

  // Parse pixel value from style string
  const parsePixels = useCallback((value) => {
    if (!value) return 0;
    return parseInt(value, 10) || 0;
  }, []);

  // Update screen bounds from element position
  const updateBounds = useCallback(() => {
    if (!showHandles || !targetElement) {
      setBounds(null);
      return;
    }

    const rect = targetElement.getBoundingClientRect();
    setBounds({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    });

    // Also update current position/size from element styles
    setCurrentPosition({
      left: parsePixels(targetElement.style.left),
      top: parsePixels(targetElement.style.top),
    });
    setCurrentSize({
      width: parsePixels(targetElement.style.width) || rect.width / getScale(),
      height: parsePixels(targetElement.style.height) || rect.height / getScale(),
    });
  }, [showHandles, targetElement, parsePixels, getScale]);

  // Initial bounds calculation and event listeners
  useEffect(() => {
    updateBounds();

    window.addEventListener('resize', updateBounds);
    window.addEventListener('scroll', updateBounds, true);

    // Observe for slide changes
    const observer = new MutationObserver(() => {
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

  // Handle resize drag start
  const handleResizeStart = useCallback((e, handle) => {
    e.preventDefault();
    e.stopPropagation();

    if (!targetElement || !bounds) return;

    const scale = getScale();

    // Get current position and size from inline styles
    const startLeft = parsePixels(targetElement.style.left);
    const startTop = parsePixels(targetElement.style.top);
    const startWidth = parsePixels(targetElement.style.width) || bounds.width / scale;
    const startHeight = parsePixels(targetElement.style.height) || bounds.height / scale;

    // CRITICAL: Disable pointer events on iframes during drag to prevent event capture
    const iframes = targetElement.querySelectorAll('iframe');
    iframes.forEach(iframe => {
      iframe.style.pointerEvents = 'none';
    });

    dragStateRef.current = {
      type: 'resize',
      handle: handle.id,
      startX: e.clientX,
      startY: e.clientY,
      startLeft,
      startTop,
      startWidth,
      startHeight,
      disabledIframes: iframes, // Store for cleanup
    };

    setIsDragging(true);
    setCurrentSize({ width: startWidth, height: startHeight });

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [targetElement, bounds, getScale, parsePixels]);

  // Handle move drag start
  const handleMoveStart = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();

    if (!targetElement || !bounds) return;

    const startLeft = parsePixels(targetElement.style.left);
    const startTop = parsePixels(targetElement.style.top);

    // CRITICAL: Disable pointer events on iframes during drag to prevent event capture
    // Iframes can steal mousemove/mouseup events, causing drag to fail
    const iframes = targetElement.querySelectorAll('iframe');
    iframes.forEach(iframe => {
      iframe.style.pointerEvents = 'none';
    });

    dragStateRef.current = {
      type: 'move',
      startX: e.clientX,
      startY: e.clientY,
      startLeft,
      startTop,
      disabledIframes: iframes, // Store for cleanup
    };

    setIsMoving(true);
    setCurrentPosition({ left: startLeft, top: startTop });

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [targetElement, bounds, parsePixels]);

  // Handle mouse move during drag
  const handleMouseMove = useCallback((e) => {
    if (!dragStateRef.current || !targetElement) return;

    const scale = getScale();
    const state = dragStateRef.current;

    // Convert screen deltas to slide coordinate deltas
    const deltaX = (e.clientX - state.startX) / scale;
    const deltaY = (e.clientY - state.startY) / scale;

    if (state.type === 'move') {
      // Moving the block
      const newLeft = Math.round(state.startLeft + deltaX);
      const newTop = Math.round(state.startTop + deltaY);

      targetElement.style.left = `${newLeft}px`;
      targetElement.style.top = `${newTop}px`;

      setCurrentPosition({ left: newLeft, top: newTop });
    } else if (state.type === 'resize') {
      // Resizing the block
      let newWidth = state.startWidth;
      let newHeight = state.startHeight;
      let newLeft = state.startLeft;
      let newTop = state.startTop;

      const { handle } = state;

      // Calculate new dimensions based on handle
      if (handle.includes('e')) {
        newWidth = Math.max(50, state.startWidth + deltaX);
      }
      if (handle.includes('w')) {
        newWidth = Math.max(50, state.startWidth - deltaX);
        newLeft = state.startLeft + (state.startWidth - newWidth);
      }
      if (handle.includes('s')) {
        newHeight = Math.max(30, state.startHeight + deltaY);
      }
      if (handle.includes('n')) {
        newHeight = Math.max(30, state.startHeight - deltaY);
        newTop = state.startTop + (state.startHeight - newHeight);
      }

      // Apply shift for aspect ratio lock on corner handles
      if (e.shiftKey && handle.length === 2) {
        const aspectRatio = state.startWidth / state.startHeight;
        if (handle.includes('e') || handle.includes('w')) {
          newHeight = newWidth / aspectRatio;
        } else {
          newWidth = newHeight * aspectRatio;
        }
      }

      targetElement.style.width = `${Math.round(newWidth)}px`;
      targetElement.style.height = `${Math.round(newHeight)}px`;
      targetElement.style.left = `${Math.round(newLeft)}px`;
      targetElement.style.top = `${Math.round(newTop)}px`;

      setCurrentSize({ width: Math.round(newWidth), height: Math.round(newHeight) });
      setCurrentPosition({ left: Math.round(newLeft), top: Math.round(newTop) });
    }

    updateBounds();
  }, [targetElement, getScale, updateBounds]);

  // Handle mouse up - end drag
  const handleMouseUp = useCallback(() => {
    if (dragStateRef.current && targetElement) {
      // CRITICAL: Reveal.layout() recalculates the SLIDE's vertical centering (top position)
      // when content changes. This shifts ALL content within the slide, causing blocks to
      // visually "snap back" even though their inline styles are unchanged.
      // We compensate by measuring the slide's movement and adjusting the block's position.

      const savedLeft = targetElement.style.left;
      const savedTop = parsePixels(targetElement.style.top);
      const savedWidth = targetElement.style.width;
      const savedHeight = targetElement.style.height;

      // Capture the slide's vertical position BEFORE triggering layout recalculation
      const slide = targetElement.closest('section.present');
      const slideTopBefore = slide ? parsePixels(getComputedStyle(slide).top) : 0;

      // Notify parent of content change (triggers Reveal.layout() via RAF)
      onContentChange?.();

      // Wait for layout recalculation to complete using triple RAF:
      // - RAF 1: Runs alongside Reveal.layout() scheduled by onContentChange
      // - RAF 2: Runs after layout() completes
      // - RAF 3: Ensures any React re-renders have also completed
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (!targetElement) {
              updateBounds();
              return;
            }

            // Re-query slide in case DOM changed during layout
            const currentSlide = targetElement.closest('section.present');

            if (!currentSlide) {
              // Slide not found - restore values without compensation
              targetElement.style.left = savedLeft;
              targetElement.style.top = `${savedTop}px`;
              if (savedWidth) targetElement.style.width = savedWidth;
              if (savedHeight) targetElement.style.height = savedHeight;
              updateBounds();
              return;
            }

            // Calculate slide movement delta from Reveal.layout() re-centering
            const slideTopAfter = parsePixels(getComputedStyle(currentSlide).top);
            const slideDelta = slideTopAfter - slideTopBefore;

            // Compensate: if slide moved down by N pixels, move block up by N pixels
            // to maintain the same visual position
            const compensatedTop = savedTop - slideDelta;

            targetElement.style.left = savedLeft;
            targetElement.style.top = `${compensatedTop}px`;
            if (savedWidth) targetElement.style.width = savedWidth;
            if (savedHeight) targetElement.style.height = savedHeight;

            updateBounds();
          });
        });
      });
    }

    // Re-enable pointer events on iframes
    if (dragStateRef.current?.disabledIframes) {
      dragStateRef.current.disabledIframes.forEach(iframe => {
        iframe.style.pointerEvents = '';
      });
    }

    dragStateRef.current = null;
    setIsDragging(false);
    setIsMoving(false);

    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  }, [handleMouseMove, onContentChange, updateBounds, targetElement, parsePixels]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  // Handle double-click to enter edit mode
  const handleDoubleClick = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();

    if (!targetElement) return;

    // For sandpack blocks, enter code editing mode (allow clicks through to Sandpack editor)
    if (isSandpackBlock) {
      setIsEditingCode(true);
      targetElement.classList.add('editing-code');
      // CRITICAL: Disable contentEditable on the block to prevent slide's contentEditable
      // from capturing keyboard input meant for the Sandpack code editor
      targetElement.contentEditable = 'false';
      // Also disable on the sandpack-embed inside
      const sandpackEmbed = targetElement.querySelector('.sandpack-embed');
      if (sandpackEmbed) {
        sandpackEmbed.contentEditable = 'false';
      }
      return;
    }

    // Enter edit mode - make content editable
    targetElement.classList.remove('selected');
    targetElement.classList.add('editing');

    const content = targetElement.querySelector('.sl-block-content');
    if (content) {
      content.contentEditable = 'true';
      content.focus();

      // Select all content for easy editing
      const range = document.createRange();
      range.selectNodeContents(content);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }, [targetElement, isSandpackBlock]);

  // Exit code editing mode when clicking outside the Sandpack block
  useEffect(() => {
    if (!isEditingCode || !targetElement) return;

    const handleClickOutside = (e) => {
      // Check if click is inside the Sandpack block
      if (targetElement.contains(e.target)) {
        return; // Click inside, stay in edit mode
      }

      // Click outside - exit code editing mode
      setIsEditingCode(false);
      targetElement.classList.remove('editing-code');
      // Restore contentEditable to inherit from parent (the slide)
      targetElement.contentEditable = 'inherit';
      const sandpackEmbed = targetElement.querySelector('.sandpack-embed');
      if (sandpackEmbed) {
        sandpackEmbed.contentEditable = 'inherit';
      }
    };

    // Use mousedown to catch clicks before they're processed
    document.addEventListener('mousedown', handleClickOutside);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isEditingCode, targetElement]);

  // Stop keyboard events from propagating to Reveal.js when editing code
  // This prevents Reveal.js shortcuts (like "." for pause) from interfering
  useEffect(() => {
    if (!isEditingCode || !targetElement) return;

    const stopKeyboardPropagation = (e) => {
      // Allow Escape to bubble up (for exiting edit mode if needed)
      if (e.key === 'Escape') return;

      // Stop propagation to prevent Reveal.js from handling keyboard events
      // This runs in bubble phase AFTER CodeMirror has handled the event,
      // so Tab key insertion and other editor features work normally
      e.stopPropagation();
    };

    // CRITICAL: Use bubble phase (no 'true' flag) and attach to the block element
    // This allows events to reach CodeMirror first (for Tab handling, etc.)
    // then stops propagation before reaching Reveal.js
    targetElement.addEventListener('keydown', stopKeyboardPropagation);
    targetElement.addEventListener('keyup', stopKeyboardPropagation);
    targetElement.addEventListener('keypress', stopKeyboardPropagation);

    return () => {
      targetElement.removeEventListener('keydown', stopKeyboardPropagation);
      targetElement.removeEventListener('keyup', stopKeyboardPropagation);
      targetElement.removeEventListener('keypress', stopKeyboardPropagation);
    };
  }, [isEditingCode, targetElement]);

  // Reset editing state when selection changes
  useEffect(() => {
    setIsEditingCode(false);
  }, [selectedElement]);

  // Don't render if not a block or no bounds
  if (!showHandles || !bounds) {
    return null;
  }

  return (
    <div
      className={`block-resize-overlay ${isEditingCode ? 'editing-code-mode' : ''}`}
      style={{
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
        // Allow clicks through when editing Sandpack code
        pointerEvents: isEditingCode ? 'none' : 'auto',
      }}
    >
      {/* Selection border - always visible, but styled differently in edit mode */}
      <div
        className="block-resize-border"
        style={{
          borderColor: isEditingCode ? '#10b981' : undefined, // Green border when editing
          borderStyle: isEditingCode ? 'solid' : undefined,
        }}
      />

      {/* Move area (center) - for dragging position - hidden when editing code */}
      {!isEditingCode && (
        <div
          className="block-move-area"
          onMouseDown={handleMoveStart}
          onDoubleClick={handleDoubleClick}
        />
      )}

      {/* Resize handles - hidden when editing code */}
      {!isEditingCode && HANDLES.map((handle) => (
        <div
          key={handle.id}
          className={`block-resize-handle block-resize-handle-${handle.id}`}
          style={{
            cursor: handle.cursor,
            borderRadius: handle.id.length === 2 ? '2px' : '50%',
            left: handle.x * bounds.width - HANDLE_SIZE / 2,
            top: handle.y * bounds.height - HANDLE_SIZE / 2,
          }}
          onMouseDown={(e) => handleResizeStart(e, handle)}
        />
      ))}

      {/* Code editing indicator */}
      {isEditingCode && (
        <div className="block-editing-indicator">
          Editing Code • Click outside to finish
        </div>
      )}

      {/* Position indicator during move */}
      {isMoving && (
        <div className="block-position-indicator">
          X: {currentPosition.left} Y: {currentPosition.top}
        </div>
      )}

      {/* Size indicator during resize */}
      {isDragging && (
        <div className="block-size-indicator">
          {currentSize.width} × {currentSize.height}
        </div>
      )}
    </div>
  );
}
