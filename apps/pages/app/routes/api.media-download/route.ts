import { redirect } from 'react-router';

import { ClassmojiService } from '~/utils/db.server.ts';
import { assertPageAccess } from '~/utils/auth.server.ts';
import { parseMediaRef } from '~/utils/mediaRefs.ts';
import { downloadsAsStudent } from '~/utils/mediaDownloads.server.ts';

/**
 * A media file's download, minted when the reader clicks.
 *
 * GET /api/media-download?pageId=<id>&ref=media://<uuid>
 * Answers: a 302 to a ten-minute `download`-tier URL (`Content-Disposition:
 * attachment`), or 404.
 *
 * Minted on click rather than printed into the page: a download URL is a
 * short-lived, unauthenticated handle to the file, and one baked into HTML is
 * dead by the time a reader who left the tab open gets to it. A redirect
 * rather than JSON because the class site ships no JavaScript — its button is
 * a plain link to this route on the canonical pages host, which the shared
 * session cookie authenticates.
 *
 * Who: a signed-in MEMBER of the page's classroom who can view the page
 * (`assertPageAccess`, which also keeps drafts to the teaching team). A
 * reader of a public page who is not a member gets nothing. What: a READY
 * media object of the page's own classroom (the lookup is scoped in SQL, so
 * another classroom's id is simply absent), under `mediaDownloadUrl`'s rule —
 * a video only when its uploader allowed downloads, unless the member is on
 * the teaching team. Every refusal is the same 404, so this cannot be used to
 * learn which ids exist.
 */
export const loader = async ({ request }: { request: Request }) => {
  const url = new URL(request.url);
  const pageId = url.searchParams.get('pageId');
  const ref = url.searchParams.get('ref');
  const mediaId = parseMediaRef(ref);
  if (!pageId || !mediaId) return notFound();

  const page = await ClassmojiService.page.findById(pageId, { includeClassroom: true });
  if (!page) return notFound();

  // Its 403 for a page this reader cannot view becomes the same 404 as
  // everything else here.
  let access;
  try {
    access = await assertPageAccess({
      request,
      page: page as unknown as Parameters<typeof assertPageAccess>[0]['page'],
      accessType: 'view',
    });
  } catch (thrown) {
    if (thrown instanceof Response) return notFound();
    throw thrown;
  }
  if (!access.membership) return notFound();

  const records = await ClassmojiService.media.lookupReadyMedia(page.classroom_id, [mediaId]);
  const record = records.get(mediaId);
  if (!record) return notFound();

  const downloadUrl = await ClassmojiService.contentDelivery.mediaDownloadUrl({
    classroom: page.classroom as unknown as Parameters<
      typeof ClassmojiService.contentDelivery.mediaDownloadUrl
    >[0]['classroom'],
    record,
    forStudent: downloadsAsStudent(access.membership.role),
  });
  if (!downloadUrl) return notFound();

  return redirect(downloadUrl, { headers: { 'Cache-Control': 'no-store' } });
};

function notFound(): Response {
  return new Response("This file isn't available to download.", {
    status: 404,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
