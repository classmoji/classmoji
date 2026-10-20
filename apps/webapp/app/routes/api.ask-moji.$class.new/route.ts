/**
 * POST /api/ask-moji/:class/new — New conversation.
 *
 * Body `{ conversationId, viewAs?, browserTimeZone? }`: the conversation the
 * panel is on. Atomic across devices (the service): if another device already
 * replaced it, its replacement comes back with `created: false`. The reply is
 * the same shape as `start`'s. 400 without a conversation id.
 */
import { ClassmojiService } from '@classmoji/services';
import {
  askMojiJson,
  askMojiPost,
  askMojiRefuse,
  browserTimeZoneOf,
  conversationIdOf,
  startRefusalResponse,
  viewAsOf,
} from '~/utils/askMojiRoute.server';
import type { Route } from './+types/route';

export async function action(args: Route.ActionArgs) {
  return askMojiPost(args, 'new_conversation', async ({ access, body }) => {
    const conversationId = conversationIdOf(body);
    if (!conversationId) return askMojiRefuse(400, 'INVALID_MESSAGE');
    const result = await ClassmojiService.askMojiSession.newConversation(access, {
      conversationId,
      viewAs: viewAsOf(body),
      browserTimeZone: browserTimeZoneOf(body),
      tool: 'web:ask_moji.new',
    });
    if (!result.ok) return startRefusalResponse(result, access);
    return askMojiJson(200, result);
  });
}
