/**
 * GitLab connections: the `api`-scope OAuth grant Classmoji acts with on GitLab
 * groups, the counterpart of a Github App installation (see the
 * GitLabConnection model). Groups (GitOrganization rows) point at a connection;
 * every provider call for a group gets its token through
 * {@link getConnectionToken}.
 *
 * GitLab access tokens live 2h and refresh tokens are single-use, rotating on
 * every refresh. The webapp and Trigger workers are separate processes, so two
 * of them can try to refresh the same connection at once. The row write is
 * guarded on the refresh token it started from; whoever loses re-reads the row
 * and uses the winner's token instead of failing.
 */

import getPrisma from '@classmoji/database';

/** Refresh this long before expiry so a token never dies mid-request. */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/** Per-process single flight: one refresh per connection at a time. */
const refreshing = new Map<string, Promise<string | null>>();

/** OAuth host (self-managed GitLab sets GITLAB_ISSUER or GITLAB_URL). */
export function gitlabOAuthBase(): string {
  return (process.env.GITLAB_ISSUER || process.env.GITLAB_URL || 'https://gitlab.com').replace(
    /\/+$/,
    ''
  );
}

/** Scopes a connection needs: act on groups/projects and push over HTTPS. */
export const CONNECTION_SCOPES = ['api', 'read_user', 'read_repository', 'write_repository'];

interface TokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
}

async function postToken(params: Record<string, string>): Promise<TokenResponse> {
  const clientId = process.env.GITLAB_CLIENT_ID;
  const clientSecret = process.env.GITLAB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Gitlab is not configured (GITLAB_CLIENT_ID / GITLAB_CLIENT_SECRET)');
  }

  const response = await fetch(`${gitlabOAuthBase()}/oauth/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
  });
  // GitLab, unlike Github's OAuth endpoint, reports failures with real statuses.
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof data.access_token !== 'string') {
    const reason = typeof data.error === 'string' ? data.error : `status ${response.status}`;
    const error = new Error(`Gitlab token request failed: ${reason}`) as Error & { code?: string };
    error.code = typeof data.error === 'string' ? data.error : undefined;
    throw error;
  }

  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : null,
    expiresAt:
      typeof data.expires_in === 'number' ? new Date(Date.now() + data.expires_in * 1000) : null,
    scope: typeof data.scope === 'string' ? data.scope : null,
  };
}

/** Exchange the authorization code from the connect callback. */
export function exchangeCode(code: string, redirectUri: string, codeVerifier: string) {
  return postToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
}

/** The GitLab user a token belongs to. */
export async function fetchTokenUser(
  accessToken: string
): Promise<{ id: string; username: string }> {
  const response = await fetch(`${gitlabOAuthBase()}/api/v4/user`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Gitlab /user failed (${response.status})`);
  const user = (await response.json()) as { id: number; username: string };
  return { id: String(user.id), username: user.username };
}

/**
 * Store (or replace) a user's connection after they approve Classmoji on
 * GitLab. Groups already pointing at it keep working with the new tokens.
 */
export async function saveConnection(
  userId: string,
  tokens: TokenResponse,
  gitlabUser: { id: string; username: string }
) {
  const data = {
    gitlab_user_id: gitlabUser.id,
    gitlab_username: gitlabUser.username,
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    access_token_expires_at: tokens.expiresAt,
    scope: tokens.scope,
  };
  return getPrisma().gitLabConnection.upsert({
    where: { user_id: userId },
    update: data,
    create: { user_id: userId, ...data },
    select: { id: true, gitlab_user_id: true, gitlab_username: true },
  });
}

/** A user's connection, without its tokens. */
export function findForUser(userId: string) {
  return getPrisma().gitLabConnection.findUnique({
    where: { user_id: userId },
    select: { id: true, gitlab_user_id: true, gitlab_username: true, scope: true },
  });
}

const isFresh = (expiresAt: Date | null) =>
  !expiresAt || expiresAt.getTime() - Date.now() > REFRESH_BUFFER_MS;

async function refreshConnection(connectionId: string): Promise<string | null> {
  const prisma = getPrisma();
  const row = await prisma.gitLabConnection.findUnique({ where: { id: connectionId } });
  if (!row) return null;
  if (isFresh(row.access_token_expires_at)) return row.access_token;
  if (!row.refresh_token) return null;

  try {
    const tokens = await postToken({
      grant_type: 'refresh_token',
      refresh_token: row.refresh_token,
    });
    // Only write if nobody else rotated the refresh token meanwhile.
    const { count } = await prisma.gitLabConnection.updateMany({
      where: { id: connectionId, refresh_token: row.refresh_token },
      data: {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken ?? row.refresh_token,
        access_token_expires_at: tokens.expiresAt,
        ...(tokens.scope ? { scope: tokens.scope } : {}),
      },
    });
    if (count === 1) return tokens.accessToken;
  } catch (error: unknown) {
    // Another process may have used the refresh token first (GitLab then
    // answers invalid_grant). Fall through and re-read the row.
    console.warn(
      `[gitlabConnection] refresh failed for ${connectionId}:`,
      error instanceof Error ? error.message : error
    );
  }

  const latest = await prisma.gitLabConnection.findUnique({
    where: { id: connectionId },
    select: { access_token: true, access_token_expires_at: true },
  });
  if (latest && isFresh(latest.access_token_expires_at)) return latest.access_token;
  return null;
}

/**
 * A valid access token for a connection, refreshing it when due. Throws when
 * the connection is gone or its grant was revoked; the owner has to reconnect.
 */
export async function getConnectionToken(connectionId: string): Promise<string> {
  let pending = refreshing.get(connectionId);
  if (!pending) {
    pending = refreshConnection(connectionId).finally(() => refreshing.delete(connectionId));
    refreshing.set(connectionId, pending);
  }
  const token = await pending;
  if (!token) {
    throw new Error(
      'The Gitlab connection for this group has expired or was revoked. Reconnect Gitlab to continue.'
    );
  }
  return token;
}
