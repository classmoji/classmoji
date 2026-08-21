/**
 * Signed "sign me in and send me back" tokens for public course sites.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * A course site lives on its own host ({subdomain}.classmoji.io) while the
 * session cookie and the whole OAuth dance live on the webapp host. The obvious
 * shortcut — adding every tenant subdomain to betterAuth's `trustedOrigins` —
 * is the one thing we must not do: that list feeds the cookie-authenticated
 * CSRF origin check, so trusting tenant hosts would let any course site drive
 * authenticated requests against the app.
 *
 * Instead sign-in round-trips through the webapp ORIGIN, carrying a token that
 * proves only one thing: "this sign-in intent originated from a real course
 * site page, moments ago". It is NOT a credential and NOT an authorization — it
 * grants nothing, it just names a safe place to come back to. The webapp
 * re-reads the site row from the database before honouring it, so a token for a
 * site that has since been disabled (or deleted) is worthless.
 *
 * ── Shape ────────────────────────────────────────────────────────────────────
 *   base64url(json({classroomId, path, exp})) "." base64url(hmac-sha256)
 *
 * The MAC is domain-separated (TOKEN_DOMAIN) so a signature minted here can
 * never be replayed as some other artifact signed with the same
 * BETTER_AUTH_SECRET, and vice versa.
 *
 * `path` is validated on BOTH ends — at mint and at verify — because the two
 * ends fail differently: verify-side validation is what stops a token from
 * becoming an open redirect, mint-side validation is what stops us shipping a
 * link that will simply be refused on arrival.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { AUTH_SECRET } from './secret.ts';

/** HMAC domain separator. Bump the suffix if the payload shape ever changes. */
const TOKEN_DOMAIN = 'classmoji-site-return-v1';

/** Tokens are minted per click, not per page render. Five minutes is generous. */
export const SITE_RETURN_TOKEN_TTL_MS = 5 * 60 * 1000;

/** Longest return path a token may carry. */
export const SITE_RETURN_MAX_PATH_LENGTH = 512;

/** Refuse absurd input before doing any work. Real tokens are ~150 bytes. */
const MAX_TOKEN_LENGTH = 4096;

/** Ids are uuids; the bound is a sanity limit, not a format check. */
const MAX_CLASSROOM_ID_LENGTH = 128;

/** Strict base64url alphabet — Buffer.from(_, 'base64url') is far too lenient. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const CODE_SPACE = 0x20;
const CODE_BACKSLASH = 0x5c;
const CODE_DEL = 0x7f;

export interface SiteReturnPayload {
  /** The classroom whose site the visitor came from. Re-read at verify time. */
  classroomId: string;
  /** Where to drop them on that site afterwards, e.g. `/syllabus`. */
  path: string;
}

interface SignedSiteReturnPayload extends SiteReturnPayload {
  /** Absolute expiry, epoch milliseconds. */
  exp: number;
}

/**
 * Any C0 control character, DEL, or a backslash.
 *
 * Controls are a response-splitting primitive once the value reaches a
 * `Location` header. Backslashes are rejected wholesale because a browser
 * normalizes them to forward slashes inside a URL's authority, so a check
 * written against forward slashes alone can be walked straight past.
 *
 * A charCode scan rather than a regex: the character class would need control
 * escapes, which are invisible in a diff and trip `no-control-regex`.
 */
function hasUnsafeCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < CODE_SPACE || code === CODE_DEL || code === CODE_BACKSLASH) return true;
  }
  return false;
}

/**
 * Is this a same-origin path we are willing to send a browser to?
 *
 * Rejects, in order of how they bite:
 *  - protocol-relative URLs: two leading slashes, or a slash followed by a
 *    backslash. Browsers read both as "same scheme, THAT host".
 *  - backslashes and control characters anywhere (see hasUnsafeCharacters).
 *  - anything not starting with a slash — absolute URLs (https://…), scheme
 *    URLs (javascript:…), and bare relative paths whose base we cannot predict.
 *
 * Deliberately NOT a URL parse: this runs on attacker-controlled input and
 * `new URL()` normalizes away exactly the differences that matter.
 */
