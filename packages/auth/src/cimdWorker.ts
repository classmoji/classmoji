/**
 * The Client ID Metadata Document transport for Cloudflare Workers: the same
 * contract as `@better-auth/cimd/node`'s `fetchClientMetadataResource`, on
 * `fetch()` instead of `node:https` + `node:dns`.
 *
 * Workers builds swap `@better-auth/cimd/node` for this module
 * (`classmojiWorkerSwaps` in `@classmoji/workers/vite`): the Node transport
 * imports `node:dns/promises`, `node:https`, `node:net` and `node:stream` at
 * module scope, which workerd cannot load. On Node the original stays.
 *
 * What the Node transport enforces, and this one too:
 * - HTTPS only; GET and HEAD only.
 * - The host must be public-routable (`isPublicRoutableHost`): no loopback,
 *   private, link-local, shared-space or cloud-metadata hosts.
 * - Redirects are never followed: a 3xx is handed back to the caller, which
 *   refuses it. The caller asks for `redirect: 'error'`; that is overridden to
 *   `'manual'` so the caller sees the 3xx, exactly as with the Node transport.
 * - No body for HEAD, 204, 205 and 304.
 *
 * What it does not need: DNS resolution and connection pinning. A Worker's
 * `fetch()` cannot reach private or loopback addresses, whatever a hostname
 * resolves to, so a name that resolves to one cannot be used to reach inside.
 *
 * The 5 s timeout, the 5120-byte body cap and the JSON Content-Type check are
 * the CALLER's (`@better-auth/cimd`'s resolver applies them to whatever
 * transport it is given), so they are not repeated here; the signal it passes
 * is honoured and the body is handed back as a stream for it to cap.
 */
// eslint's resolver misses this subpath export; TypeScript resolves it.
// eslint-disable-next-line import/no-unresolved
import { isPublicRoutableHost } from '@better-auth/core/utils/host';
import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider';

const BODY_FORBIDDEN_RESPONSE_STATUSES = new Set([204, 205, 304]);

export const fetchClientMetadataResource: ClientMetadataResourceFetch = async (input, init) => {
  const webRequest = new Request(input, init);
  const url = new URL(webRequest.url);
  if (url.protocol !== 'https:') {
    throw new TypeError('CIMD Workers transport requires an HTTPS URL');
  }
  if (webRequest.method !== 'GET' && webRequest.method !== 'HEAD') {
    throw new TypeError('CIMD Workers transport supports only GET and HEAD');
  }
  if (!isPublicRoutableHost(url.hostname)) {
    throw new TypeError('metadata hostname must be public-routable');
  }
  const signal = init?.signal ?? (input instanceof Request ? input.signal : webRequest.signal);
  const response = await fetch(url, {
    method: webRequest.method,
    headers: webRequest.headers,
    redirect: 'manual',
    signal,
  });
  if (webRequest.method === 'HEAD' || BODY_FORBIDDEN_RESPONSE_STATUSES.has(response.status)) {
    await response.body?.cancel();
    return new Response(null, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  }
  return response;
};
