import { redirect } from 'react-router';
import { requireAuth } from '@classmoji/auth/server';
import { ClassmojiService } from '@classmoji/services';
import {
  gitlabConnectCookie,
  gitlabConnectRedirectUri,
  type GitLabConnectState,
} from '~/utils/gitlabConnect.server';
import type { Route } from './+types/route';

/** Land back on `returnTo` with `?gitlab=<outcome>`, clearing the round-trip cookie. */
async function finish(returnTo: string, outcome: string) {
  const url = new URL(returnTo, 'http://placeholder');
  url.searchParams.set('gitlab', outcome);
  return redirect(`${url.pathname}${url.search}`, {
    headers: { 'Set-Cookie': await gitlabConnectCookie.serialize('', { maxAge: 0 }) },
  });
}

/**
 * GET /connect/gitlab/callback: GitLab's redirect after the user approves (or
 * declines) the connection. Verifies the round trip belongs to this browser and
 * this user, exchanges the code, and stores the connection.
 */
export const loader = async ({ request }: Route.LoaderArgs) => {
  const { userId } = await requireAuth(request);
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

  try {
    const svc = ClassmojiService.gitlabConnection;
    const tokens = await svc.exchangeCode(code, gitlabConnectRedirectUri(), saved.verifier);
    if (!tokens.scope?.split(/[\s,]+/).includes('api')) {
      return finish(saved.returnTo, 'missing_scope');
    }
    const gitlabUser = await svc.fetchTokenUser(tokens.accessToken);
    await svc.saveConnection(userId, tokens, gitlabUser);
  } catch (error: unknown) {
    console.error(
      '[connect.gitlab] callback failed:',
      error instanceof Error ? error.message : error
    );
    return finish(saved.returnTo, 'error');
  }

  return finish(saved.returnTo, 'connected');
};