export function isSafeRelativePath(
  path: unknown,
  maxLength: number = SITE_RETURN_MAX_PATH_LENGTH
): path is string {
  if (typeof path !== 'string') return false;
  if (path.length === 0 || path.length > maxLength) return false;
  if (path.charCodeAt(0) !== 0x2f) return false;
  if (path.charCodeAt(1) === 0x2f) return false;
  if (hasUnsafeCharacters(path)) return false;
  return true;
}

function computeMac(payloadB64: string): Buffer {
  return createHmac('sha256', AUTH_SECRET).update(`${TOKEN_DOMAIN}.${payloadB64}`).digest();
}

/**
 * Mint a return token for {classroomId, path}, valid for five minutes.
 *
 * THROWS on an invalid path or classroom id rather than silently rewriting it:
 * a token quietly pointing somewhere other than where the visitor clicked is
 * worse than a loud failure. Site code that derives a path from a raw request
 * URL should guard with `isSafeRelativePath` first and fall back to '/'.
 */
export function signSiteReturnToken(payload: SiteReturnPayload): string {
  const classroomId = payload?.classroomId;
  const path = payload?.path;

  if (
    typeof classroomId !== 'string' ||
    classroomId.length === 0 ||
    classroomId.length > MAX_CLASSROOM_ID_LENGTH
  ) {
    throw new Error('[signSiteReturnToken] classroomId must be a non-empty id string.');
  }
  if (!isSafeRelativePath(path)) {
    throw new Error(
      '[signSiteReturnToken] path must be a relative path starting with a single slash ' +
        `and at most ${SITE_RETURN_MAX_PATH_LENGTH} characters. Guard with isSafeRelativePath().`
    );
  }

  const body: SignedSiteReturnPayload = {
    classroomId,
    path,
    exp: Date.now() + SITE_RETURN_TOKEN_TTL_MS,
  };

  const payloadB64 = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  return `${payloadB64}.${computeMac(payloadB64).toString('base64url')}`;
}

/**
 * Verify a token and return its payload, or `null` for every failure mode
 * (tampered, expired, malformed, wrong shape). One undifferentiated `null` on
 * purpose: the caller has exactly one thing to say to the visitor, and telling
 * "bad signature" apart from "expired" tells a prober which knob to turn.
 *
 * Verifying does NOT authorize anything — it only proves the payload is one we
 * minted and that it is still fresh. The caller must still look the site up.
 */
export function verifySiteReturnToken(token: unknown): SiteReturnPayload | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return null;
  }

  const separator = token.indexOf('.');
  // Exactly one separator, with content on both sides of it.
  if (separator <= 0 || separator !== token.lastIndexOf('.') || separator === token.length - 1) {
    return null;
  }

  const payloadB64 = token.slice(0, separator);
  const macB64 = token.slice(separator + 1);
  if (!BASE64URL.test(payloadB64) || !BASE64URL.test(macB64)) return null;

  const provided = Buffer.from(macB64, 'base64url');
  const expected = computeMac(payloadB64);
  // timingSafeEqual throws on a length mismatch, so the length check has to come
  // first. It leaks only the MAC length, which is a constant of the scheme.
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const { classroomId, path, exp } = parsed as Record<string, unknown>;

  if (typeof exp !== 'number' || !Number.isFinite(exp) || Date.now() >= exp) return null;
  if (
    typeof classroomId !== 'string' ||
    classroomId.length === 0 ||
    classroomId.length > MAX_CLASSROOM_ID_LENGTH
  ) {
    return null;
  }
  // Re-validated even though signing enforced it: the rules may tighten, and a
  // token minted under the old rules must not outlive them.
  if (!isSafeRelativePath(path)) return null;

  return { classroomId, path };
}
