/**
 * Server-side helper that forwards a Request from a host-root OAuth path
 * (e.g. `/authorize`, `/token`) to BetterAuth's actual mount under
 * `/api/auth/oauth2/...`.
 *
 * Background: some MCP clients (Claude Code's auth SDK fallback path; see
 * Anthropic claude-ai-mcp issues #82, #134) build OAuth endpoint URLs by
 * appending well-known path components (`/authorize`, `/token`, `/register`)
 * to the AS origin instead of using the URLs returned in the AS metadata
 * document. Those clients hit the webapp's host root and get a React Router
 * 404. This helper proxies them to the real BetterAuth endpoints, preserving
 * status, headers, and body so the client sees a normal OAuth response.
 */

export async function proxyToBetterAuthOAuth(
  request: Request,
  oauthPath: string
): Promise<Response> {
  const upstream = new URL(request.url);
  upstream.pathname = `/api/auth/oauth2/${oauthPath}`;

  const init: RequestInit = {
    method: request.method,
    headers: request.headers,
    redirect: 'manual',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.arrayBuffer();
  }

  const response = await fetch(upstream.toString(), init);

  // BetterAuth's oauth2/authorize and related endpoints sometimes return a
  // JSON envelope `{"redirect": true, "url": "..."}` instead of an HTTP 302
  // — it's designed for JS clients that read the JSON and call
  // `window.location.assign(url)`. When a browser hits the endpoint directly
  // (which is what Claude Code's auth flow does), it just renders the JSON.
  // Detect this shape and translate to a real 302 so the browser follows.
  const contentType = response.headers.get('content-type') ?? '';
  if (
    response.ok &&
    contentType.includes('application/json') &&
    request.method === 'GET'
  ) {
    const body = await response.text();
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object' && parsed.redirect === true && typeof parsed.url === 'string') {
        // The url may be relative (path-only) or absolute; URL constructor
        // resolves either correctly using the request as base.
        const target = new URL(parsed.url, request.url);
        return new Response(null, {
          status: 302,
          headers: { Location: target.toString() },
        });
      }
    } catch {
      /* not a redirect envelope; fall through and return original body */
    }
    // Not a redirect envelope — return original JSON
    return new Response(body, {
      status: response.status,
      headers: { 'content-type': contentType },
    });
  }

  // Pass through status + headers + body. Strip hop-by-hop headers that
  // Node's fetch may add but Express has already handled.
  const respHeaders = new Headers(response.headers);
  respHeaders.delete('content-encoding');
  respHeaders.delete('transfer-encoding');

  return new Response(response.body, {
    status: response.status,
    headers: respHeaders,
  });
}
