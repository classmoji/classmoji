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
 * options object, and the query wins over both. It finds keys with this
 * pattern anywhere in `location.search` (reveal.js `getQueryHash`): any run of
 * letters and digits followed by `=`, so `?foo_postMessage=1` or a value like
 * `?a=x/postMessage=1` is read as `postMessage`.
 */
export const REVEAL_QUERY_KEY_RE = /[A-Z0-9]+?=([\w.%-]*)/gi;

/** The keys Reveal would read from `search`, in order. */
export function revealQueryKeys(search: string): string[] {
  return Array.from(search.matchAll(REVEAL_QUERY_KEY_RE), match => match[0].split('=')[0]);
}

/**
 * The app's own query parameters on pages that run Reveal (viewer/editor,
 * presenter, follow). None of them is a Reveal option.
 */
export const APP_QUERY_PARAMS: ReadonlySet<string> = new Set([
  'mode',
  'preview',
  'returnUrl',
  'notice',
  'auto_merged',
  'shareCode',
  'saved',
  'saving',
]);

/**
 * Leaves Reveal nothing to read from the query string but the app's own
 * parameters: every other parameter Reveal would read a key from is removed,
 * and what stays is written back encoded (so no value carries a key of its
 * own). The URL changes in place, without navigation, and only when Reveal
 * would read something different. Run before `initialize`.
 */
export function stripRevealQueryConfig(win: Window = window): void {
  const url = new URL(win.location.href);
  const kept = new URLSearchParams();
  for (const [name, value] of url.searchParams) {
    const pair = new URLSearchParams([[name, value]]).toString();
    if (APP_QUERY_PARAMS.has(name) || revealQueryKeys(pair).length === 0) {
      kept.append(name, value);
    }
  }
  const search = kept.toString();
  const before = revealQueryKeys(url.search).join('&');
  if (before === revealQueryKeys(search).join('&')) return;
  url.search = search;
  win.history.replaceState(win.history.state, '', url.toString());
}

/** The part of a Reveal deck {@link lockRevealAfterInit} uses. */
interface ConfigurableDeck {
  /** Reveal has it; the app's minimal `RevealApi` type does not declare it. */
  getConfig?(): Record<string, unknown>;
  configure(options: Record<string, unknown>): void;
}

/**
 * Puts {@link REVEAL_LOCKED_OPTIONS} back over the config Reveal composed
 * (options, then the query string). Call right after `initialize`. Does
 * nothing when the config already holds them (Reveal's `configure` re-syncs
 * the deck, which restarts the current slide's media and frames).
 */
export function lockRevealAfterInit(deck: ConfigurableDeck): void {
  const config = deck.getConfig?.();
  const locked = REVEAL_LOCKED_OPTIONS as Record<string, unknown>;
  if (config && Object.keys(locked).every(key => config[key] === locked[key])) return;
  deck.configure({ ...locked });
}

/**
 * A Reveal API message: a JSON string whose object carries a `method` key (of
 * any type: Reveal looks the method up by whatever it coerces to) or Reveal's
 * namespace.
 */
export function isRevealApiMessage(data: unknown): boolean {
  if (typeof data !== 'string') return false;
  const trimmed = data.trim();
  if (!trimmed.startsWith('{')) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return false;
    const record = parsed as Record<string, unknown>;
    return 'method' in record || record.namespace === 'reveal';
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

/**
 * Whether this page is framed by a page of another origin (any ancestor, not
 * just the parent). The editor refuses to run when it is.
 */
export function refuseIfFramedCrossOrigin(win: Window = window): boolean {
  let current: Window = win;
  for (let depth = 0; depth < 64; depth++) {
    let parent: Window;
    try {
      parent = current.parent;
    } catch {
      return true;
    }
    if (!parent || parent === current) return false;
    try {
      if (parent.location.origin !== win.location.origin) return true;
    } catch {
      return true;
    }
    current = parent;
  }
  return true;
}
