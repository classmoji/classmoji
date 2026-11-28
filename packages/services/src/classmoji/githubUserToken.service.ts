/**
 * Per-user GitHub access token accessor — usable outside the webapp.
 *
 * The token + refresh logic used to live privately in `@classmoji/auth`
 * (`getValidGitHubToken`), but that pulls in betterAuth, so it could not be
 * reached from a Trigger.dev worker. This service holds the lean version:
 * it only needs Prisma, `GITHUB_CLIENT_ID/SECRET`, and `fetch`. `@classmoji/auth`
 * now delegates to it, so there is a single source of truth for refresh.
 *
 * GitHub App user access tokens (`ghu_*`) are short-lived and refreshed with a
 * one-time-use refresh token (`ghr_*`) that rotates on every use — so refreshes
 * are guarded by a per-user, per-process mutex to avoid two concurrent refreshes
 * racing and invalidating each other's token.
 */

import getPrisma from '@classmoji/database';
import type { Account as PrismaAccount } from '@classmoji/database/client';
import { reportError } from '@classmoji/utils/error-report';

export interface GitHubTokenResult {
  token: string;
  expiresAt: Date | null;
}

interface RefreshedTokens {
  accessToken: string;
  refreshToken: string | undefined;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
}

// Refresh tokens this long before they actually expire, so concurrent requests
// never serve a token that dies mid-flight.
const REFRESH_BUFFER_MS = 10 * 60 * 1000; // 10 minutes

// Per-user mutex to prevent concurrent refresh attempts. GitHub App refresh
// tokens (ghr_*) are one-time-use: if two requests refresh simultaneously, the
// second gets `bad_refresh_token` because the first already consumed the old one.
const refreshLocks = new Map<string, Promise<GitHubTokenResult | null>>();

async function withRefreshLock(
  userId: string,
  fn: () => Promise<GitHubTokenResult | null>
): Promise<GitHubTokenResult | null> {
  const existing = refreshLocks.get(userId);
  if (existing) return existing;

  const promise = fn().finally(() => {
    refreshLocks.delete(userId);
  });
  refreshLocks.set(userId, promise);
  return promise;
}

/** GitHub's `error` field when it is a plain code (`bad_refresh_token`), else undefined. */
const errorCode = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[a-z_]{1,40}$/.test(value) ? value : undefined;

/**
 * Refusals that are expected and not reported: the person must sign in again
 * (or another machine used the token first). They recur on every request for
 * that person until they do, so a report would say nothing new.
 */
const EXPECTED_REFUSALS = new Set(['bad_refresh_token', 'invalid_grant']);

/**
 * Report a failed refresh: the network, a 5xx, an answer we could not read, a
 * refusal we did not expect. Never the tokens or GitHub's text.
 */
function reportRefreshFailure(
  error: unknown,
  tags: { reason: string; status?: number; code?: string }
): void {
  if (tags.code && EXPECTED_REFUSALS.has(tags.code)) return;
  reportError(error, { surface: 'github.token_refresh', tags });
}

/**
 * The one error a missing client id/secret is reported as: the same object
 * every time, so `reportError` sends it once per process, not per request.
 */
const NOT_CONFIGURED = new Error('GitHub token refresh: client not configured');

/**
 * Refresh a GitHub App user access token using its refresh token.
 *
 * GitHub's OAuth endpoint returns HTTP 200 for ALL responses, including errors
 * like `bad_refresh_token`, so we must inspect the body rather than the status.
 */
async function refreshGitHubToken(
  account: Pick<PrismaAccount, 'refresh_token'>
): Promise<RefreshedTokens | null> {
  if (!account.refresh_token) return null;

  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('[githubUserToken] Missing GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET');
    reportRefreshFailure(NOT_CONFIGURED, { reason: 'not_configured' });
    return null;
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: account.refresh_token,
  });

  let response: Response;
  try {
    response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body,
    });
  } catch (error: unknown) {
    reportRefreshFailure(error, { reason: 'network' });
    throw error;
  }

  let data;
  try {
    data = await response.json();
  } catch (error: unknown) {
    reportRefreshFailure(error, { reason: 'unreadable_response', status: response.status });
    throw error;
  }

  // GitHub returns HTTP 200 for errors! Must check the body.
  if (data.error) {
    console.error(
      `[githubUserToken] GitHub token refresh failed: ${data.error} - ${data.error_description}`
    );
    const code = errorCode(data.error);
    reportRefreshFailure(new Error(`GitHub token refresh failed: ${code ?? 'unknown_error'}`), {
      reason: 'refused',
      status: response.status,
      code,
    });
    return null;
  }

  if (!data.access_token) {
    console.error('[githubUserToken] GitHub token refresh returned no access_token');
    reportRefreshFailure(new Error('GitHub token refresh returned no access_token'), {
      reason: 'no_access_token',
      status: response.status,
    });
    return null;
  }

  const now = Date.now();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accessTokenExpiresAt: data.expires_in ? new Date(now + data.expires_in * 1000) : null,
    refreshTokenExpiresAt: data.refresh_token_expires_in
      ? new Date(now + data.refresh_token_expires_in * 1000)
      : null,
  };
}

