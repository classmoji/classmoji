/**
 * The class site keeps a visitor's place on a page: reload or Back to a long
 * page lands where they were, not at the top. The document is not hydrated
 * and its content arrives after `load`, so the browser's own restoration
 * runs against an empty article; the island does it instead, once the reader
 * has settled.
 *
 * Per tab (`sessionStorage`), keyed by the page's path. A `#fragment` in the
 * address wins (the reader scrolls to that heading). Storage that is missing
 * or refuses (private mode, a full quota, a blocked origin) just means no
 * restore. No React, no imports: the unit suite drives it with fakes.
 */

export const SCROLL_KEY_PREFIX = 'classmoji:site-scroll:';

export const scrollKey = (pathname: string) => `${SCROLL_KEY_PREFIX}${pathname}`;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** The tab's storage, or null where reading it throws. */
function sessionStore(win: Window): StorageLike | null {
  try {
    return win.sessionStorage;
  } catch {
    return null;
  }
}

export function saveScroll(storage: StorageLike | null, pathname: string, y: number): void {
  if (!storage || !Number.isFinite(y) || y < 0) return;
  try {
    storage.setItem(scrollKey(pathname), String(Math.round(y)));
  } catch {
    // Quota or a blocked store: nothing to keep.
  }
}

export function savedScroll(storage: StorageLike | null, pathname: string): number | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(scrollKey(pathname));
    if (raw === null) return null;
    const y = Number(raw);
    return Number.isFinite(y) && y > 0 ? y : null;
  } catch {
    return null;
  }
}

/**
 * Start remembering this page's scroll position (saved on `pagehide`), and
 * hand back the restore to run once the reader has settled. The restore does
 * nothing when the address names a heading, when nothing was saved, or when
 * the visitor has already scrolled the page themselves.
 */
export function keepScrollPosition(win: Window = window): () => void {
  const store = sessionStore(win);
  const path = win.location.pathname;
  try {
    // The browser would restore against the empty article and then clamp.
    win.history.scrollRestoration = 'manual';
  } catch {
    // Not settable here: the browser's own attempt stays, ours follows it.
  }
  win.addEventListener('pagehide', () => saveScroll(store, path, win.scrollY));

  let moved = false;
  const mark = () => {
    moved = true;
  };
  const events = ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const;
  for (const name of events) win.addEventListener(name, mark, { passive: true, once: true });

  return () => {
    for (const name of events) win.removeEventListener(name, mark);
    if (moved || win.location.hash) return;
    const y = savedScroll(store, path);
    if (y !== null) win.scrollTo(0, y);
  };
}
