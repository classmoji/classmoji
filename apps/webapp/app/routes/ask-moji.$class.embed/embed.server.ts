/**
 * The embed route's server half: who may frame it, and what the frame shows.
 *
 * FRAMING. `frame-ancestors` lists the pages and slides app origins and
 * nothing else (`'none'` when neither is configured). This is the only
 * webapp response that may be framed; every other page keeps its own policy.
 * No X-Frame-Options here: it would override the list in older browsers.
 *
 * THE LOADER never throws, so the header always lands: signed out → a sign-in
 * prompt; not a member, no classroom, or Ask Moji unavailable → the members'
 * line (OWNER and TEACHER also get why); otherwise the panel. `parentOrigin`
 * is the host's claim of its own origin, kept only when it is exactly one of
 * the two allowed origins.
 */
import { assertAskMojiAccess } from '@classmoji/auth/server';
import { ClassmojiService } from '@classmoji/services';
import { ASK_MOJI_AVAILABILITY_COPY, ASK_MOJI_COPY } from '@classmoji/utils/ask-moji';
import {
  allowedParentOrigins,
  checkedParentOrigin,
  frameAncestors,
  originOf,
} from '~/components/features/ask-moji/protocol';
import type { AskMojiEmbedData } from '~/components/features/ask-moji/AskMojiEmbed';
import { seesAvailabilityReason } from '~/utils/askMojiRoute.server';

type Env = Record<string, string | undefined>;

/** The pages and slides URLs; the development defaults only outside production. */
export function hostUrls(env: Env = process.env) {
  const dev = env.NODE_ENV !== 'production';
  return {
    pagesUrl: env.PAGES_URL || (dev ? 'http://localhost:7100' : null),
    slidesUrl: env.SLIDES_URL || (dev ? 'http://localhost:6500' : null),
  };
}

/** The embed's response headers. */
export function embedHeaders(env: Env = process.env): Record<string, string> {
  return {
    'Content-Security-Policy': frameAncestors(allowedParentOrigins(hostUrls(env))),
    'Cache-Control': 'no-store',
  };
}

export async function loadEmbed(
  request: Request,
  classroomSlug: string | undefined,
  env: Env = process.env
): Promise<AskMojiEmbedData> {
  const urls = hostUrls(env);
  const parentOrigin = checkedParentOrigin(
    new URL(request.url).searchParams.get('parentOrigin'),
    allowedParentOrigins(urls)
  );
  const unavailable = (staffLine: string | null = null): AskMojiEmbedData => ({
    state: 'unavailable',
    parentOrigin,
    line: ASK_MOJI_COPY.UNAVAILABLE,
    staffLine,
  });
  if (!classroomSlug) return unavailable();

  try {
    const access = await assertAskMojiAccess(request, classroomSlug, {
      resourceType: 'ASK_MOJI',
      action: 'embed',
    });
    const availability = await ClassmojiService.askMojiSession.askMojiAvailable({
      classroomId: access.classroom.id,
    });
    if (!availability.available) {
      return unavailable(
        seesAvailabilityReason(access) ? ASK_MOJI_AVAILABILITY_COPY[availability.reason] : null
      );
    }
    return {
      state: 'ready',
      parentOrigin,
      classroomSlug: access.classroom.slug,
      courseName: access.classroom.name ?? '',
      pagesUrl: urls.pagesUrl,
      slidesUrl: urls.slidesUrl,
    };
  } catch (error: unknown) {
    if (error instanceof Response && error.status === 401) {
      const origin = originOf(env.WEBAPP_URL) ?? new URL(request.url).origin;
      return { state: 'signed-out', parentOrigin, signInUrl: `${origin}/` };
    }
    if (!(error instanceof Response)) console.error('[ask-moji.embed] failed', error);
    return unavailable();
  }
}
