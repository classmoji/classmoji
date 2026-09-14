/**
 * Signed roster-invite tokens.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * A roster invite goes out by email. Whoever opens that mail has, by that act,
 * proved they can read the invited address — the same proof a verification
 * code would establish, one step later. So the invite link carries a token
 * naming the address (and the classroom), and registration accepts it in
 * place of the code for that exact address. Sign-ups that arrive without a
 * token (instructors, anyone typing the URL) still verify by code.
 *
 * A token proves ONLY "we mailed this address about this classroom, recently".
 * It is not a session and grants nothing on its own: registration still runs
 * its own checks, and the invite row itself is what gets consumed, so a link
 * cannot be replayed into a second account once the first has registered.
 *
 * ── Shape ────────────────────────────────────────────────────────────────────
 *   base64url(json({email, classroomId, exp})) "." base64url(hmac-sha256)
 *
 * Domain-separated from every other artifact signed with BETTER_AUTH_SECRET.
 * Two weeks rather than single-use, so opening the mail on a phone and then a
 * laptop does not strand the student.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { AUTH_SECRET } from './secret.ts';

/** HMAC domain separator. Bump the suffix if the payload shape ever changes. */
const TOKEN_DOMAIN = 'classmoji-roster-invite-v1';

export const INVITE_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** RFC 5321's practical ceiling; a sanity bound, not a format check. */
const MAX_EMAIL_LENGTH = 254;
const MAX_CLASSROOM_ID_LENGTH = 128;
/** Real tokens are ~200 bytes. */
const MAX_TOKEN_LENGTH = 4096;

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface InvitePayload {
  /** The address the invite was mailed to, as typed on the roster. */
  email: string;
  classroomId: string;
}

interface SignedInvitePayload extends InvitePayload {
  /** Absolute expiry, epoch milliseconds. */
  exp: number;
}

const isEmail = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= MAX_EMAIL_LENGTH && EMAIL_SHAPE.test(value);

const isClassroomId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_CLASSROOM_ID_LENGTH;

function computeMac(payloadB64: string): Buffer {
  return createHmac('sha256', AUTH_SECRET).update(`${TOKEN_DOMAIN}.${payloadB64}`).digest();
}

/** Mint a token for {email, classroomId}. Throws on malformed input rather than shipping a dud link. */
export function signInviteToken(payload: InvitePayload): string {
  if (!isEmail(payload?.email)) {
    throw new Error('[signInviteToken] email must be a plausible address.');
  }
  if (!isClassroomId(payload?.classroomId)) {
    throw new Error('[signInviteToken] classroomId must be a non-empty id string.');
  }

  const body: SignedInvitePayload = {
    email: payload.email,
    classroomId: payload.classroomId,
    exp: Date.now() + INVITE_TOKEN_TTL_MS,
  };
  const payloadB64 = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  return `${payloadB64}.${computeMac(payloadB64).toString('base64url')}`;
}

/**
 * Verify a token and return its payload, or `null` for every failure mode
 * (tampered, expired, malformed). One undifferentiated `null` on purpose: it
 * tells a prober nothing about which check failed.
 */
export function verifyInviteToken(token: unknown): InvitePayload | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return null;
  }

  const separator = token.indexOf('.');
  if (separator <= 0 || separator !== token.lastIndexOf('.') || separator === token.length - 1) {
    return null;
  }

  const payloadB64 = token.slice(0, separator);
  const macB64 = token.slice(separator + 1);
  if (!BASE64URL.test(payloadB64) || !BASE64URL.test(macB64)) return null;

  const provided = Buffer.from(macB64, 'base64url');
  const expected = computeMac(payloadB64);
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const { email, classroomId, exp } = parsed as Record<string, unknown>;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || Date.now() >= exp) return null;
  if (!isEmail(email) || !isClassroomId(classroomId)) return null;

  return { email, classroomId };
}

/** Case-insensitive: `school_email` is stored as typed, but a mailbox is one mailbox. */
export const inviteTokenMatchesEmail = (payload: InvitePayload, email: string): boolean =>
  payload.email.toLowerCase() === email.trim().toLowerCase();
