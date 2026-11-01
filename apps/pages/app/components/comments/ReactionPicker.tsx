import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconMoodPlus } from '@tabler/icons-react';

const EmojiMartPicker = lazy(() => import('./EmojiMartPicker.tsx'));

/** The quick row: the reactions people reach for most. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '🤔', '👀'];

/** Room kept between the popover and the window's edges, px. */
const EDGE = 8;

/**
 * The "+" beside a comment's reactions: a quick row of six, and "More" for
 * the full picker (lazy-loaded). Closes on a pick, Escape or a click outside;
 * Escape and a pick hand focus back to the "+".
 *
 * The popover is portaled to <body> with a fixed position measured from the
 * "+" and clamped to the window, so the comments panel (which clips its
 * overflow) never cuts it off: below the button when it fits, else above,
 * aligned to the button's left edge and pushed back inside the window.
 */
export function ReactionPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  const close = (refocus: boolean) => {
    setOpen(false);
    setFull(false);
    setPosition(null);
    if (refocus) buttonRef.current?.focus();
  };

  // Place (and re-place) the popover inside the window.
  const place = useCallback(() => {
    const button = buttonRef.current;
    const popover = popoverRef.current;
    if (!button || !popover) return;
    const anchor = button.getBoundingClientRect();
    const width = popover.offsetWidth;
    const height = popover.offsetHeight;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const below = anchor.bottom + 4;
    const above = anchor.top - 4 - height;
    let top = below + height <= viewportHeight - EDGE || above < EDGE ? below : above;
    top = Math.max(EDGE, Math.min(top, viewportHeight - height - EDGE));
    let left = anchor.left;
    left = Math.max(EDGE, Math.min(left, viewportWidth - width - EDGE));
    setPosition(previous =>
      previous && previous.left === left && previous.top === top ? previous : { left, top }
    );
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const popover = popoverRef.current;
    // The full picker's size changes as it loads.
    const observer = new ResizeObserver(place);
    if (popover) observer.observe(popover);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, full, place]);

  // Escape inside the popover, caught on the way DOWN: emoji-mart's search
  // box stops every keydown it sees, so it never bubbles back out.
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const popover = popoverRef.current;
    if (!open || !popover) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current(true);
    };
    popover.addEventListener('keydown', onKey, true);
    return () => popover.removeEventListener('keydown', onKey, true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
      setFull(false);
      setPosition(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const pick = (emoji: string) => {
    onPick(emoji);
    close(true);
  };

  const showFull = () => {
    setFull(true);
    // "More" goes away: hold focus in the popover until the search box takes it.
    requestAnimationFrame(() => popoverRef.current?.focus());
  };

  const dark =
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

  return (
    <div
      ref={rootRef}
      className="relative"
      // React events bubble through the portal, so this sees keys pressed in
      // the popover (and in emoji-mart's shadow root) too.
      onKeyDown={event => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          close(true);
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (open ? close(false) : setOpen(true))}
        aria-label="Add reaction"
        aria-expanded={open}
        aria-haspopup="true"
        title="Add reaction"
        className="flex h-6 items-center rounded-full px-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-neutral-800 dark:hover:text-gray-100"
      >
        <IconMoodPlus size={15} />
      </button>
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            tabIndex={-1}
            role="group"
            aria-label="Reactions"
            className="fixed z-[60] outline-none"
            style={
              position
                ? { left: position.left, top: position.top }
                : // Measured before it is shown; still focusable (no visibility: hidden).
                  { left: 0, top: 0, opacity: 0, pointerEvents: 'none' }
            }
          >
            {full ? (
              <div className="overflow-hidden rounded-xl shadow-xl">
                <Suspense
                  fallback={
                    <div className="flex h-24 w-72 items-center justify-center rounded-xl bg-white text-sm text-gray-500 ring-1 ring-stone-200 dark:bg-neutral-900 dark:text-gray-400 dark:ring-neutral-700">
                      Loading…
                    </div>
                  }
                >
                  <EmojiMartPicker dark={dark} onSelect={pick} />
                </Suspense>
              </div>
            ) : (
              <div className="flex items-center gap-0.5 rounded-full bg-white p-1 shadow-lg ring-1 ring-stone-200 dark:bg-neutral-900 dark:ring-neutral-700">
                {QUICK_REACTIONS.map((emoji, index) => (
                  <button
                    key={emoji}
                    type="button"
                    autoFocus={index === 0}
                    onClick={() => pick(emoji)}
                    aria-label={`React with ${emoji}`}
                    className="flex h-8 w-8 items-center justify-center rounded-full text-lg leading-none hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-neutral-800"
                  >
                    {emoji}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={showFull}
                  className="h-8 rounded-full px-2.5 text-xs font-medium text-gray-600 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-300 dark:hover:bg-neutral-800"
                >
                  More
                </button>
              </div>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}
