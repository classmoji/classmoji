/**
 * Reveal options and window guards shared by every surface that runs Reveal
 * over deck markup (presenter, follow, viewer, editor).
 *
 * Deck markup and the frames inside it are authored content, so the deck page
 * keeps Reveal's cross-window API off: frames must not be able to drive the
 * deck, and query parameters must not switch on features the app turned off.
 */

/** Options every surface passes to `new Reveal(...)`, last, over its own. */
export const REVEAL_LOCKED_OPTIONS = {
  postMessage: false,
  postMessageEvents: false,
  previewLinks: false,
} as const;

/**
 * Reveal reads its config from the page's query string as well as from the
 * options object. These keys change what the page runs or shows, so they are
 * removed from the URL (in place, without navigation) before `initialize`.
 */
const REVEAL_QUERY_KEYS = [
  'postMessage',
  'postMessageEvents',
  'previewLinks',
  'showNotes',
  'controls',
  'help',
  'embedded',
  'autoSlide',
  'plugins',
  'dependencies',
  'markdown',
  'hash',
  'history',
];

export function stripRevealQueryConfig(win: Window = window): void {
  const url = new URL(win.location.href);
  let changed = false;
  for (const key of REVEAL_QUERY_KEYS) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (changed) win.history.replaceState(win.history.state, '', url.toString());
}

/** A Reveal API message: a JSON string whose object carries `method` or Reveal's namespace. */
export function isRevealApiMessage(data: unknown): boolean {
  if (typeof data !== 'string') return false;
  const trimmed = data.trim();
  if (!trimmed.startsWith('{')) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return false;
    const record = parsed as Record<string, unknown>;
    return typeof record.method === 'string' || record.namespace === 'reveal';
  } catch {
    return false;
  }
}

/**
 * Stops Reveal API messages before any other `message` listener sees them.
 * Installed once per page, in the capture phase; other messages (Ask Moji's
 * plain objects, preview-frame handshakes) pass through untouched.
 */
const guarded = new WeakSet<Window>();
export function installRevealMessageGuard(win: Window = window): void {
  if (guarded.has(win)) return;
  guarded.add(win);
  win.addEventListener(
    'message',
    event => {
      if (isRevealApiMessage(event.data)) event.stopImmediatePropagation();
    },
    { capture: true }
  );
}
