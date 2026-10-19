/**
 * POST /api/ask-moji/:class/state — the open panel's poll, and the check
 * right before each send. Never starts anything; reading one's own
 * conversation is not audited.
 *
 * Body `{ conversationId, knownLastMessageId? }` → `{ status, conversationId,
 * lastMessageId, inFlight, resumeCursor, transcript? }` (the transcript only
 * when the client's `knownLastMessageId` is out of date), or 404 (one answer
 * for missing and not yours).
 */
import { ClassmojiService } from '@classmoji/services';
import {
  askMojiJson,
  askMojiNotFound,
  askMojiPost,
  askMojiRefuse,
  boundedString,
  conversationIdOf,
} from '~/utils/askMojiRoute.server';
import type { Route } from './+types/route';

export async function action(args: Route.ActionArgs) {
  return askMojiPost(args, 'state', async ({ access, body }) => {
    const conversationId = conversationIdOf(body);
    if (!conversationId) return askMojiRefuse(400, 'INVALID_MESSAGE');
    const state = await ClassmojiService.askMojiSession.state(access, {
      conversationId,
      knownLastMessageId: boundedString(body.knownLastMessageId, 200),
    });
    if (!state) return askMojiNotFound();
    return askMojiJson(200, state);
  });
}
