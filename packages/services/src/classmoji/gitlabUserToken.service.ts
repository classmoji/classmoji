/**
 * Per-user GitLab access token accessor — mirror of `githubUserToken.service.ts`.
 *
 * GitLab OAuth access tokens are short-lived (2h) and refreshed with a rotating
 * refresh token (a new refresh token is returned on every refresh). Refreshes are
 * guarded by a per-user, per-process mutex so two concurrent refreshes don't race
 * and invalidate each other's rotated token.
 *
 * Unlike GitHub's OAuth endpoint (which returns HTTP 200 even for errors), GitLab
 * returns proper status codes, so we can trust `res.ok`.
 */

import getPrisma from '@classmoji/database';
import type { Account as PrismaAccount } from '@prisma/client';

export interface GitLabTokenResult {
  token: string;
  expiresAt: Date | null;
}

interface RefreshedTokens {
  accessToken: string;
  refreshToken: string | undefined;
  accessTokenExpiresAt: Date | null;
}

// Refresh this long before actual expiry so concurrent requests never serve a
// token that dies mid-flight.
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes (GitLab tokens live 2h)

// Per-user mutex — GitLab refresh tokens rotate (one-time-use), same hazard as
// GitHub App refresh tokens.
const refreshLocks = new Map<string, Promise<GitLabTokenResult | null>>();

function gitlabIssuer(): string {
  return (process.env.GITLAB_ISSUER || 'https://gitlab.com').replace(/\/+$/, '');
}

async function withRefreshLock(
  userId: string,
  fn: () => Promise<GitLabTokenResult | null>
): Promise<GitLabTokenResult | null> {
  const existing = refreshLocks.get(userId);
  if (existing) return existing;

  const promise = fn().finally(() => {
    refreshLocks.delete(userId);
  });
  refreshLocks.set(userId, promise);
  return promise;
}

async function refreshGitLabToken(
  account: Pick<PrismaAccount, 'refresh_token'>
): Promise<RefreshedTokens | null> {
  if (!account.refresh_token) return null;

  const clientId = process.env.GITLAB_CLIENT_ID;
  const clientSecret = process.env.GITLAB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('[gitlabUserToken] Missing GITLAB_CLIENT_ID or GITLAB_CLIENT_SECRET');
    return null;
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: account.refresh_token,
  });

  const response = await fetch(`${gitlabIssuer()}/oauth/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    console.error(`[gitlabUserToken] GitLab token refresh failed (${response.status}): ${detail}`);
    return null;
  }

  const data = await response.json();
  if (!data.access_token) {
    console.error('[gitlabUserToken] GitLab token refresh returned no access_token');
    return null;
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token, // rotates on every refresh
    accessTokenExpiresAt: data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000)
      : null,
  };
}

/**
 * Get a valid GitLab access token for a user, refreshing if needed.
 * Returns null when the user has no GitLab account or the refresh token is dead.
 */
export async function getGitLabTokenForUser(userId: string): Promise<GitLabTokenResult | null> {
  return withRefreshLock(userId, async () => {
    const account = await getPrisma().account.findFirst({
      where: { user_id: userId, provider_id: 'gitlab' },
      select: {
        id: true,
        access_token: true,
        refresh_token: true,
        access_token_expires_at: true,
      },
    });

    if (!account) return null;

    const isExpired =
      !account.access_token ||
      !account.access_token_expires_at ||
      new Date(account.access_token_expires_at).getTime() - Date.now() < REFRESH_BUFFER_MS;

    if (!isExpired) {
      return { token: account.access_token as string, expiresAt: account.access_token_expires_at };
    }

    const newTokens = await refreshGitLabToken(account);
    if (!newTokens) {
      // Refresh failed — another machine may have already refreshed. Re-read.
      const fresh = await getPrisma().account.findFirst({
        where: { user_id: userId, provider_id: 'gitlab' },
        select: { access_token: true, access_token_expires_at: true },
      });
      if (
        fresh?.access_token &&
        fresh.access_token_expires_at &&
        new Date(fresh.access_token_expires_at) > new Date()
      ) {
        return { token: fresh.access_token as string, expiresAt: fresh.access_token_expires_at };
      }
      return null;
    }

    const updateData: Partial<
      Pick<PrismaAccount, 'access_token' | 'access_token_expires_at' | 'refresh_token'>
    > = {
      access_token: newTokens.accessToken,
      access_token_expires_at: newTokens.accessTokenExpiresAt,
    };
    if (newTokens.refreshToken) updateData.refresh_token = newTokens.refreshToken;

    await getPrisma().account.update({ where: { id: account.id }, data: updateData });

    return { token: newTokens.accessToken, expiresAt: newTokens.accessTokenExpiresAt };
  });
}
