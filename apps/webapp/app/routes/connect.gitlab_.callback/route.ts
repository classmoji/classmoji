import { redirect } from 'react-router';
import { requireAuth } from '@classmoji/auth/server';
import { ClassmojiService } from '@classmoji/services';
import {
  gitlabConnectCookie,
  gitlabConnectRedirectUri,
  safeReturnTo,
  type GitLabConnectState,
} from '~/utils/gitlabConnect.server';
import {
  GITLAB_CONNECT_IMPERSONATION_MESSAGE,
  isImpersonatingSession,
} from '~/utils/impersonationSession';
import type { Route } from './+types/route';

/**
 * Land back on `returnTo` with `?gitlab=<outcome>`, clearing the round-trip
 * cookie. The path is checked before and after the param is added, so what is
 * sent is always a path on this app (a cookie set before the current rule
 * still carries the value it was given then).
 */
async function finish(returnTo: string, outcome: string) {
  const url = new URL(safeReturnTo(returnTo), 'http://placeholder');
  url.searchParams.set('gitlab', outcome);
  return redirect(safeReturnTo(`${url.pathname}${url.search}`), {
    headers: { 'Set-Cookie': await gitlabConnectCookie.serialize('', { maxAge: 0 }) },
  });
}

/**
 * GET /connect/gitlab/callback: GitLab's redirect after the user approves (or
 * declines) the connection. Verifies the round trip belongs to this browser and
 * this user, exchanges the code, and stores the connection.
 *
 * Not while viewing as another user: the connection would be stored on their
 * account. Refused before the code is exchanged, so nothing is stored.
 */
export const loader = async ({ request }: Route.LoaderArgs) => {
  const authData = await requireAuth(request);
  if (isImpersonatingSession(authData)) {
    throw new Response(GITLAB_CONNECT_IMPERSONATION_MESSAGE, { status: 403 });
  }
  const { userId } = authData;
  const url = new URL(request.url);
  const saved = (await gitlabConnectCookie.parse(
    request.headers.get('Cookie')
  )) as GitLabConnectState | null;

  // No cookie, a different user, or a mismatched state: not a round trip this
  // browser started. Never exchange the code.
  if (!saved || saved.userId !== userId || saved.state !== url.searchParams.get('state')) {
    return finish('/create-classroom?provider=gitlab', 'invalid_state');
  }
  if (url.searchParams.get('error')) {
    return finish(
      saved.returnTo,
      url.searchParams.get('error') === 'access_denied' ? 'denied' : 'error'
    );
  }
  const code = url.searchParams.get('code');
  if (!code) return finish(saved.returnTo, 'error');

  // One GitLab per user: replacing a connection on another instance would
  // leave that instance's groups acting with this one's tokens.
  const instanceId = saved.instanceId ?? null;
  const existing = await ClassmojiService.gitlabConnection.findForUser(userId);
  if (existing && (existing.gitlab_instance_id ?? null) !== instanceId) {
    return finish(saved.returnTo, 'other_instance');
  }

  try {
    const svc = ClassmojiService.gitlabConnection;
    const client = await ClassmojiService.gitlabInstance.oauthClient(instanceId);
    const tokens = await svc.exchangeCode(client, code, gitlabConnectRedirectUri(), saved.verifier);
    if (!tokens.scope?.split(/[\s,]+/).includes('api')) {
      return finish(saved.returnTo, 'missing_scope');
    }
    const gitlabUser = await svc.fetchTokenUser(client.host, tokens.accessToken);
    await svc.saveConnection(userId, tokens, gitlabUser, instanceId);
  } catch (error: unknown) {
    console.error(
      '[connect.gitlab] callback failed:',
      error instanceof Error ? error.message : error
    );
    return finish(saved.returnTo, 'error');
  }

  return finish(saved.returnTo, 'connected');
};
