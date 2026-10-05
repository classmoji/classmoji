/**
 * render/viewToken.ts — the deployment-aware half of the view token: which
 * secret signs it, and the classroom's key version. The crypto is in
 * `@classmoji/content-signing` (view.ts).
 *
 * The secret is `CONTENT_SIGNING_SECRET`. Outside production a dev stack often
 * has none set, which would make every local render a bare 403 — so in
 * development and test ONLY, a fixed dev secret stands in, exactly as the
 * collab internal secret does (`resolveCollabInternalSecret`). Production with
 * no secret signs nothing and verifies nothing, and the dev value is refused
 * there even if someone sets it.
 */

import {
  VIEW_TOKEN_TTL_SECONDS,
  signViewToken,
  verifyViewToken,
  type ViewDocKind,
  type ViewVerification,
} from '@classmoji/content-signing';

export { VIEW_TOKEN_TTL_SECONDS };
export type { ViewDocKind, ViewVerification };

/** The stand-in secret, development/test only. */
export const DEV_VIEW_SIGNING_SECRET = 'classmoji-view-render-dev-secret';

type Env = Record<string, string | undefined>;

export function viewSigningSecret(env: Env = process.env): string | null {
  const secret = env.CONTENT_SIGNING_SECRET?.trim();
  if (secret) {
    return env.NODE_ENV === 'production' && secret === DEV_VIEW_SIGNING_SECRET ? null : secret;
  }
  return env.NODE_ENV === 'development' || env.NODE_ENV === 'test' ? DEV_VIEW_SIGNING_SECRET : null;
}

export interface ViewTokenTarget {
  /** Origin that serves the render route. */
  origin: string | URL;
  classroomId: string;
  kind: ViewDocKind;
  docId: string;
  /** `at:pin` — see `viewTarget` in the contract. */
  target: string;
  keyVersion?: number | null;
}

/** Mint a view token, or null when no secret is available. */
export async function signDocViewToken(target: ViewTokenTarget): Promise<string | null> {
  const secret = viewSigningSecret();
  if (!secret) return null;
  return signViewToken(secret, { ...target, keyVersion: target.keyVersion ?? 0 });
}

/** Verify a presented token against what the ROUTE resolved. Never throws. */
export async function verifyDocViewToken(
  token: string | null | undefined,
  target: ViewTokenTarget
): Promise<ViewVerification> {
  const secret = viewSigningSecret();
  if (!secret || !token) return { ok: false, reason: 'malformed' };
  try {
    return await verifyViewToken(secret, token, { ...target, keyVersion: target.keyVersion ?? 0 });
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}
