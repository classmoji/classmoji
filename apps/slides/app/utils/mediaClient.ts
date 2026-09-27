/**
 * mediaClient.ts — the deck editor's two reads about the classroom's media.
 *
 * Browser-only `fetch`es against the slides app's own routes. Both degrade
 * rather than throw: a failed lookup leaves the editor with the stored
 * reference, which is what gets saved either way.
 */

/** One row of the "choose from media" picker. */
export interface MediaPickItem {
  id: string;
  filename: string;
  sizeBytes: number;
  /** `media://{id}` — what the deck stores. */
  ref: string;
  createdAt: string;
}

/**
 * The classroom's finished videos, newest first. Throws on a failed read so the
 * picker can say so instead of showing an empty library.
 */
export async function listClassroomVideos(classroomId: string): Promise<MediaPickItem[]> {
  const params = new URLSearchParams({ classroomId, kind: 'VIDEO' });
  const response = await fetch(`/api/media/list?${params}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`media list ${response.status}`);
  const body = (await response.json()) as { items?: MediaPickItem[] };
  return Array.isArray(body.items) ? body.items : [];
}

/**
 * A URL the editor can play a media reference from, or the reference itself
 * when there is none to give (the classroom's content is not served signed, or
 * the lookup failed). The reference is always safe to put in the deck: it is
 * what a save stores.
 */
export async function playableMediaUrl(slideId: string, ref: string): Promise<string> {
  try {
    const params = new URLSearchParams({ ref });
    const response = await fetch(`/api/slides/${encodeURIComponent(slideId)}/media-url?${params}`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return ref;
    const body = (await response.json()) as { urls?: Record<string, string> };
    return body.urls?.[ref] ?? ref;
  } catch {
    return ref;
  }
}
