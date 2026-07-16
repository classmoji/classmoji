/**
 * Environment configuration for the MCP resource server.
 *
 * Port 8100 was chosen to avoid the ports used by the rest of the dev stack
 * (webapp 3000, hook-station 4001, ai-agent 6000, slides 6500, pages 7100,
 * postgres 5433 — see .dev-context).
 */

const stripTrailingSlash = (url: string): string => url.replace(/\/+$/, '');

/**
 * Validate an absolute http(s) URL, throwing at boot on a schemeless or
 * malformed value. The resource identifier advertised in RFC 9728
 * protected-resource metadata and WWW-Authenticate challenges MUST be an
 * absolute origin; a schemeless value ('mcp.example.com', 'localhost:8100')
 * silently produces broken metadata clients cannot resolve.
 */
const requireHttpUrl = (value: string, varName: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`[mcp] ${varName} must be an absolute http(s) URL, got: ${value}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`[mcp] ${varName} must use http:// or https://, got: ${value}`);
  }
  return stripTrailingSlash(value);
};

export const MCP_PORT = Number(process.env.MCP_PORT) || 8100;

/**
 * Public origin of THIS resource server. Advertised as `resource` in the
 * RFC 9728 protected-resource metadata and referenced from WWW-Authenticate
 * challenges. Must be the externally reachable URL in production.
 */
export const MCP_PUBLIC_URL = requireHttpUrl(
  process.env.MCP_PUBLIC_URL || `http://localhost:${MCP_PORT}`,
  'MCP_PUBLIC_URL'
);

/**
 * Origin of the OAuth authorization server (the webapp running the
 * better-auth `mcp()` plugin at basePath /api/auth).
 */
export const WEBAPP_URL = stripTrailingSlash(process.env.WEBAPP_URL || 'http://localhost:3000');

export const PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

if (process.env.NODE_ENV === 'production' && !process.env.MCP_PUBLIC_URL) {
  throw new Error(
    '[mcp] MCP_PUBLIC_URL is required in production — it is the resource identifier ' +
      'advertised in OAuth protected-resource metadata and WWW-Authenticate challenges.'
  );
}
