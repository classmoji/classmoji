/**
 * Content-Security-Policy for the slides app's responses.
 *
 * App documents (everything entry.server.tsx renders) carry a per-request
 * nonce: only scripts the app itself emits run, plus whatever those load
 * (`'strict-dynamic'`). `https:` and `'unsafe-inline'` in script-src are for
 * browsers without nonce / strict-dynamic support and are ignored by those
 * that have it. The editor, presenter and speaker documents may only be framed
 * by the slides origin itself; the viewer and follow documents stay
 * embeddable.
 *
 * Generated deck documents (`render-view`, `thumbnail-source`) have a fixed
 * set of inline scripts, so their policy allows those by hash and Reveal from
 * jsDelivr, and nothing else.
 *
 * Production enforces; development sends the same policy as Report-Only, with
 * the local dev servers (Vite's HMR socket, the local content service) added.
 */

import { createHash } from 'node:crypto';
import { resolveCollabUrls } from '@classmoji/collab/env';
import { GENERATED_DOC_SCRIPT_HASHES } from '@classmoji/services/slides';

type Env = Record<string, string | undefined>;

export const CSP_HEADER = 'Content-Security-Policy';
export const CSP_REPORT_ONLY_HEADER = 'Content-Security-Policy-Report-Only';

const isProduction = (env: Env) => env.NODE_ENV === 'production';

/** The header the policy goes in: enforced in production, Report-Only elsewhere. */
export function cspHeaderName(env: Env = process.env): string {
  return isProduction(env) ? CSP_HEADER : CSP_REPORT_ONLY_HEADER;
}

/** `value`'s origin, or null when it is not an absolute URL. */
function originOf(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const origin = new URL(value.trim()).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/** The content service's origin (`CONTENT_DELIVERY_ORIGIN`), or null when unset. */
export function contentDeliveryOrigin(env: Env = process.env): string | null {
  return originOf(env.CONTENT_DELIVERY_ORIGIN);
}

/** The WebSocket origin for an http(s) origin: same host, ws(s) scheme. */
function socketOrigin(origin: string | null): string | null {
  return origin ? origin.replace(/^http(s?):/, 'ws$1:') : null;
}

/**
 * Documents only the slides origin may frame: the editor (`/:slideId?mode=edit`),
 * the presenter and the speaker view. Everything else keeps today's framing.
 */
export function framedBySelfOnly(url: URL): boolean {
  const { pathname } = url;
  if (/^\/[^/]+\/(?:present|speaker)\/?$/.test(pathname)) return true;
  return /^\/[^/]+\/?$/.test(pathname) && url.searchParams.get('mode') === 'edit';
}

/** Sources each local dev server adds to the policy outside production. */
const DEV_HTTP = 'http://localhost:*';
const DEV_WS = 'ws://localhost:*';

function directives(entries: Array<[string, Array<string | null | false>]>): string {
  return entries
    .map(([name, sources]) => {
      const list = [...new Set(sources.filter((s): s is string => Boolean(s)))];
      return list.length ? `${name} ${list.join(' ')}` : name;
    })
    .join('; ');
}

export interface AppCspInput {
  nonce: string;
  /** The document's URL (decides `frame-ancestors`). */
  url: URL;
  env?: Env;
}

/** The policy for an app document. */
export function appContentSecurityPolicy({ nonce, url, env = process.env }: AppCspInput): string {
  const dev = !isProduction(env);
  const webapp = originOf(env.WEBAPP_URL);
  const content = contentDeliveryOrigin(env);
  const slides = originOf(env.SLIDES_URL) ?? url.origin;
  const collabWs = originOf(resolveCollabUrls(env)?.wsUrl);

  const entries: Array<[string, Array<string | null | false>]> = [
    ['default-src', ["'self'"]],
    ['script-src', [`'nonce-${nonce}'`, "'strict-dynamic'", 'https:', "'unsafe-inline'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'self'", webapp]],
    ['frame-src', ["'self'", 'https:', content, webapp, dev && DEV_HTTP]],
    ['worker-src', ["'self'", 'blob:']],
    [
      'connect-src',
      ["'self'", socketOrigin(slides), collabWs, 'https:', dev && DEV_HTTP, dev && DEV_WS],
    ],
    ['img-src', ["'self'", 'data:', 'blob:', 'https:', dev && DEV_HTTP]],
    ['media-src', ["'self'", 'blob:', 'https:', dev && DEV_HTTP]],
    ['style-src', ["'self'", "'unsafe-inline'", 'https:', dev && DEV_HTTP]],
    ['font-src', ["'self'", 'data:', 'https:', dev && DEV_HTTP]],
  ];
  if (framedBySelfOnly(url)) entries.push(['frame-ancestors', ["'self'"]]);
  return directives(entries);
}

/** CSP source token for an inline script's exact text. */
export function scriptHashSource(text: string): string {
  return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

const generatedPolicies = new Map<string, string>();

/**
 * The policy for a generated deck document: the generator's own inline
 * scripts and `routeScripts` (the route's constant inline scripts, exact text)
 * by hash, Reveal from jsDelivr, nothing that connects anywhere.
 */
export function generatedDocContentSecurityPolicy(routeScripts: readonly string[]): string {
  const key = routeScripts.join('\u0000');
  const cached = generatedPolicies.get(key);
  if (cached) return cached;
  const policy = directives([
    ['default-src', ["'none'"]],
    [
      'script-src',
      [
        ...GENERATED_DOC_SCRIPT_HASHES,
        ...routeScripts.map(scriptHashSource),
        'https://cdn.jsdelivr.net',
      ],
    ],
    ['style-src', ["'unsafe-inline'", 'https:']],
    ['img-src', ['data:', 'blob:', 'https:']],
    ['font-src', ['data:', 'https:']],
    ['media-src', ['https:']],
    ['frame-src', ['https:']],
    ['connect-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'none'"]],
    ['frame-ancestors', ["'none'"]],
  ]);
  generatedPolicies.set(key, policy);
  return policy;
}

/** The CSP header for a generated deck document, as a headers record. */
export function generatedDocCspHeaders(
  routeScripts: readonly string[],
  env: Env = process.env
): Record<string, string> {
  return { [cspHeaderName(env)]: generatedDocContentSecurityPolicy(routeScripts) };
}
