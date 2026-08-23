/**
 * navGridShared — pure helpers for the `navGrid` ("Page directory") block.
 *
 * The block stores its entries as a JSON **string** prop because BlockNote
 * block props must be primitives (string/number/boolean). Everything that
 * needs to read that prop — the editor block, the static export, and the
 * class-site server renderer — goes through `parseNavGridEntries` so the
 * shape (and the URL sanitization) is defined in exactly one place.
 *
 * Nothing here imports React or touches the DOM: it is safe to import from
 * server-only code.
 */

export type NavGridPageEntry = {
  kind: 'page';
  /** Page id (uuid) — denormalized title travels with it so render never fetches. */
  pageId: string;
  title: string;
  emoji?: string;
};

export type NavGridExternalEntry = {
  kind: 'external';
  url: string;
  label: string;
  emoji?: string;
};

/**
 * The course schedule, as a first-class entry.
 *
 * It carries no target: the schedule lives at `/schedule` on the class site
 * and nowhere else, so storing a URL would only create a way for it to be
 * wrong. Instructors used to add it as an external link to their own site,
 * which broke whenever the subdomain or the custom domain changed and could
 * not be hidden when the schedule was switched off.
 */
export type NavGridScheduleEntry = {
  kind: 'schedule';
  /** Optional override for the default label. */
  label?: string;
  emoji?: string;
};

export type NavGridEntry = NavGridPageEntry | NavGridExternalEntry | NavGridScheduleEntry;

export type NavGridColumns = 1 | 2;

export const NAV_GRID_DEFAULT_COLUMNS: NavGridColumns = 2;

/** Where the schedule lives on a class site. Never authored, never stored. */
export const NAV_GRID_SCHEDULE_PATH = '/schedule';
export const NAV_GRID_SCHEDULE_LABEL = 'Schedule';
export const NAV_GRID_SCHEDULE_EMOJI = '📅';

/** Empty serialized value — also the block prop default. */
export const NAV_GRID_EMPTY_ENTRIES = '[]';

/** Emoji fields are decorative; cap them so a paste can't smuggle a paragraph in. */
const MAX_EMOJI_CODEPOINTS = 4;

/** Protocols an external entry is allowed to link to. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Trim an emoji-ish string to a few code points (so surrogate pairs and most
 * variation selectors survive) and drop it entirely when empty.
 */
export function sanitizeNavGridEmoji(value: unknown): string | undefined {
  const raw = asString(value).trim();
  if (!raw) return undefined;
  return Array.from(raw).slice(0, MAX_EMOJI_CODEPOINTS).join('');
}

/**
 * Normalize + validate an external URL.
 *
 * - bare hosts (`example.com`, `www.foo.org/bar`) get an `https://` scheme so
 *   authors don't have to type it
 * - only http/https/mailto survive — `javascript:` and friends return null
 *
 * @returns the normalized URL, or null when it can't be made safe.
 */
export function sanitizeNavGridUrl(value: unknown): string | null {
  const raw = asString(value).trim();
  if (!raw) return null;

  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) ? raw : `https://${raw}`;

  try {
    const parsed = new URL(candidate);
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function parseEntry(value: unknown): NavGridEntry | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;

  // `page_id` is accepted on the way IN (the class-sites plan doc uses
  // snake_case); `pageId` is always what we write back out.
  if (raw.kind === 'page') {
    const pageId = asString(raw.pageId) || asString(raw.page_id);
    if (!pageId) return null;
    const entry: NavGridPageEntry = {
      kind: 'page',
      pageId,
      title: asString(raw.title) || asString(raw.pageTitle) || asString(raw.label),
    };
    const emoji = sanitizeNavGridEmoji(raw.emoji);
    if (emoji) entry.emoji = emoji;
    return entry;
  }

  if (raw.kind === 'external') {
    const url = sanitizeNavGridUrl(raw.url);
    if (!url) return null;
    const entry: NavGridExternalEntry = {
      kind: 'external',
      url,
      label: asString(raw.label) || asString(raw.title),
    };
    const emoji = sanitizeNavGridEmoji(raw.emoji);
    if (emoji) entry.emoji = emoji;
    return entry;
  }

  // Nothing is required: an entry that says only `{"kind":"schedule"}` is a
  // complete one, because the target is a property of the site rather than of
  // the entry. Both optional fields are omitted rather than defaulted when
  // empty, so a round-trip does not invent an authored label the instructor
  // never typed — the defaults live at render time.
  if (raw.kind === 'schedule') {
    const entry: NavGridScheduleEntry = { kind: 'schedule' };
    const label = (asString(raw.label) || asString(raw.title)).trim();
    if (label) entry.label = label;
    const emoji = sanitizeNavGridEmoji(raw.emoji);
    if (emoji) entry.emoji = emoji;
    return entry;
  }

  return null;
}

