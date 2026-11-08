/**
 * The MCP server's resource identifier and the authorization server's issuer:
 * one value each, shared by the authorization server (./server.ts, the
 * webapp's better-auth) and the resource server (apps/mcp).
 *
 *   - MCP_RESOURCE: `<MCP_PUBLIC_URL origin>/mcp`, the URL clients connect to.
 *     It is the `resource` the protected-resource metadata advertises, the
 *     `resource` the authorization server issues tokens for (RFC 8707), and
 *     the `aud` the resource server requires.
 *   - AUTH_ISSUER: the webapp's origin (`WEBAPP_URL`), the issuer the
 *     authorization server signs tokens and metadata with.
 *
 * Both are resolved once, at import, and a malformed value throws then, so a
 * misconfigured app fails at boot instead of issuing tokens no resource server
 * accepts. In production both variables are required; elsewhere they default
 * to the local dev ports (MCP 8100, webapp 3000), as apps/mcp's config does.
 *
 * Dependency-free on purpose (no better-auth, no Prisma), so apps/mcp can
 * import it without building the auth instance.
 */

const DEFAULT_MCP_PORT = 8100;
const DEFAULT_WEBAPP_URL = 'http://localhost:3000';

/** The path of the MCP endpoint on the MCP server's origin. */
export const MCP_RESOURCE_PATH = '/mcp';

/**
 * An http(s) URL that names only an origin, as that origin (`scheme://host`
 * plus a non-default port, lowercased, no trailing slash). Trailing slashes
 * are allowed (`https://mcp.example.org/`); a path, query, fragment or
 * credentials are not, and neither is any other scheme.
 */
export function requireOrigin(value: string, varName: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`[auth] ${varName} must be an absolute http(s) URL, got: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`[auth] ${varName} must use http:// or https://, got: ${value}`);
  }
  if (
    url.username ||
    url.password ||
    value.includes('?') ||
    value.includes('#') ||
    url.pathname.replace(/\/+$/, '') !== ''
  ) {
    throw new Error(
      `[auth] ${varName} must be an origin (scheme, host and port only), got: ${value}`
    );
  }
  return url.origin;
}

/**
 * The MCP server's public origin, from `MCP_PUBLIC_URL`. Required in
 * production; elsewhere it defaults to `http://localhost:<MCP_PORT or 8100>`.
 */
export function resolveMcpPublicOrigin(
  value: string | undefined,
  { production, port }: { production: boolean; port?: string | number | undefined }
): string {
  if (!value) {
    if (production) {
      throw new Error(
        '[auth] MCP_PUBLIC_URL is required in production: it names the MCP resource ' +
          'that access tokens are issued for.'
      );
    }
    return requireOrigin(`http://localhost:${Number(port) || DEFAULT_MCP_PORT}`, 'MCP_PUBLIC_URL');
  }
  return requireOrigin(value, 'MCP_PUBLIC_URL');
}

/**
 * The authorization server's issuer, from `WEBAPP_URL`: its origin. Required
 * in production; elsewhere it defaults to `http://localhost:3000`.
 */
export function resolveAuthIssuer(
  value: string | undefined,
  { production }: { production: boolean }
): string {
  if (!value) {
    if (production) {
      throw new Error(
        '[auth] WEBAPP_URL is required in production: its origin is the issuer of ' +
          'every access token.'
      );
    }
    return requireOrigin(DEFAULT_WEBAPP_URL, 'WEBAPP_URL');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`[auth] WEBAPP_URL must be an absolute http(s) URL, got: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`[auth] WEBAPP_URL must use http:// or https://, got: ${value}`);
  }
  return url.origin;
}

const production = process.env.NODE_ENV === 'production';

/** The MCP server's public origin (`MCP_PUBLIC_URL`, canonical). */
export const MCP_PUBLIC_ORIGIN = resolveMcpPublicOrigin(process.env.MCP_PUBLIC_URL, {
  production,
  port: process.env.MCP_PORT,
});

/** The MCP resource identifier: the MCP server's origin plus `/mcp`. */
export const MCP_RESOURCE = `${MCP_PUBLIC_ORIGIN}${MCP_RESOURCE_PATH}`;

/** The authorization server's issuer: the webapp's origin. */
export const AUTH_ISSUER = resolveAuthIssuer(process.env.WEBAPP_URL, { production });

/**
 * Whether `value` names the MCP resource in one of the spellings clients send:
 * the resource itself, the bare origin with or without a trailing slash (MCP
 * SDK releases up to 1.30 send `new URL(resource).href`, which adds one), or
 * the resource with a trailing slash. Compared as parsed URLs, so case in the
 * scheme and host and a default port don't matter. A query, fragment or
 * credentials never match.
 */
export function namesMcpResource(value: string, resource: string = MCP_RESOURCE): boolean {
  if (value.includes('?') || value.includes('#')) return false;
  let url: URL;
  let target: URL;
  try {
    url = new URL(value);
    target = new URL(resource);
  } catch {
    return false;
  }
  if (url.username || url.password || url.origin !== target.origin) return false;
  const path = url.pathname.replace(/\/+$/, '');
  return path === '' || path === target.pathname.replace(/\/+$/, '');
}

/**
 * A request's `resource` parameter (RFC 8707), as the authorization server
 * should read it:
 *   - absent (undefined, null, '' or an empty list): the MCP resource, the
 *     only resource there is, so every access token is issued for it;
 *   - a spelling of the MCP resource (namesMcpResource): the MCP resource;
 *   - anything else is left as sent, for the authorization server to refuse.
 * A list is mapped value by value and duplicates are dropped; a list that
 * comes down to one value is returned as that value.
 */
export function canonicalMcpResourceParam(
  value: unknown,
  resource: string = MCP_RESOURCE
): unknown {
  const one = (v: unknown) =>
    typeof v === 'string' && namesMcpResource(v, resource) ? resource : v;
  if (value === undefined || value === null || value === '') return resource;
  if (Array.isArray(value)) {
    const mapped = [...new Set(value.filter(v => v !== '').map(one))];
    if (mapped.length === 0) return resource;
    return mapped.length === 1 ? mapped[0] : mapped;
  }
  return one(value);
}
