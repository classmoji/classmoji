/**
 * contentProxyHeaders.ts — the headers the legacy `/content/{org}/{repo}/…`
 * proxy puts on what it serves.
 *
 * Everything that route answers carries `nosniff`, so a browser takes the
 * declared type at its word.
 *
 * HTML and XHTML render as pages in a sandboxed origin: the response carries
 * `Content-Security-Policy: sandbox <box tokens>` — the same tokens an html
 * block's frame gets (`HTML_BLOCK_SANDBOX`), so a course page's scripts run
 * but the document has an opaque origin of its own. Decks now load their
 * frames from the content service; this keeps any link still pointing here
 * to the same rule.
 *
 * SVG and other XML are still served as a sandboxed download
 * (`DOWNLOAD_HARDENING_HEADERS` plus `attachment`): decks load images through
 * `<img>`, CSS `url()` and `<link>`, which ignore `Content-Disposition` and are
 * not documents a CSP sandbox governs, so only opening one directly changes.
 *
 * Pure — no Prisma, no services — so it can be unit tested on its own.
 */

import { HTML_BLOCK_SANDBOX } from '@classmoji/services/slides/runtime-attrs';
import { DOWNLOAD_HARDENING_HEADERS } from './slideKind.ts';

/** The CSP every HTML page this proxy serves carries: scripts run, in an opaque origin. */
export const PAGE_SANDBOX_CSP = `sandbox ${HTML_BLOCK_SANDBOX}`;

/**
 * Would a browser render a response of this type as a document of its own?
 *
 * By MIME rather than extension, so it holds whatever `getMimeType` learns to
 * map later: HTML, XHTML, SVG, and every `…/xml` or `…+xml` type.
 */
export function isDocumentMimeType(mimeType: string): boolean {
  const essence = mimeType.split(';')[0].trim().toLowerCase();
  return (
    essence === 'text/html' ||
    essence === 'application/xhtml+xml' ||
    essence === 'image/svg+xml' ||
    essence.endsWith('/xml') ||
    essence.endsWith('+xml')
  );
}

/** The headers the proxy adds to a response of `mimeType`. */
export function contentProxySafetyHeaders(mimeType: string): Record<string, string> {
  if (rendersAsPage(mimeType)) {
    return { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': PAGE_SANDBOX_CSP };
  }
  if (!isDocumentMimeType(mimeType)) {
    return { 'X-Content-Type-Options': 'nosniff' };
  }
  return { ...DOWNLOAD_HARDENING_HEADERS, 'Content-Disposition': 'attachment' };
}

/** HTML and XHTML: rendered as pages (sandboxed, see `PAGE_SANDBOX_CSP`). */
export function rendersAsPage(mimeType: string): boolean {
  const essence = mimeType.split(';')[0].trim().toLowerCase();
  return essence === 'text/html' || essence === 'application/xhtml+xml';
}

/**
 * Stamp `nosniff` onto a response the proxy produced some other way — a
 * refusal, a 404, the redirect for a file slide's document. Their bodies are
 * plain text or empty, so `nosniff` is all they need.
 */
export function withNosniff(response: Response): Response {
  // A `Response` built with `new Response` has mutable headers; one that came
  // back from `fetch` or `Response.redirect` does not, so rebuild those.
  try {
    response.headers.set('X-Content-Type-Options', 'nosniff');
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

/** What a proxy request was for, as logged: never the path itself, never its query. */
export type ProxyHitKind = 'html' | 'asset' | 'deck' | 'page' | 'theme';

/** The kind of a requested repo path (the route's `*` segment). */
export function proxyHitKind(path: string): ProxyHitKind {
  const p = path.replace(/^\/+/, '');
  if (p.startsWith('.slidesthemes/')) return 'theme';
  if (/^slides\/[^/]+\/(?:index\.html|deck\.json)$/i.test(p)) return 'deck';
  if (/^pages\/[^/]+\/(?:content\.json|index\.html)$/i.test(p)) return 'page';
  if (/\.x?html?$/i.test(p)) return 'html';
  return 'asset';
}

/** One line per request, so what still reaches this route can be counted. */
export function logProxyHit(kind: ProxyHitKind, status: number): void {
  // eslint-disable-next-line no-console -- an info line, read from the logs
  console.log(`[content-proxy] hit kind=${kind} status=${status}`);
}
