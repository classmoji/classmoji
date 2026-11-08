/**
 * Environment configuration for the MCP resource server.
 *
 * Port 8100 was chosen to avoid the ports used by the rest of the dev stack
 * (webapp 3000, hook-station 4001, slides 6500, pages 7100,
 * postgres 5433 — see .dev-context).
 */

import { AUTH_ISSUER, MCP_PUBLIC_ORIGIN, MCP_RESOURCE } from '@classmoji/auth/mcp-resource';

const stripTrailingSlash = (url: string): string => url.replace(/\/+$/, '');

export const MCP_PORT = Number(process.env.MCP_PORT) || 8100;

/**
 * Public origin of THIS resource server (`MCP_PUBLIC_URL`, an origin only;
 * `http://localhost:<MCP_PORT>` outside production, required in it). The
 * shared module (packages/auth/src/mcpResource.ts) validates it at import, so
 * a schemeless or malformed value fails at boot. WWW-Authenticate challenges
 * point at the protected-resource metadata under it.
 */
export const MCP_PUBLIC_URL = MCP_PUBLIC_ORIGIN;

/**
 * The MCP resource identifier, `<MCP_PUBLIC_URL>/mcp`: the `resource` the
 * protected-resource metadata advertises, and the `aud` every OAuth access
 * token must name. One value with the OAuth server's (packages/auth).
 */
export { MCP_RESOURCE };

/** The OAuth server's issuer: the webapp's origin, the `iss` of every access token. */
export { AUTH_ISSUER };

/** The webapp's base URL, for links into it (feedback posts). */
export const WEBAPP_URL = stripTrailingSlash(process.env.WEBAPP_URL || 'http://localhost:3000');

export const PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';
