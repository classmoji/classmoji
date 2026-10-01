/**
 * The signed URL for a media reference the editor has just placed, or null.
 *
 * Asks `/api/media-url` (see that route for why it exists). Never throws: a
 * reference with no display URL still saves correctly — it is only the preview
 * in this session that goes without — so a failure here must not fail the
 * upload or the pick that led to it.
 */
export async function fetchMediaDisplayUrl(pageId: string, ref: string): Promise<string | null> {
  try {
    const query = new URLSearchParams({ pageId, ref });
    const response = await fetch(`/api/media-url?${query}`);
    if (!response.ok) return null;
    const body = (await response.json()) as { displayUrl?: unknown };
    return typeof body.displayUrl === 'string' && body.displayUrl ? body.displayUrl : null;
  } catch {
    return null;
  }
}
