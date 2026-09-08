/**
 * deckRenderToken.service.ts — the deployment-aware half of the render token.
 *
 * `@classmoji/content-signing` holds the crypto and knows nothing about this
 * deployment: it is handed a master secret and told which deck. This module is
 * the half that reads `CONTENT_SIGNING_SECRET` and the classroom's key version,
 * and it lives here rather than in the two callers because neither of them can
 * import content-signing directly — the thumbnail task is in
 * `@classmoji/tasks` and the render route is in the slides app, and both reach
 * signing only through this package.
 *
 * Deliberately NOT gated on `content_delivery_enabled`. That switch decides
 * whether a classroom's ASSETS are served as signed Worker URLs; a thumbnail is
 * rendered for every classroom, and the token is how the render route knows the
 * request is ours no matter which delivery path the deck's images take.
 */

import {
  RENDER_TOKEN_TTL_SECONDS,
  signRenderToken,
  verifyRenderToken,
  type RenderVerification,
} from '@classmoji/content-signing';

export { RENDER_TOKEN_TTL_SECONDS };
export type { RenderVerification };

/** Which deck a token is (or claims to be) for. */
export interface DeckRenderTokenTarget {
  /** Absolute URL of the origin that serves the render route. */
  origin: string | URL;
  classroomId: string;
  slideId: string;
  /** The classroom's `content_key_version`; a bump retires its render tokens. */
  keyVersion?: number | null;
}

function master(): string | null {
  return process.env.CONTENT_SIGNING_SECRET || null;
}

/**
 * Mint a token for one deck's thumbnail render, or null when unconfigured.
 *
 * Mint it immediately before the screenshot request — the 120s TTL is what
 * bounds a leak, and a token that waits in a queue has already spent it.
 */
export async function signDeckRenderToken(target: DeckRenderTokenTarget): Promise<string | null> {
  const secret = master();
  if (!secret) return null;
  return signRenderToken(secret, {
    origin: target.origin,
    classroomId: target.classroomId,
    slideId: target.slideId,
    keyVersion: target.keyVersion ?? 0,
  });
}

/**
 * Check a presented token against the deck the caller actually resolved.
 *
 * `classroomId` and `slideId` come from the ROUTE's own database read, never
 * from the token, so a token cannot name a deck it was not minted for. A
 * deployment with no signing secret verifies nothing: every token is refused,
 * which is the right answer for a route whose only credential is the token.
 */
export async function verifyDeckRenderToken(
  token: string | null | undefined,
  target: DeckRenderTokenTarget
): Promise<RenderVerification> {
  const secret = master();
  if (!secret || !token) return { ok: false, reason: 'malformed' };
  try {
    return await verifyRenderToken(secret, token, {
      origin: target.origin,
      classroomId: target.classroomId,
      slideId: target.slideId,
      keyVersion: target.keyVersion ?? 0,
    });
  } catch {
    // A non-UUID id or an unparseable origin throws rather than returning; for
    // a route whose whole job is to refuse, that is a refusal, not a 500.
    return { ok: false, reason: 'malformed' };
  }
}
