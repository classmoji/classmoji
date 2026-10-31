/**
 * POST /api/ask-moji/:class/start — open the panel on the caller's ongoing
 * conversation for this classroom and view, or a new one.
 *
 * Body `{ viewAs?, browserTimeZone? }` (the view from the URL's role prefix;
 * the service clamps it to the roles held). 200 → `askMojiSession.start`'s
 * result: `{ ok, conversationId, publicAccessToken, sessionReady,
 * resumeCursor, transcript, ratings, welcome, suggestions, viewAs, state,
 * created }`. A refusal → `{ ok: false, code, message, permanent }`, plus
 * `reason` / `staffMessage` for OWNER and TEACHER when Ask Moji is
 * unavailable. Gates: `askMojiPost` (utils/askMojiRoute.server).
 */
import { ClassmojiService } from '@classmoji/services';
import {
  askMojiJson,
  askMojiPost,
  browserTimeZoneOf,
  startRefusalResponse,
  viewAsOf,
} from '~/utils/askMojiRoute.server';
import type { Route } from './+types/route';

export async function action(args: Route.ActionArgs) {
  return askMojiPost(args, 'start', async ({ access, body }) => {
    const result = await ClassmojiService.askMojiSession.start(access, {
      viewAs: viewAsOf(body),
      browserTimeZone: browserTimeZoneOf(body),
      tool: 'web:ask_moji.start',
    });
    if (!result.ok) return startRefusalResponse(result, access);
    return askMojiJson(200, result);
  });
}
