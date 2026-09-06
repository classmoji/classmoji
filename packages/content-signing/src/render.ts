/**
 * render.ts — the short-lived token that lets a HEADLESS BROWSER read one deck.
 *
 * Deck thumbnails are produced by Cloudflare Browser Run, which navigates to a
 * dedicated render route and screenshots it. That browser carries no session
 * and must never be handed one: a cookie would authorise everything the person
 * who minted it can reach, for as long as the cookie lives, on a service we do
 * not control.
 *
 * So it gets a token that authorises strictly less than any session does:
 *
 *   - ONE deck. `{classroomId, slideId}` are inside the signature, so a token
 *     minted for one deck cannot be replayed against another, or against
 *     another classroom.
 *   - ONE host. The host is inside the signature too, so a token is not
 *     portable between staging and production.
 *   - 120 SECONDS, exactly. Not a bucket and no grace — a bucketed expiry is
 *     for URLs that must be byte-identical so an edge can cache them, and this
 *     one is minted immediately before a single POST and never stored.
 *   - A DIFFERENT canonical namespace (`cm1|render|…`), so it cannot be
 *     presented to the content Worker, and a blob or theme URL cannot be
 *     presented here.
 *
 * The key is the same per-classroom derived key the content URLs use, so a
 * classroom's `content_key_version` bump retires its render tokens too.
 *
 * `{exp}.{sig}` is the whole token. It carries no key version: the verifier
 * derives with the classroom's current one, which is exactly what makes a
 * version bump retire it.
 */

import { nowSeconds } from './bucket.ts';
import {
  assertClassroomId,
  assertKeyVersion,
  assertNow,
  fromBase64Url,
  hostOf,
  isUnixSeconds,
  isUuid,
  renderCanonicalString,
  toBase64Url,
} from './canonical.ts';
import { deriveKey, signCanonical, verifyCanonical } from './derive.ts';
import type { VerifyFailure } from './types.ts';

/**
 * Exactly how long a render token lives, in seconds.
 *
 * Long enough for Browser Run to pick the job up, boot a browser, navigate and
 * paint (~6s in the ordinary case, with room for a cold start); short enough
 * that a token captured off the wire is worthless before anyone can use it.
 */
export const RENDER_TOKEN_TTL_SECONDS = 120;

/** What the deck this token is for is, and which key signs for it. */
export interface RenderTokenFields {
  /** Absolute URL of the origin that will SERVE the render route. */
  origin: string | URL;
  classroomId: string;
  slideId: string;
  keyVersion: number;
  /** Unix seconds; defaults to the wall clock. Pin it for deterministic output. */
  now?: number;
}

export type RenderVerification = { ok: true; exp: number } | { ok: false; reason: VerifyFailure };

const TOKEN_PATTERN = /^(0|[1-9][0-9]*)\.([A-Za-z0-9_-]+)$/;

function assertFields(fields: RenderTokenFields): { host: string; now: number } {
  assertClassroomId(fields.classroomId);
  if (!isUuid(fields.slideId)) {
    throw new TypeError(
      `content-signing: slideId must be a lowercase UUID (got ${fields.slideId})`
    );
  }
  assertKeyVersion(fields.keyVersion);
  const now = fields.now ?? nowSeconds();
  assertNow(now);
  return { host: hostOf(fields.origin), now };
}

/**
 * Mint a render token for one deck. `{exp}.{sig}`.
 *
 * Mint it IMMEDIATELY before the screenshot POST. The TTL is what bounds the
 * damage of a leak, and a token minted at the top of a task that then waits on
 * a queue has already spent most of it.
 */
export async function signRenderToken(master: string, fields: RenderTokenFields): Promise<string> {
  const { host, now } = assertFields(fields);
  const exp = now + RENDER_TOKEN_TTL_SECONDS;

  const canonical = renderCanonicalString({
    host,
    classroomId: fields.classroomId,
    slideId: fields.slideId,
    exp,
  });

  const key = await deriveKey(master, fields.classroomId, fields.keyVersion);
  return `${exp}.${toBase64Url(await signCanonical(key, canonical))}`;
}

/**
 * Verify a render token against the deck it claims to be for.
 *
 * The CALLER supplies `classroomId` and `slideId` — the ones it resolved from
 * its own route params and its own database read — and this checks that the
 * signature covers exactly those. Nothing is lifted out of the token but the
 * expiry, so a token cannot name a deck it was not minted for.
 *
 * Expiry is checked with no grace at all. Grace exists so an edge cache can
 * keep serving a URL a moment past its bucket; a render token is presented once
 * by one browser, so a second past `exp` is simply late.
 */
export async function verifyRenderToken(
  master: string,
  token: string,
  fields: RenderTokenFields
): Promise<RenderVerification> {
  const { host, now } = assertFields(fields);

  if (typeof token !== 'string') return { ok: false, reason: 'malformed' };
  const match = TOKEN_PATTERN.exec(token);
  if (!match) return { ok: false, reason: 'malformed' };

  const exp = Number(match[1]);
  if (!isUnixSeconds(exp)) return { ok: false, reason: 'malformed' };
  const signature = fromBase64Url(match[2]);
  if (!signature) return { ok: false, reason: 'malformed' };

  const canonical = renderCanonicalString({
    host,
    classroomId: fields.classroomId,
    slideId: fields.slideId,
    exp,
  });

  const key = await deriveKey(master, fields.classroomId, fields.keyVersion);
  if (!(await verifyCanonical(key, signature, canonical))) {
    return { ok: false, reason: 'bad-signature' };
  }

  // Signature first, expiry second: a forged token should read as forged, not
  // as merely stale, and answering "expired" to something that never verified
  // would be a free oracle for whether a guess was otherwise well formed.
  if (now > exp) return { ok: false, reason: 'expired' };

  return { ok: true, exp };
}
