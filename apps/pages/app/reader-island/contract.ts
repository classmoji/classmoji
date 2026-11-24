/**
 * What a server-rendered document and the reader island agree on: the ids of
 * the mount element and of the inline JSON data block, the data's shape, and
 * how it is written into (and read back from) the HTML.
 *
 * Pure (no DOM globals at import, no React, no server code), so the route
 * that writes the document, the client mount and the unit suite all import it.
 */
import type { PageReaderPage } from '~/components/reader/PageReader.tsx';
import type { ReaderPayload, ReaderSurfaceKind } from '~/utils/readerPayload.ts';

/** The element the island mounts the reader into. */
export const READER_ISLAND_ROOT_ID = 'reader-island-root';
/** `<script type="application/json" id=…>` carrying `ReaderIslandData`. */
export const READER_ISLAND_DATA_ID = 'reader-island-data';

/**
 * Everything the island mounts the reader with, as the server decided it.
 * Generic on purpose: the MCP's page render passes `surface: 'render'`, the
 * class site passes `'site'` with its own origins.
 */
export interface ReaderIslandData {
  surface: ReaderSurfaceKind;
  page: PageReaderPage;
  payload: ReaderPayload;
  /** The page's classroom slug (in-app page hrefs), when the surface has one. */
  classroomSlug?: string | null;
  /** Prefix for the reader's API calls ('' on the pages host itself). */
  apiBase?: string;
  /** Prefix for Download links ('' on the pages host itself). */
  downloadOrigin?: string;
}

/**
 * The data as the text of a `<script type="application/json">`: JSON with
 * every `<` written as `<`, so no string in the document (a paragraph
 * holding `</script>` or `<!--<script`) can end the element or open a comment
 * the HTML parser would honour. `JSON.parse` reads it back unchanged.
 */
export function serializeIslandData(data: ReaderIslandData): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

/**
 * An origin the reader may send API calls or Download links to: `''` (this
 * host), or an absolute `https:` origin and nothing more (no path, query,
 * fragment or credentials). In dev, `http://localhost` and `*.localhost` too.
 * Anything else reads as `''`: a payload can never point the reader's
 * requests somewhere else.
 */
export function safeIslandOrigin(value: unknown, { dev = false }: { dev?: boolean } = {}): string {
  if (typeof value !== 'string' || value === '') return '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return '';
  }
  // `origin` drops path, query, fragment and credentials: equal only if there were none.
  if (url.origin !== value) return '';
  if (url.protocol === 'https:') return value;
  const localHost = url.hostname === 'localhost' || url.hostname.endsWith('.localhost');
  return dev && url.protocol === 'http:' && localHost ? value : '';
}

const isDev = (): boolean => Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);

/**
 * The data back from the element's text, or null when it is missing or
 * malformed; `apiBase` and `downloadOrigin` only when `safeIslandOrigin`
 * accepts them (otherwise `''`).
 */
export function parseIslandData(
  text: string | null | undefined,
  { dev = isDev() }: { dev?: boolean } = {}
): ReaderIslandData | null {
  if (!text) return null;
  let data: ReaderIslandData;
  try {
    data = JSON.parse(text) as ReaderIslandData;
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || !data.page || !data.payload) return null;
  if (!Array.isArray(data.payload.content)) return null;
  return {
    ...data,
    apiBase: safeIslandOrigin(data.apiBase, { dev }),
    downloadOrigin: safeIslandOrigin(data.downloadOrigin, { dev }),
  };
}
