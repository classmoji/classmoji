import { createAuthClient } from 'better-auth/react';
import { adminClient, emailOTPClient } from 'better-auth/client/plugins';
import { oauthProviderClient } from '@better-auth/oauth-provider/client';

/**
 * `oauthProviderClient()`: while the page's address carries the signed query
 * of an authorization (the sign-in page an MCP client's authorization sends a
 * signed-out user to), every POST through this client carries it as
 * `oauth_query`, so the sign-in it completes resumes that authorization
 * (@better-auth/oauth-provider 1.7.18 dist/client.mjs). On any other page the
 * address has no signed query and nothing is added.
 */
export const authClient = createAuthClient({
  baseURL: typeof window !== 'undefined' ? window.location.origin : '',
  plugins: [adminClient(), emailOTPClient(), oauthProviderClient()],
});

export const { signIn, signOut, useSession } = authClient;
