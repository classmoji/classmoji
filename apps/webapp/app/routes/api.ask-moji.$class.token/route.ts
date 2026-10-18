/**
 * POST /api/ask-moji/:class/token — a fresh session token for the caller's
 * active conversation: the chat transport's `accessToken` (a refresh after a
 * 401). Mints only; never starts anything.
 *
 * Body `{ conversationId }` → `{ publicAccessToken }`, or 404 (one answer for
 * missing, not yours, another scope, a quiz conversation, ended).
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
  return askMojiPost(args, 'token', async ({ access, body }) => {
    const conversationId = conversationIdOf(body);
    if (!conversationId) return askMojiRefuse(400, 'INVALID_MESSAGE');
    const minted = await ClassmojiService.askMojiSession.token(access, { conversationId });
    if (!minted) return askMojiNotFound();
    return askMojiJson(200, { publicAccessToken: minted.publicAccessToken });
  });
}
