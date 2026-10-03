/**
 * GET /api/slides/:slideId/media-url?ref=media://{id}[&ref=…]
 *
 * A playable URL for a media reference the deck editor has just placed — an
 * upload that finished, or a pick from the classroom's media. The editor
 * stores `media://{id}` and cannot load it: the bytes are in R2 behind a signed
 * URL, and only the server can sign. This is the same answer the editor's own
 * read gives for the references already in the deck (`resolveDeckMedia`), for
 * one that arrived after it.
 *
 * Signed at the EDIT tier, like everything else the editor holds, and turned
 * back into the reference by `saveDeck` on the way to a commit.
 *
 * Editors only (`assertSlideAccess` edit), decks only, and `media://` refs only
 * — anything else in `ref` is dropped rather than resolved. The lookup is
 * scoped to the deck's classroom, so another classroom's id answers the
 * `/missing/` placeholder exactly as an unknown one does. A plain resource
 * route rather than an action on the deck route: a fetcher action there would
 * re-run the deck loader afterwards, for a question that changes nothing.
 */

import getPrisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';
import { isDeckSlide } from '@classmoji/services/slides';
import { assertSlideAccess } from '@classmoji/auth/server';
import { deckAccessFor, deckDeliveryContext, isMediaRef } from '~/utils/deckDelivery.server';

/** More than the editor ever asks for at once, and a cap on the lookup. */
const MAX_REFS = 20;

export const loader = async ({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}) => {
  const { slideId } = params;
  if (!slideId) return Response.json({ error: 'Missing slideId' }, { status: 400 });

  const slide = await getPrisma().slide.findUnique({
    where: { id: slideId },
    include: { classroom: { include: { git_organization: true } } },
  });
  if (!slide) return Response.json({ error: 'Slide not found' }, { status: 404 });

  await assertSlideAccess({ request, slideId, slide, accessType: 'edit' });

  if (!isDeckSlide(slide)) {
    return Response.json({ error: 'Only a deck holds media.' }, { status: 409 });
  }

  const refs = [...new Set(new URL(request.url).searchParams.getAll('ref'))]
    .filter(isMediaRef)
    .slice(0, MAX_REFS);

  const ctx = deckDeliveryContext(
    slide,
    slide.classroom?.git_organization?.login,
    slide.classroom?.content_repo,
    deckAccessFor('viewer', { canEdit: true }, slide)
  );
  // No context: this classroom's content is not served signed, so there is no
  // URL to give. The editor keeps the reference, which is what it stores.
  if (!ctx || refs.length === 0) {
    return Response.json({ urls: {} }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const { urls } = await ClassmojiService.contentDelivery.resolveDelivery(ctx, refs);
  const answer: Record<string, string> = {};
  for (const ref of refs) {
    const url = urls.get(ref);
    if (url && !isMediaRef(url)) answer[ref] = url;
  }
  return Response.json({ urls: answer }, { headers: { 'Cache-Control': 'no-store' } });
};
