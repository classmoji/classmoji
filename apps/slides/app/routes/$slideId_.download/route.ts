/**
 * `/{slideId}/download` — the bytes of a FILE slide, served by this app.
 *
 * A RESOURCE route (no default export, no React), and it has to be one: React
 * Router parses a non-redirect `Response` returned from the loader of a route
 * that HAS a component into that route's data, so `$slideId` — which does have
 * one — can hand back a redirect and nothing else. That is fine for the
 * ordinary case, where the redirect points at the content Worker and the file
 * never touches this process. It is not enough for a classroom whose content
 * delivery is switched off, where there is no signed URL to point at and the
 * document has to be read out of GitHub and sent from here.
 *
 * So `$slideId` sends those viewers HERE, and this route answers with the
 * bytes. It is also a perfectly good direct link in its own right — which is
 * why it re-runs the whole view gate rather than trusting the hop that reached
 * it. `assertSlideAccess` is the same call the viewer makes, at the same
 * `view` tier: a draft stays invisible to students, a private slide needs
 * membership, a public one is open.
 *
 * `openSlideFile` still decides what happens, not this route: a classroom that
 * gained a delivery layer between the redirect and this request gets a second
 * 302 to the signed URL, which is correct and costs one hop nobody will notice.
 */

import getPrisma from '@classmoji/database';
import { assertSlideAccess } from '@classmoji/auth/server';
import { slideFileService } from '@classmoji/services/slides';
import { slideFileResponse } from '~/utils/slideKind';

export const loader = async ({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}) => {
  const { slideId } = params;
  if (!slideId) throw new Response('Missing slideId', { status: 400 });

  const slide = await getPrisma().slide.findUnique({
    where: { id: slideId },
    include: { classroom: { include: { git_organization: true } } },
  });

  if (!slide) {
    throw new Response('Slide not found', { status: 404 });
  }

  // The same gate, at the same tier, as the viewer this link came from. A hop
  // is not a credential.
  await assertSlideAccess({ request, slideId, slide, accessType: 'view' });

  // A deck is read at `/{slideId}`, not downloaded, and a link has no bytes at
  // all. `openSlideFile` says the same thing ('not_a_file'), but saying it here
  // keeps the 404 from depending on a refusal reason that exists for logging.
  if (slide.kind !== 'FILE') {
    return new Response('This slide has no file to download.', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  const delivery = await slideFileService.openSlideFile(slide);
  if (delivery.mode === 'unavailable') {
    console.warn(`[slides] No file to download for slide ${slideId}: ${delivery.reason}`);
  }
  return slideFileResponse(delivery);
};
