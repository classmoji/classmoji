/**
 * Where in the webapp a reader opened this page from, so the top bar's class
 * name can take them back there.
 *
 * The webapp adds `?from=<its path>` to every link into the pages app at click
 * time (usePagesFromParam). The value is reader-controlled — anyone can write a
 * pages link with any `from` — so it is accepted only when it is a page of THIS
 * classroom in one of the webapp's role trees: `/admin|teacher|assistant|student/
 * {slug}` and below. The link is then always `${WEBAPP_URL}${path}`: our own
 * origin, never a host the value names. Anything else is dropped and the class
 * name falls back to the class dashboard.
 *
 * Client-safe and pure (no server imports): the layout reads it in the browser.
 */

export const CAME_FROM_PARAM = 'from';

/** Longer than any real webapp path; a giant value is an attack, not a link. */
const MAX_LENGTH = 512;

const ROLE_TREES = ['admin', 'teacher', 'assistant', 'student'];

/** sessionStorage key: per tab, per classroom. */
export const cameFromStorageKey = (classroomSlug: string) =>
  `classmoji-pages-came-from:${classroomSlug}`;

/** The webapp path to go back to, or null when `raw` is not one we accept. */
export function cameFromPath(raw: unknown, classroomSlug: string): string | null {
  if (typeof raw !== 'string' || !classroomSlug) return null;
  if (raw.length === 0 || raw.length > MAX_LENGTH) return null;
  // Printable ASCII only: no spaces, controls, backslashes or raw non-ASCII.
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code < 0x21 || code > 0x7e || code === 0x5c) return null;
  }
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;

  const pathname = raw.split(/[?#]/, 1)[0] ?? '';
  const segments = pathname.split('/');
  // ['', role, slug, ...rest]
  if (!ROLE_TREES.includes(segments[1] ?? '')) return null;
  if (segments[2] !== classroomSlug) return null;
  // A browser resolves dot segments before following the link.
  if (segments.some(segment => /^(\.|%2e){1,2}$/i.test(segment))) return null;

  return raw;
}
