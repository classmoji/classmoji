/**
 * POST /api/ask-moji/:class/ensure-session — create the conversation's
 * Trigger session (booting its first run): the chat transport's
 * `startSession`, reached on composer focus (`transport.preload`) or the
 * first send.
 *
 * Body `{ conversationId }` → `{ publicAccessToken }`. 404 (one answer) when
 * it is not the caller's active Ask Moji conversation under this request's
 * scope. Refused while Ask Moji is unavailable, so a lapsed classroom boots
 * no run.
 *
 * NOT AUDITED, deliberately. The service records the new Trigger session id
 * on the caller's own conversation (`askMojiChat.recordTriggerSession`):
 * bookkeeping on a row the caller already owns, which changes nothing they or
 * anyone else can see, and no user action other than typing. The data-changing
 * actions around it are audited where they happen: the conversation's create
 * (`start` / `new`), its end, and every rating.
 */
import { ClassmojiService } from '@classmoji/services';
import {
  askMojiJson,
  askMojiNotFound,
  askMojiPost,
  askMojiRefuse,
  conversationIdOf,
  startRefusalResponse,
} from '~/utils/askMojiRoute.server';
import type { Route } from './+types/route';

export async function action(args: Route.ActionArgs) {
  return askMojiPost(args, 'ensure_session', async ({ access, body }) => {
    const conversationId = conversationIdOf(body);
    if (!conversationId) return askMojiRefuse(400, 'INVALID_MESSAGE');
    const availability = await ClassmojiService.askMojiSession.askMojiAvailable({
      classroomId: access.classroom.id,
    });
    if (!availability.available) {
      return startRefusalResponse(
        {
          ok: false,
          code: availability.reason === 'NOT_ENABLED' ? 'NOT_ENABLED' : 'UNAVAILABLE',
          reason: availability.reason,
        },
        access
      );
    }
    const session = await ClassmojiService.askMojiSession.ensureSession(access, {
      conversationId,
    });
    if (!session) return askMojiNotFound();
    return askMojiJson(200, { publicAccessToken: session.publicAccessToken });
  });
}
