import { useRef, useEffect, useCallback } from 'react';

/**
 * Notion-style drag-to-reposition hook for header/banner images.
 *
 * Attaches mousemove/mouseup and touchmove/touchend on `document` so dragging
 * works even when the cursor leaves the container element.
 *
 * @param {Object} opts
 * @param {number} opts.position - Current position (0-100)
 * @param {(pos: number) => void} opts.onPositionChange - Called with new position during drag
 * @param {() => void} [opts.onDragEnd] - Called when drag finishes
 * @param {boolean} opts.enabled - Whether dragging is currently enabled
 * @param {React.RefObject<HTMLElement>} opts.containerRef - Ref to the banner container
 */
const useHeaderImageDrag = ({
  position,
  onPositionChange,
  onDragEnd,
  enabled,
  containerRef,
}) => {
  const draggingRef = useRef(false);
  const startYRef = useRef(0);
  const startPositionRef = useRef(position);

  // Keep startPositionRef in sync when not dragging
  useEffect(() => {
    if (!draggingRef.current) {
      startPositionRef.current = position;
    }
  }, [position]);

  const clamp = (val, min, max) => Math.min(Math.max(val, min), max);

  const handleMove = useCallback((clientY) => {
    if (!draggingRef.current || !containerRef.current) return;
    const containerHeight = containerRef.current.offsetHeight;
    if (containerHeight === 0) return;

    const deltaY = clientY - startYRef.current;
    // Drag UP (negative delta) → increase position → reveal bottom of image
    const newPosition = startPositionRef.current - (deltaY / containerHeight) * 100;
    onPositionChange(clamp(Math.round(newPosition), 0, 100));
  }, [containerRef, onPositionChange]);

  const handleEnd = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    onDragEnd?.();
  }, [onDragEnd]);

  // Attach/detach document-level listeners when enabled
  useEffect(() => {
    if (!enabled) return;

    const onMouseMove = (e) => handleMove(e.clientY);
    const onMouseUp = () => handleEnd();
    const onTouchMove = (e) => {
      e.preventDefault();
      handleMove(e.touches[0].clientY);
    };
    const onTouchEnd = () => handleEnd();

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);

    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
      // Cleanup cursor/select in case component unmounts mid-drag
      if (draggingRef.current) {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
  }, [enabled, handleMove, handleEnd]);

  const handleMouseDown = useCallback((e) => {
    if (!enabled) return;
    e.preventDefault();
    draggingRef.current = true;
    startYRef.current = e.clientY;
    startPositionRef.current = position;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  }, [enabled, position]);

  const handleTouchStart = useCallback((e) => {
    if (!enabled) return;
    draggingRef.current = true;
    startYRef.current = e.touches[0].clientY;
    startPositionRef.current = position;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  }, [enabled, position]);

  return { handleMouseDown, handleTouchStart };
};

export default useHeaderImageDrag;