/**
 * Parse the `entries` prop. Never throws: malformed JSON, a non-array payload,
 * or individual bad entries all degrade to "fewer entries" (worst case `[]`,
 * which the editor renders as its empty state).
 *
 * Accepts an already-parsed array too, so callers that hydrate the prop
 * themselves don't have to re-stringify it.
 */
export function parseNavGridEntries(value: unknown): NavGridEntry[] {
  let source: unknown = value;

  if (typeof source === 'string') {
    const trimmed = source.trim();
    if (!trimmed) return [];
    try {
      source = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(source)) return [];

  const entries: NavGridEntry[] = [];
  for (const item of source) {
    const entry = parseEntry(item);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Serialize entries back into the string prop (round-trips `parseNavGridEntries`). */
export function serializeNavGridEntries(entries: NavGridEntry[]): string {
  return JSON.stringify(parseNavGridEntries(entries));
}

/** Coerce the `columns` prop to a supported value. */
export function normalizeNavGridColumns(value: unknown): NavGridColumns {
  const n = typeof value === 'number' ? value : Number(value);
  return n === 1 ? 1 : NAV_GRID_DEFAULT_COLUMNS;
}

/** Text shown for an entry, with sensible fallbacks for un-labelled links. */
export function navGridEntryLabel(entry: NavGridEntry): string {
  if (entry.kind === 'page') return entry.title || 'Untitled';
  if (entry.kind === 'schedule') return entry.label || NAV_GRID_SCHEDULE_LABEL;
  if (entry.label) return entry.label;
  try {
    const parsed = new URL(entry.url);
    return parsed.protocol === 'mailto:' ? parsed.pathname : parsed.hostname.replace(/^www\./, '');
  } catch {
    return entry.url;
  }
}

/**
 * The emoji to draw for an entry: the authored one, or the schedule's default.
 *
 * Only the schedule has a default, and it is applied here rather than stored,
 * so an instructor who clears the emoji gets the calendar back instead of a
 * blank slot — and so the default can change without rewriting saved content.
 */
export function navGridEntryEmoji(entry: NavGridEntry): string {
  if (entry.emoji) return entry.emoji;
  return entry.kind === 'schedule' ? NAV_GRID_SCHEDULE_EMOJI : '';
}

/**
 * Is the schedule already in this directory?
 *
 * One per grid: two tiles pointing at the same single page is a mistake with
 * no upside, and the editor disables the button rather than letting it happen.
 */
export function hasNavGridScheduleEntry(entries: NavGridEntry[]): boolean {
  return entries.some(entry => entry.kind === 'schedule');
}

/** Move an entry within the list. Returns a new array (no mutation). */
export function moveNavGridEntry(
  entries: NavGridEntry[],
  from: number,
  to: number
): NavGridEntry[] {
  if (from === to || from < 0 || to < 0 || from >= entries.length || to >= entries.length) {
    return entries;
  }
  const next = [...entries];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
