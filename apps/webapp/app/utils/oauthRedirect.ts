/**
 * Re-export of the shared OAuth redirect guard.
 *
 * The implementation moved to `@classmoji/auth/oauth-redirect` when apps/admin
 * began mounting its own `auth.handler` — every app that does so inherits the
 * mcp plugin's Dynamic Client Registration endpoints and needs the identical
 * check, and a per-app copy of a security guard is a copy that drifts.
 *
 * Kept as a re-export so existing `~/utils/oauthRedirect` imports (the DCR
 * interception in `routes/api.auth.$.ts`, the sink in
 * `routes/oauth.consent/route.tsx`) and their tests keep resolving unchanged.
 */
export { isHttpRedirectUri } from '@classmoji/auth/oauth-redirect';
