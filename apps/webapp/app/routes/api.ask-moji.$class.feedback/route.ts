/**
 * POST /api/ask-moji/:class/feedback — rate an answer 👍 / 👎, or clear it.
 *
 * Body `{ conversationId, uiMessageId, rating: 'UP' | 'DOWN' | null }` →
 * `{ ok: true, rating, changed }`. The service accepts only a final model
 * answer in the caller's own conversation and audits each real change
 * (CREATE / UPDATE / DELETE, `data.value` = the rating). 404 for anything
 * else (one answer), 400 for a malformed body.
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

const ratingOf = (value: unknown): 'UP' | 'DOWN' | null | undefined =>
  value === 'UP' || value === 'DOWN' || value === null ? value : undefined;

export async function action(args: Route.ActionArgs) {
  return askMojiPost(args, 'feedback', async ({ access, body }) => {
    const conversationId = conversationIdOf(body);
    const uiMessageId = boundedString(body.uiMessageId, 200);
    const rating = ratingOf(body.rating);
    if (!conversationId || !uiMessageId || rating === undefined) {
      return askMojiRefuse(400, 'INVALID_MESSAGE');
    }
    const result = await ClassmojiService.askMojiSession.feedback(access, {
      conversationId,
      uiMessageId,
      rating,
      tool: 'web:ask_moji.feedback',
    });
    if (!result.ok) {
      return result.code === 'INVALID' ? askMojiRefuse(400, 'INVALID_MESSAGE') : askMojiNotFound();
    }
    return askMojiJson(200, { ok: true, rating: result.rating, changed: result.changed });
  });
}