/**
 * Get a valid GitHub access token for a user, refreshing if needed.
 * Uses a per-user mutex to prevent race conditions with one-time-use refresh tokens.
 * Returns null when the user has no GitHub account or the refresh token is dead.
 */
export async function getGitHubTokenForUser(userId: string): Promise<GitHubTokenResult | null> {
  return withRefreshLock(userId, async () => {
    const account = await getPrisma().account.findFirst({
      where: { user_id: userId, provider_id: 'github' },
      select: {
        id: true,
        access_token: true,
        refresh_token: true,
        access_token_expires_at: true,
      },
    });

    if (!account) return null;

    // Current token still valid (with proactive buffer)?
    const isExpired =
      !account.access_token ||
      !account.access_token_expires_at ||
      new Date(account.access_token_expires_at).getTime() - Date.now() < REFRESH_BUFFER_MS;

    if (!isExpired) {
      return { token: account.access_token as string, expiresAt: account.access_token_expires_at };
    }

    // Expired or expiring soon — refresh.
    const newTokens = await refreshGitHubToken(account);
    if (!newTokens) {
      // Refresh failed — another machine may have already refreshed. Re-read DB.
      const freshAccount = await getPrisma().account.findFirst({
        where: { user_id: userId, provider_id: 'github' },
        select: { access_token: true, access_token_expires_at: true },
      });
      if (
        freshAccount?.access_token &&
        freshAccount.access_token_expires_at &&
        new Date(freshAccount.access_token_expires_at) > new Date()
      ) {
        return {
          token: freshAccount.access_token as string,
          expiresAt: freshAccount.access_token_expires_at,
        };
      }
      return null;
    }

    const updateData: Partial<
      Pick<
        PrismaAccount,
        'access_token' | 'access_token_expires_at' | 'refresh_token' | 'refresh_token_expires_at'
      >
    > = {
      access_token: newTokens.accessToken,
      access_token_expires_at: newTokens.accessTokenExpiresAt,
    };
    if (newTokens.refreshToken) updateData.refresh_token = newTokens.refreshToken;
    if (newTokens.refreshTokenExpiresAt) {
      updateData.refresh_token_expires_at = newTokens.refreshTokenExpiresAt;
    }

    await getPrisma().account.update({ where: { id: account.id }, data: updateData });

    return { token: newTokens.accessToken, expiresAt: newTokens.accessTokenExpiresAt };
  });
}

/**
 * Clear a revoked token in the DB when GitHub returns 401 "Bad credentials".
 * Pass `refusedToken` to clear only if the stored token is still that one.
 *
 * Sets `access_token` to null and `access_token_expires_at` to the epoch (NOT
 * null) so the refresh-detection above still fires on the next read — a null
 * expiry would skip refresh and lock the user out permanently.
 *
 * NOTE: this only touches the DB. The webapp's in-memory token cache is cleared
 * separately by `@classmoji/auth`'s `clearRevokedToken`, which calls this.
 */
export async function clearRevokedTokenForUser(
  userId: string,
  refusedToken?: string
): Promise<void> {
  // When the caller knows which token GitHub refused, clear only that one: a
  // token refreshed in the meantime is left alone. Tokens are stored encrypted
  // (random IV), so the comparison happens here on the decrypted value, and the
  // write is conditioned on the expiry so a refresh in between still wins.
  const accounts = await getPrisma().account.findMany({
    where: { user_id: userId, provider_id: 'github' },
    select: { id: true, access_token: true, access_token_expires_at: true },
  });
  for (const account of accounts) {
    if (refusedToken && account.access_token !== refusedToken) continue;
    await getPrisma().account.updateMany({
      where: { id: account.id, access_token_expires_at: account.access_token_expires_at },
      data: { access_token: null, access_token_expires_at: new Date(0) },
    });
  }
}
