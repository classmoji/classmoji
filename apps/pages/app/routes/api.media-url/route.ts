import { ClassmojiService } from '~/utils/db.server.ts';
import { assertPageAccess } from '~/utils/auth.server.ts';
import { assetResolveContext } from '~/utils/assetRefs.server.ts';
import { isMediaRef } from '~/utils/mediaRefs.ts';

/**
 * The URL to show a media reference with, for the editor that just placed it.
 *
 * GET /api/media-url?pageId=<id>&ref=media://<uuid>
 * Returns: `{ displayUrl }` — the signed URL, or null when this classroom
 * cannot sign one (the editor then shows nothing rather than a dead scheme).
 *
 * The page loader resolves the references in the SAVED document. A media file
 * the editor has only just put into a block — an upload that finished, a pick
 * from media — is in neither, so without this the block would hold a
 * reference the browser cannot play until the page was saved and reloaded.
 *
 * Gated like an upload into the page (edit access on it), because it is part
 * of one, and signed on the `edit` tier the editor's other URLs use. Only a
 * `media://` reference is accepted, and the lookup is scoped to the page's
 * classroom in SQL: another classroom's id answers with the same `/missing/`
 * placeholder an unknown one does, so this cannot be used to sign anything the
 * caller's classroom does not own.
 */
export const loader = async ({ request }: { request: Request }) => {
  const url = new URL(request.url);
  const pageId = url.searchParams.get('pageId');
  const ref = url.searchParams.get('ref');
  if (!pageId || !isMediaRef(ref)) {
    return Response.json({ error: 'A page and a media reference are required.' }, { status: 400 });
  }

  const page = await ClassmojiService.page.findById(pageId, { includeClassroom: true });
  if (!page) {
    return Response.json({ error: 'Page not found' }, { status: 404 });
  }

  await assertPageAccess({ request, page, accessType: 'edit' });

  const ctx = assetResolveContext(
    page.classroom as unknown as Parameters<typeof assetResolveContext>[0],
    ClassmojiService.contentDelivery.tierFor({ canEdit: true })
  );
  if (!ctx) return Response.json({ displayUrl: null });

  try {
    const displayUrl = await ClassmojiService.contentDelivery.resolveAssetUrl(ctx, ref);
    return Response.json({ displayUrl: displayUrl === ref ? null : displayUrl });
  } catch (error) {
    console.warn('[media-url] resolve failed:', error);
    return Response.json({ displayUrl: null });
  }
};
