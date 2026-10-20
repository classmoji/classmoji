import { useEffect, useRef, type RefObject } from 'react';

/**
 * Escape pressed with focus inside `ref`'s element calls `onEscape` (unless
 * something inside already handled it). A native listener on the element, so
 * the dialog container needs no React key handler of its own.
 */
export function useEscapeWithin(ref: RefObject<HTMLElement | null>, onEscape: () => void) {
  const latest = useRef(onEscape);
  latest.current = onEscape;
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      latest.current();
    };
    el.addEventListener('keydown', onKeyDown);
    return () => el.removeEventListener('keydown', onKeyDown);
  }, [ref]);
}
