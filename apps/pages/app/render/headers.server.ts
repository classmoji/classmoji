/**
 * The response headers of `/_render/page/:pageId` (the MCP's page render),
 * its OWN policy, separate from the class site's (`site/headers.server.ts`).
 *
 * The page is drawn in the browser by the reader island, so `script-src`
 * admits this origin's `/assets/` path in a build ('self' in dev: the
 * island's entry, its chunks and the lazily loaded Shiki grammars, all module
 * scripts; `modulepreload` is governed by `script-src` too) and the hash of
 * the document's one inline script,
 * dark mode (`RenderDocument` in root.tsx). The site's copy script is not in
 * this document and not in this policy. `connect-src 'none'`: the render has
 * a view token and no session, and the island makes no request of its own
 * (no API call, no fetch: chunks are scripts and stylesheets, not fetches).
 * `style-src 'unsafe-inline'` because BlockNote and Mantine set inline styles
 * (image widths, column ratios, Shiki's colour variables) and inject <style>.
 * Never framed, never posting anywhere, no <base>.
 */
import { VIEW_HEADERS } from '@classmoji/services/render-contract';

import { DARK_MODE_SCRIPT_HASH } from '~/site/headers.server.ts';

export interface RenderPolicyOptions {
  /**
   * The page's own origin in a build: `script-src` is then narrowed to its
   * `/assets/` path (every hashed chunk the island loads lives there). Null
   * in dev, where Vite serves modules from other paths (`/app/…`,
   * `/node_modules/.vite/…`, `/@vite/…`) and `'self'` is kept.
   */
  assetsOrigin: string | null;
}

export function renderContentSecurityPolicy(
  { assetsOrigin }: RenderPolicyOptions = { assetsOrigin: null }
): string {
  const scripts = assetsOrigin ? `${assetsOrigin.replace(/\/+$/, '')}/assets/` : "'self'";
  return [
    "default-src 'none'",
    `script-src ${scripts} ${DARK_MODE_SCRIPT_HASH}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' https: data:",
    "media-src 'self' https:",
    'frame-src https:',
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Every header the render page answers with. */
export function renderPageHeaders(
  options: RenderPolicyOptions = { assetsOrigin: null }
): Record<string, string> {
  return {
    ...VIEW_HEADERS,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': renderContentSecurityPolicy(options),
  };
}

/**
 * A React Router data request for a render page (`/_render/page/<id>.data`).
 * The render document is never hydrated, so nothing asks for one (nothing in
 * the repo does); it is refused like the class site's `.data` requests,
 * before any loader reads the page. Read from the RAW request URL: the `url`
 * React Router hands loaders has the `.data` suffix removed.
 */
export function isRenderDataRequest(request: Request): boolean {
  return /^\/_render\/page\/[^/]+\.data$/.test(new URL(request.url).pathname);
}

/** The answer to one: 404, with the render page's own refusal headers. */
export function renderDataRequestRefusal(): Response {
  return new Response('Not Found', {
    status: 404,
    headers: {
      ...VIEW_HEADERS,
      'X-Content-Type-Options': 'nosniff',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}
