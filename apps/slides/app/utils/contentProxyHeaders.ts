/**
 * contentProxyHeaders.ts — the headers the legacy `/content/{org}/{repo}/…`
 * proxy puts on what it serves.
 *
 * Everything that route answers carries `nosniff`, so a browser takes the
 * declared type at its word.
 *
 * HTML and XHTML render as pages. Decks embed a course's own HTML (interactive
 * demos in the content repo) in `<iframe>`s pointed at this proxy, and those
 * pages load their own scripts and stylesheets through it too — a downloaded
 * or sandboxed response leaves the iframe blank, and an opaque-origin sandbox
 * would also stop the page's subresources, which need the viewer's session.
 *
 * SVG and other XML are still served as a sandboxed download
 * (`DOWNLOAD_HARDENING_HEADERS` plus `attachment`): decks load images through
 * `<img>`, CSS `url()` and `<link>`, which ignore `Content-Disposition` and are
 * not documents a CSP sandbox governs, so only opening one directly changes.
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
  if (!isDocumentMimeType(mimeType) || rendersAsPage(mimeType)) {
    return { 'X-Content-Type-Options': 'nosniff' };
  }
  return { ...DOWNLOAD_HARDENING_HEADERS, 'Content-Disposition': 'attachment' };
}

/** HTML and XHTML: course pages that decks embed in iframes render as pages. */
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
