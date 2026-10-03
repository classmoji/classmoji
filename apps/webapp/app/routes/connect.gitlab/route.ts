import { createHash, randomBytes } from 'node:crypto';
import { redirect } from 'react-router';
import { requireAuth } from '@classmoji/auth/server';
import { ClassmojiService } from '@classmoji/services';
import {
  gitlabConnectCookie,
  gitlabConnectRedirectUri,
  safeReturnTo,
  type GitLabConnectState,
} from '~/utils/gitlabConnect.server';
import { gitlabInstanceForUser } from '~/utils/gitlabInstance.server';
import type { Route } from './+types/route';

/**
 * GET /connect/gitlab: send the signed-in user to GitLab to grant Classmoji
 * `api` access to their groups, the counterpart of installing the Github App.
 * Separate from GitLab sign-in, which only ever asks for `read_user`.
 *
 * The grant is on the instance the user signs in with (their school's GitLab,
 * or gitlab.com), through that instance's OAuth application.
 */
export const loader = async ({ request }: Route.LoaderArgs) => {
  const { userId } = await requireAuth(request);
  const instanceId = (await gitlabInstanceForUser(userId)) ?? null;
  let client;
  try {
    client = await ClassmojiService.gitlabInstance.oauthClient(instanceId);
  } catch {
    throw new Response('Gitlab is not configured', { status: 404 });
  }

  const verifier = randomBytes(32).toString('base64url');
  const payload: GitLabConnectState = {
    state: randomBytes(16).toString('base64url'),
    verifier,
    userId,
    returnTo: safeReturnTo(new URL(request.url).searchParams.get('returnTo')),
    instanceId,
  };

  const authorize = new URL(`${client.host}/oauth/authorize`);
  authorize.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: gitlabConnectRedirectUri(),
    response_type: 'code',
    scope: ClassmojiService.gitlabConnection.CONNECTION_SCOPES.join(' '),
    state: payload.state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  return redirect(authorize.toString(), {
    headers: { 'Set-Cookie': await gitlabConnectCookie.serialize(payload) },
  });
};
