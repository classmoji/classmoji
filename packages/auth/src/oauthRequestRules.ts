/**
 * Request rules for the OAuth 2.1 authorization server (better-auth 1.7.18's
 * oauth-provider, as @better-auth/mcp configures it), applied in the shared
 * `hooks.before` (./server.ts BEFORE_HOOK_RULES):
 *
 *   - Client registration (/oauth2/register) is always open registration: it
 *     takes no back-channel logout endpoint and no DPoP-bound tokens, and a
 *     session cookie on the request is not read.
 *   - Every authorization and token request names the MCP resource, so every
 *     access token is a JWT for it (resourceParamChange).
 *   - An authorization request whose client may refresh asks for
 *     `offline_access` (offlineAccessChange).
 *   - No token is bound to a DPoP key (refuseDpopBoundAuthorization,
 *     dpopProofIgnored).
 *
 * Line references are to @better-auth/oauth-provider 1.7.18,
 * dist/authorize-*.mjs and dist/utils-*.mjs.
 */

import { createHash } from 'node:crypto';
import { APIError } from 'better-auth/api';
import { canonicalMcpResourceParam, MCP_RESOURCE } from './mcpResource.ts';
import {
  authorizeParameterChange,
  authorizeParameters,
  OAUTH_AUTHORIZE_PATH,
  type AppConnectionHookContext,
  type BeforeHookContextChange,
} from './appConnectionGuard.ts';

export const OAUTH_REGISTER_PATH = '/oauth2/register';
export const OAUTH_TOKEN_PATH = '/oauth2/token';

/**
 * The scopes the authorization server offers (its `scopes` option). Clients
 * that register get all of them (`clientRegistrationDefaultScopes` defaults
 * to this list); per-classroom roles do the fine-grained authorization, and
 * `read`/`write` only separate reading from changing.
 */
export const OAUTH_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'read', 'write'];

/** The parts of the adapter these rules use (better-auth's `ctx.context.adapter`). */
interface RuleAdapter {
  findOne(args: {
    model: string;
    where: { field: string; value: string }[];
  }): Promise<Record<string, unknown> | null>;
  update(args: {
    model: string;
    where: { field: string; value: string }[];
    update: Record<string, unknown>;
  }): Promise<unknown>;
}

export interface OAuthRuleContext extends AppConnectionHookContext {
  headers?: Headers;
  context: { adapter?: RuleAdapter; session?: unknown };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Registration takes no back-channel logout endpoint (OpenID Connect
 * Back-Channel Logout, which oauth-provider supports): Classmoji uses none,
 * so the server never calls out to an address a client registered. Client ID
 * Metadata Documents can't carry these fields either (@better-auth/cimd
 * refuses them).
 */
export const BACKCHANNEL_LOGOUT_FIELDS = [
  'backchannel_logout_uri',
  'backchannel_logout_session_required',
] as const;

export const BACKCHANNEL_LOGOUT_REFUSED_MESSAGE = 'Back-channel logout is not supported.';

export function refuseBackchannelLogout(ctx: OAuthRuleContext): void {
  const body = isRecord(ctx.body) ? ctx.body : {};
  if (BACKCHANNEL_LOGOUT_FIELDS.some(field => body[field] !== undefined && body[field] !== null)) {
    throw new APIError('BAD_REQUEST', {
      error: 'invalid_client_metadata',
      error_description: BACKCHANNEL_LOGOUT_REFUSED_MESSAGE,
    });
  }
}

/**
 * DPoP (RFC 9449) is not used: the MCP server takes bearer tokens only
 * (`bearer_methods_supported: header`) and refuses a token bound to a key
 * (`cnf`). oauth-provider binds a token whenever a request carries a proof or
 * the client or the code asks for one, and has no option that turns that off
 * (`resolveDpopTokenBinding`, :1810-1835). So:
 *   - registration refuses a client that asks for DPoP-bound tokens
 *     (refuseDpopBoundRegistration);
 *   - authorization refuses `dpop_jkt`, which would bind the code
 *     (refuseDpopBoundAuthorization);
 *   - the token endpoint reads no proof (dpopProofIgnored), so a client that
 *     sends one gets a Bearer token, which RFC 9449 §5 says the client then
 *     uses as one;
 *   - the discovery documents do not advertise DPoP (./oauthHttp.ts
 *     withoutUnsupportedMetadata).
 * A client known by its Client ID Metadata Document that demands DPoP-bound
 * tokens is refused at the token endpoint ("DPoP proof header is required"):
 * an error, not a token the MCP server would refuse.
 */
