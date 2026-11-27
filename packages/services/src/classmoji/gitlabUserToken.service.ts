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
import { parseGitlabId } from '@classmoji/utils';
import type { Account as PrismaAccount } from '@classmoji/database/client';
import { reportError, type ErrorReportLevel } from '@classmoji/utils/error-report';
import { GitLabInstanceError, gitlabFetch, oauthClient } from './gitlabInstance.service.ts';

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

/** The OAuth `error` code in GitLab's refusal body (`invalid_grant`), else undefined. */
function errorCode(detail: string): string | undefined {
  try {
    const code = (JSON.parse(detail) as { error?: unknown } | null)?.error;
    return typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/** An instance that was removed, is still waiting for approval, or is turned off. */
const isGoneInstance = (error: unknown): boolean =>
  error instanceof GitLabInstanceError &&
  (error.code === 'not_found' || error.code === 'pending' || error.code === 'disabled');

/**
 * Report a failed refresh. `invalid_grant` (the person must sign in again, or
 * another machine used the token first) and an instance that is gone are
 * expected, so warnings; anything else is an error. Never the tokens or
 * GitLab's text.
 */
function reportRefreshFailure(
  error: unknown,
  tags: { reason: string; status?: number; code?: string },
  expected = tags.code === 'invalid_grant'
): void {
  const level: ErrorReportLevel = expected ? 'warning' : 'error';
  reportError(error, { surface: 'gitlab.token_refresh', level, tags });
}

async function refreshGitLabToken(
  account: Pick<PrismaAccount, 'refresh_token' | 'account_id'>
): Promise<RefreshedTokens | null> {
  if (!account.refresh_token) return null;

  // The account id carries its instance (see scopeGitlabId).
  let client;
  try {
    client = await oauthClient(parseGitlabId(account.account_id).instanceId, {
      allowDisabled: true,
    });
  } catch (error: unknown) {
    console.error(
      '[gitlabUserToken] No usable Gitlab OAuth client:',
      error instanceof Error ? error.message : error
    );
    reportRefreshFailure(
      error,
      {
        reason: 'no_client',
        code: error instanceof GitLabInstanceError ? error.code : undefined,
      },
      isGoneInstance(error)
    );
    return null;
  }

  const body = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: account.refresh_token,
  });

  let response: Response;
  try {
    response = await gitlabFetch(`${client.host}/oauth/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
    });
  } catch (error: unknown) {
    reportRefreshFailure(error, { reason: 'network' });
    throw error;
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    console.error(`[gitlabUserToken] GitLab token refresh failed (${response.status}): ${detail}`);
    const code = errorCode(detail);
    reportRefreshFailure(new Error(`GitLab token refresh failed: ${code ?? response.status}`), {
      reason: 'refused',
      status: response.status,
      code,
    });
    return null;
  }

  let data;
  try {
    data = await response.json();
  } catch (error: unknown) {
    reportRefreshFailure(error, { reason: 'unreadable_response', status: response.status });
    throw error;
  }
  if (!data.access_token) {
    console.error('[gitlabUserToken] GitLab token refresh returned no access_token');
    reportRefreshFailure(new Error('GitLab token refresh returned no access_token'), {
      reason: 'no_access_token',
      status: response.status,
    });
    return null;
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token, // rotates on every refresh
    accessTokenExpiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
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
        account_id: true,
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
