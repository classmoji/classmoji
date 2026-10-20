/**
 * POST /api/ask-moji/:class/end — end the caller's conversation (COMPLETED,
 * its Trigger session closed, audited UPDATE when it was active). The panel
 * does not call this on close: a conversation lasts until New conversation.
 *
 * Body `{ conversationId }` → `{ ok: true, changed }`, or 404 (one answer for
 * missing and not yours).
 */
import { ClassmojiService } from '@classmoji/services';
import {
  askMojiJson,
  askMojiNotFound,
  askMojiPost,
  askMojiRefuse,
  conversationIdOf,
} from '~/utils/askMojiRoute.server';
import type { Route } from './+types/route';

export async function action(args: Route.ActionArgs) {
  return askMojiPost(args, 'end_conversation', async ({ access, body }) => {
    const conversationId = conversationIdOf(body);
    if (!conversationId) return askMojiRefuse(400, 'INVALID_MESSAGE');
    const result = await ClassmojiService.askMojiSession.end(access, {
      conversationId,
      tool: 'web:ask_moji.end',
    });
    if (!result.owned) return askMojiNotFound();
    return askMojiJson(200, { ok: true, changed: result.changed });
  });
}