export const DPOP_REFUSED_MESSAGE = 'DPoP-bound access tokens are not supported.';

export function refuseDpopBoundRegistration(ctx: OAuthRuleContext): void {
  const body = isRecord(ctx.body) ? ctx.body : {};
  if (body.dpop_bound_access_tokens === true) {
    throw new APIError('BAD_REQUEST', {
      error: 'invalid_client_metadata',
      error_description: DPOP_REFUSED_MESSAGE,
    });
  }
}

export function refuseDpopBoundAuthorization(ctx: OAuthRuleContext): void {
  if (ctx.path !== OAUTH_AUTHORIZE_PATH) return;
  const jkt = authorizeParameters(ctx).dpop_jkt;
  if (jkt !== undefined && jkt !== null) {
    throw new APIError('BAD_REQUEST', {
      error: 'invalid_request',
      error_description: DPOP_REFUSED_MESSAGE,
    });
  }
}

/**
 * The token endpoint reads no DPoP proof: the `dpop` header is set to `''`,
 * which the provider takes as no proof (`getDpopProofJwt`, :1250-1251). A
 * hook can't delete a header (better-auth merges hook headers with `set`), so
 * it blanks it, as register-open does with `cookie`.
 */
export function dpopProofIgnored(ctx: OAuthRuleContext): BeforeHookContextChange | undefined {
  if (ctx.path !== OAUTH_TOKEN_PATH || !ctx.headers?.get('dpop')) return undefined;
  return { context: { headers: new Headers({ dpop: '' }) } };
}

/**
 * Registration never reads the caller's session. With a session,
 * oauth-provider would treat it as a signed-in user creating a client of
 * their own (`registerEndpoint`: `assertClientPrivileges(..., "create")`),
 * which `clientPrivileges` refuses for everyone; without one it is open
 * registration, which is what every MCP client does. Dropping the cookie
 * header makes the two the same request.
 */
export function openRegistrationChange(ctx: OAuthRuleContext): BeforeHookContextChange | undefined {
  if (!ctx.headers?.get('cookie')) return undefined;
  return { context: { headers: new Headers({ cookie: '' }) } };
}

export const RESOURCE_REFUSED_MESSAGE = 'The only resource is the Classmoji MCP server.';

/** Whether two `resource` values are the same (strings, or lists of them). */
function sameResourceParam(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, i) => value === b[i]);
  }
  return a === b;
}

/**
 * SHA-256, base64url without padding: how oauth-provider stores and looks up
 * refresh tokens (`storeTokens: "hashed"`, utils `defaultHasher`, used by
 * `getStoredToken`). No `prefix.refreshToken` or `formatRefreshToken` is
 * configured, so the presented token is the stored one before hashing.
 */
export const storedRefreshToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('base64url');

/**
 * Every authorization and token request names the MCP resource, the only
 * resource there is:
 *   - absent → the MCP resource. Without one, oauth-provider issues an opaque,
 *     session-bound access token instead of a JWT (`isJwtAccessToken =
 *     audienceClaim && ...`, :1977; no audience without a resource, :788-794),
 *     which the MCP server does not accept;
 *   - the bare origin, with or without a trailing slash (MCP SDK releases up
 *     to 1.30 send that), or the resource with one → the MCP resource, since
 *     the provider compares `resource` by exact string (:1006-1021).
 * At /oauth2/authorize anything else is refused (400 `invalid_target`): a
 * list naming another resource too, and the userinfo URL, which the provider
 * would otherwise accept (it skips that identifier when it checks resources,
 * :808-809) and issue a token for. So no consent or code names a resource
 * other than the MCP one. At /oauth2/token anything else is left for the
 * provider, which checks it against what the code or refresh token was
 * issued for. A `resource` repeated in a token request's form body reaches
 * the provider as sent: it re-reads the raw form after the hooks
 * (:7464-7466).
 *
 * A refresh token with no resources (one copied from the 1.4 tables, which
 * had none) is given the MCP resource before the refresh runs: Prisma reads
 * its empty list back as `[]`, which the refresh grant takes as "issued for
 * no resource" and refuses the requested one (:2317-2323).
 */
