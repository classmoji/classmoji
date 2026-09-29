/**
 * contentProxyHeaders.ts — the headers the legacy `/content/{org}/{repo}/…`
 * proxy puts on what it serves.
 *
 * Everything that route answers carries `nosniff`, so a browser takes the
 * declared type at its word. A file whose type a browser would RENDER as a
 * document — HTML, XHTML, SVG, any XML — is additionally served as a sandboxed
 * download (`DOWNLOAD_HARDENING_HEADERS` plus `attachment`), because this proxy
 * shares the slides app's origin and its cookies.
 *
 * Nothing the app itself builds navigates to one of those files: the deck
 * surfaces read a deck's `index.html` with `fetch()` and parse it, and images
 * (SVG included) load through `<img>`, CSS `url()` and `<link>`. A subresource
 * load ignores `Content-Disposition`, and a CSP sandbox governs documents, not
 * decoded images — so none of those are affected. What changes is opening such
 * a file directly: it downloads instead of rendering here.
 *
 * Pure — no Prisma, no services — so it can be unit tested on its own.
 */

import { DOWNLOAD_HARDENING_HEADERS } from './slideKind.ts';

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
  if (!isDocumentMimeType(mimeType)) return { 'X-Content-Type-Options': 'nosniff' };
  return { ...DOWNLOAD_HARDENING_HEADERS, 'Content-Disposition': 'attachment' };
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
