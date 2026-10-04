/**
 * view.ts — the short-lived token that lets a HEADLESS BROWSER render one deck
 * or page, at one target, for an agent that cannot see it.
 *
 * The MCP's `deck_render` / `page_render` tools point a browser (Cloudflare
 * Browser Run in production, a local headless Chrome in dev) at a token-gated
 * render route and screenshot it. Same shape as the deck-thumbnail render
 * token (`render.ts`), narrower in one more dimension:
 *
 *   - ONE document: `{classroomId, kind, docId}` are inside the signature.
 *   - ONE target: `at:pin` — which copy (`main` / `preview`) and the version
 *     the caller read (`live:3.12`, a blob sha). The route refuses a request
 *     whose query names a different target than the token was minted for.
 *   - ONE host, 120 seconds, no grace.
 *   - Its own canonical namespace (`cm1|view|…`), so it can be presented
 *     neither as a content URL nor as a thumbnail render token, and a render
 *     token cannot be presented here.
 *
 * Keyed on the classroom's derived key, so a `content_key_version` bump
 * retires these too.
 */

import { nowSeconds } from './bucket.ts';
import {
  CANONICAL_VERSION,
  assertClassroomId,
  assertKeyVersion,
  assertNow,
  fromBase64Url,
  hostOf,
  isUnixSeconds,
  isUuid,
  toBase64Url,
} from './canonical.ts';
import { deriveKey, signCanonical, verifyCanonical } from './derive.ts';
import type { VerifyFailure } from './types.ts';

/** Exactly how long a view token lives, in seconds. */
export const VIEW_TOKEN_TTL_SECONDS = 120;

/** The two document kinds a view token can name. */
export type ViewDocKind = 'deck' | 'page';

/**
 * `at:pin`, e.g. `main:live:3.12` or `preview:4b825dc6…`. A closed alphabet:
 * no `|` (the canonical separator), no whitespace, bounded length.
 */
const TARGET_PATTERN = /^[A-Za-z0-9:._-]{1,128}$/;

export function isViewTarget(value: unknown): value is string {
  return typeof value === 'string' && TARGET_PATTERN.test(value);
}

export interface ViewCanonicalFields {
  host: string;
  classroomId: string;
  kind: ViewDocKind;
  docId: string;
  target: string;
  exp: number;
}

/** `cm1|view|{host}|{classroomId}|{kind}|{docId}|{target}|{exp}` */
export function viewCanonicalString(fields: ViewCanonicalFields): string {
  const { host, classroomId, kind, docId, target, exp } = fields;
  return [CANONICAL_VERSION, 'view', host, classroomId, kind, docId, target, exp].join('|');
}

export interface ViewTokenFields {
  /** Absolute URL of the origin that will SERVE the render route. */
  origin: string | URL;
  classroomId: string;
  kind: ViewDocKind;
  docId: string;
  target: string;
  keyVersion: number;
  /** Unix seconds; defaults to the wall clock. */
  now?: number;
}

export type ViewVerification =
  | { ok: true; exp: number }
  | { ok: false; reason: VerifyFailure; exp?: number; skewSeconds?: number };

const TOKEN_PATTERN = /^(0|[1-9][0-9]*)\.([A-Za-z0-9_-]+)$/;

function assertFields(fields: ViewTokenFields): { host: string; now: number } {
  assertClassroomId(fields.classroomId);
  if (fields.kind !== 'deck' && fields.kind !== 'page') {
    throw new TypeError(`content-signing: view kind must be deck or page (got ${fields.kind})`);
  }
  if (!isUuid(fields.docId)) {
    throw new TypeError(`content-signing: docId must be a lowercase UUID (got ${fields.docId})`);
  }
  if (!isViewTarget(fields.target)) {
    throw new TypeError('content-signing: view target must match [A-Za-z0-9:._-]{1,128}');
  }
  assertKeyVersion(fields.keyVersion);
  const now = fields.now ?? nowSeconds();
  assertNow(now);
  return { host: hostOf(fields.origin), now };
}

function canonicalFor(fields: ViewTokenFields, host: string, exp: number): string {
  return viewCanonicalString({
    host,
    classroomId: fields.classroomId,
    kind: fields.kind,
    docId: fields.docId,
    target: fields.target,
    exp,
  });
}

/** Mint a view token. `{exp}.{sig}`. Mint it immediately before navigating. */
export async function signViewToken(master: string, fields: ViewTokenFields): Promise<string> {
  const { host, now } = assertFields(fields);
  const exp = now + VIEW_TOKEN_TTL_SECONDS;
  const key = await deriveKey(master, fields.classroomId, fields.keyVersion);
  return `${exp}.${toBase64Url(await signCanonical(key, canonicalFor(fields, host, exp)))}`;
}

/**
 * Verify a view token against the document and target the ROUTE resolved
 * (its own params, its own database read, its own query) — nothing but the
 * expiry is lifted out of the token. Signature first, expiry second, exactly
 * as `verifyRenderToken`.
 */
export async function verifyViewToken(
  master: string,
  token: string,
  fields: ViewTokenFields
): Promise<ViewVerification> {
  const { host, now } = assertFields(fields);

  if (typeof token !== 'string') return { ok: false, reason: 'malformed' };
  const match = TOKEN_PATTERN.exec(token);
  if (!match) return { ok: false, reason: 'malformed' };

  const exp = Number(match[1]);
  if (!isUnixSeconds(exp)) return { ok: false, reason: 'malformed' };
  const signature = fromBase64Url(match[2]);
  if (!signature) return { ok: false, reason: 'malformed' };

  const key = await deriveKey(master, fields.classroomId, fields.keyVersion);
  if (!(await verifyCanonical(key, signature, canonicalFor(fields, host, exp)))) {
    return { ok: false, reason: 'bad-signature' };
  }
  if (now > exp) return { ok: false, reason: 'expired', exp, skewSeconds: now - exp };
  return { ok: true, exp };
}