export async function resourceParamChange(
  ctx: OAuthRuleContext
): Promise<BeforeHookContextChange | undefined> {
  if (ctx.path === OAUTH_AUTHORIZE_PATH) {
    const sent = authorizeParameters(ctx).resource;
    const resource = canonicalMcpResourceParam(sent);
    if (resource !== MCP_RESOURCE) {
      throw new APIError('BAD_REQUEST', {
        error: 'invalid_target',
        error_description: RESOURCE_REFUSED_MESSAGE,
      });
    }
    return sameResourceParam(resource, sent)
      ? undefined
      : authorizeParameterChange(ctx, { resource });
  }
  if (ctx.path !== OAUTH_TOKEN_PATH) return undefined;
  const body = isRecord(ctx.body) ? ctx.body : {};
  if (body.grant_type === 'refresh_token' && typeof body.refresh_token === 'string') {
    await giveRefreshTokenTheResource(ctx, body.refresh_token);
  }
  const resource = canonicalMcpResourceParam(body.resource);
  return sameResourceParam(resource, body.resource)
    ? undefined
    : { context: { body: { resource } } };
}

async function giveRefreshTokenTheResource(ctx: OAuthRuleContext, token: string): Promise<void> {
  const adapter = ctx.context.adapter;
  if (!adapter || !token) return;
  const row = await adapter.findOne({
    model: 'oauthRefreshToken',
    where: [{ field: 'token', value: storedRefreshToken(token) }],
  });
  if (!row || typeof row.id !== 'string') return;
  if (Array.isArray(row.resources) && row.resources.length > 0) return;
  await adapter.update({
    model: 'oauthRefreshToken',
    where: [{ field: 'id', value: row.id }],
    update: { resources: [MCP_RESOURCE] },
  });
}

/**
 * Whether a client may be issued a refresh token, the way oauth-provider
 * decides it (`clientAllowsGrant(client, "refresh_token")`, utils): no grant
 * types means authorization_code, and a client that may use
 * authorization_code may refresh. Also, `offline_access` must be among its
 * scopes (none stored means the server's list).
 */
function clientMayRefresh(client: Record<string, unknown>): boolean {
  const grants =
    Array.isArray(client.grantTypes) && client.grantTypes.length > 0
      ? (client.grantTypes as unknown[])
      : ['authorization_code'];
  const scopes =
    Array.isArray(client.scopes) && client.scopes.length > 0
      ? (client.scopes as unknown[])
      : OAUTH_SCOPES;
  return (
    (grants.includes('authorization_code') || grants.includes('refresh_token')) &&
    scopes.includes('offline_access')
  );
}

/**
 * An authorization request that names its scopes gets `offline_access` too,
 * when the client may refresh. oauth-provider issues a refresh token only
 * when `offline_access` is granted (:1976). Claude adds it itself when the
 * server's metadata lists it; MCP SDK clients ask for the protected
 * resource's scopes (`read write`) and never add it, so without this they
 * would sign in again every hour. A request that names no scopes already gets
 * the client's scopes, `offline_access` among them. A client with no row yet
 * (one known by its Client ID Metadata Document, fetched by the endpoint) is
 * given it as well: the endpoint still checks it against the client's scopes.
 */
export async function offlineAccessChange(
  ctx: OAuthRuleContext
): Promise<BeforeHookContextChange | undefined> {
  if (ctx.path !== OAUTH_AUTHORIZE_PATH) return undefined;
  const params = authorizeParameters(ctx);
  if (typeof params.scope !== 'string') return undefined;
  const scopes = params.scope.split(' ').filter(Boolean);
  if (scopes.length === 0 || scopes.includes('offline_access')) return undefined;
  if (typeof params.client_id !== 'string' || !params.client_id) return undefined;
  const client = await ctx.context.adapter?.findOne({
    model: 'oauthClient',
    where: [{ field: 'clientId', value: params.client_id }],
  });
  if (client && !clientMayRefresh(client)) return undefined;
  return authorizeParameterChange(ctx, { scope: [...scopes, 'offline_access'].join(' ') });
}
