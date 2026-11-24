/**
 * What each surface's host gives the island's reader beyond its data (a
 * refresh, or nothing). No React and no DOM, so the unit suite reads it.
 */
import type { ReaderPayload } from '~/utils/readerPayload.ts';

import type { ReaderIslandData } from './contract.ts';

/** What the host page gives the reader beyond its data. */
export interface ReaderIslandHost {
  /**
   * Load the page again (after an unlock, or once when a signed URL expired)
   * and resolve with the NEW payload; reject when it could not be loaded.
   * None: nothing refreshes (the reader reports an unlock as not opened, and
   * an expired image stays as it is).
   */
  onRefresh?: () => Promise<ReaderPayload>;
}

/** Where a site member's reader loads its payload again (passed through on the subdomain). */
export const SITE_READER_API_PATH = '/api/page-reader';

/**
 * Load this page's payload again for the session's viewer, from the class
 * site's `GET /api/page-reader` (members only; `private, no-store`). Rejects
 * on anything but a 200 carrying a payload, so the reader reports an unlock
 * as not opened rather than settling on stale content. The payload is a new
 * object (parsed JSON), so content and `readerSections` change in ONE update.
 */
export async function fetchSiteReaderPayload(
  data: Pick<ReaderIslandData, 'page' | 'apiBase'>,
  fetchImpl: typeof fetch = fetch
): Promise<ReaderPayload> {
  const url = `${data.apiBase ?? ''}${SITE_READER_API_PATH}?pageId=${encodeURIComponent(data.page.id)}`;
  const response = await fetchImpl(url, {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`The page could not be loaded again (${response.status}).`);
  const body = (await response.json()) as { payload?: ReaderPayload } | null;
  const payload = body?.payload;
  if (!payload || !Array.isArray(payload.content) || !payload.readerSections) {
    throw new Error('The page could not be loaded again.');
  }
  return payload;
}

/**
 * The host options for a surface.
 *   - `render` (the MCP's page render) has a view token and no session: no
 *     refresh, and the reader makes no API call.
 *   - `site`: a MEMBER's reader (their payload says signed in) loads the page
 *     again through `/api/page-reader`; a non-member's has nothing to refresh
 *     and makes no request at all (a custom domain's payload is always one).
 */
export function hostOptionsFor(data: ReaderIslandData): ReaderIslandHost {
  switch (data.surface) {
    case 'site':
      return data.payload.readerSections?.signedIn
        ? { onRefresh: () => fetchSiteReaderPayload(data) }
        : {};
    case 'render':
    default:
      return {};
  }
}
