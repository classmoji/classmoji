/**
 * POST /api/slides/:slideId/html-block — the files behind a deck's html blocks.
 *
 * JSON in, JSON out, one `intent` per request (shapes in
 * `~/utils/htmlBlockApi.server`):
 *   - `save`   { html, src?, rev?, fork?, blockId? } → { src, rev }
 *   - `read`   { src, rev? }                         → { src, html, rev, stale }
 *   - `delete` { src, blockId? }                     → { deleted }
 *   - `list`   { path? }                             → { path, deckFolder, entries }
 * Refusals: `{ error, code }` with 400 / 403 / 404 / 409 (`changed`: the
 * block's file moved on since `rev`) / 413.
 *
 * Editors only (`assertSlideAccess` edit), decks only; the user is the
 * session's. The services re-check the edit rule with the slide row's own
 * classroom and audit every save and delete. A plain resource route, like
 * `media-url`: an action on the deck route would re-run the deck loader.
 */

import getPrisma from '@classmoji/database';
import { assertSlideAccess } from '@classmoji/auth/server';
import {
  HtmlBlockFileError,
  MAX_HTML_BLOCK_FILE_BYTES,
  deleteHtmlBlockFile,
  isDeckSlide,
  listRepoFolder,
  readHtmlBlockSource,
  writeHtmlBlockFile,
} from '@classmoji/services/slides';
import { readLimitedBody, UploadTooLargeError } from '@classmoji/utils/upload-limit';
import { handleHtmlBlockRequest } from '~/utils/htmlBlockApi.server';

/** The JSON around 1 MB of code, with room for escaping. */
const MAX_BODY_BYTES = MAX_HTML_BLOCK_FILE_BYTES * 6 + 16 * 1024;

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export const action = async ({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const { slideId } = params;
  if (!slideId) return json({ error: 'Missing slideId' }, 400);

  const slide = await getPrisma().slide.findUnique({
    where: { id: slideId },
    include: { classroom: { include: { git_organization: true } } },
  });
  if (!slide) return json({ error: 'Slide not found' }, 404);

  const { userId } = await assertSlideAccess({ request, slideId, slide, accessType: 'edit' });
  if (!userId) return json({ error: 'Sign in to edit this deck.' }, 403);
  if (!isDeckSlide(slide)) return json({ error: 'Only a deck has html blocks.' }, 409);

  // Read only now, after the gate, and metered.
  let body: unknown;
  try {
    const bytes = request.body ? await readLimitedBody(request.body, MAX_BODY_BYTES) : null;
    body = JSON.parse(bytes ? new TextDecoder().decode(bytes) : '');
  } catch (error: unknown) {
    if (error instanceof UploadTooLargeError) {
      return json({ error: "This block's code is too large.", code: 'too-large' }, 413);
    }
    return json({ error: 'Expected a JSON body', code: 'invalid' }, 400);
  }

  const answer = await handleHtmlBlockRequest(
    { slideId: slide.id, userId, body },
    {
      write: writeHtmlBlockFile,
      read: readHtmlBlockSource,
      remove: deleteHtmlBlockFile,
      list: listRepoFolder,
      isServiceError: (error): error is HtmlBlockFileError => error instanceof HtmlBlockFileError,
    }
  );
  return json(answer.body, answer.status);
};
