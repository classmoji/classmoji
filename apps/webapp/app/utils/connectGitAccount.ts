import { authClient } from '@classmoji/auth/client';

/**
 * Starting the "connect your git account" redirect from the browser, for
 * Github, gitlab.com, or a school's own Gitlab. Each one leaves the page on
 * success; a returned string is why it could not start.
 */

export const connectGithub = async (callbackURL: string): Promise<string | null> => {
  await authClient.linkSocial({ provider: 'github', callbackURL, errorCallbackURL: callbackURL });
  return null;
};

/** gitlab.com, through better-auth's own provider. */
export const connectDefaultGitlab = async (callbackURL: string): Promise<string | null> => {
  await authClient.linkSocial({ provider: 'gitlab', callbackURL, errorCallbackURL: callbackURL });
  return null;
};

/** A self-managed Gitlab Classmoji knows, through the gitlab-instance plugin. */
export const connectGitlabInstance = async (
  instanceId: string,
  callbackURL: string
): Promise<string | null> => {
  const response = await fetch('/api/auth/gitlab-instance/link', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId, callbackURL, errorCallbackURL: callbackURL }),
  });
  const body = (await response.json().catch(() => null)) as {
    url?: string;
    message?: string;
  } | null;
  if (response.ok && body?.url) {
    window.location.href = body.url;
    return null;
  }
  return body?.message ?? 'Could not start connecting Gitlab.';
};

/**
 * The Gitlab a classroom lives on, by its address (a git organization's
 * `base_url`; empty means gitlab.com): looked up, then connected.
 */
export const connectGitlabAt = async (
  host: string | null | undefined,
  callbackURL: string
): Promise<string | null> => {
  if (!host) return connectDefaultGitlab(callbackURL);
  const response = await fetch(`/api/gitlab-instances/lookup?host=${encodeURIComponent(host)}`);
  const body = (await response.json().catch(() => null)) as
    | { status: 'ok'; instance: { id: string | null; host: string } }
    | { status: string }
    | null;
  if (body?.status === 'ok' && 'instance' in body) {
    return body.instance.id === null
      ? connectDefaultGitlab(callbackURL)
      : connectGitlabInstance(body.instance.id, callbackURL);
  }
  return body?.status === 'disabled'
    ? 'This Gitlab is turned off on Classmoji right now. Ask your instructor.'
    : 'Could not find this Gitlab on Classmoji. Ask your instructor.';
};
