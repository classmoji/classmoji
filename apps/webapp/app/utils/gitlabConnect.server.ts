import { createCookie } from 'react-router';
import { AUTH_SECRET } from '@classmoji/auth/server';

/**
 * Round-trip state for "Connect GitLab" (the GitLab counterpart of installing
 * the Github App): the OAuth `state`, the PKCE verifier, who started it, and
 * where to land afterwards. Signed and short-lived; never holds a token.
 */
export const gitlabConnectCookie = createCookie('gitlab-connect', {
  path: '/connect/gitlab',
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 10 * 60,
  secrets: [AUTH_SECRET],
});

export interface GitLabConnectState {
  state: string;
  verifier: string;
  userId: string;
  returnTo: string;
}

export const gitlabConnectRedirectUri = () =>
  `${(process.env.WEBAPP_URL ?? '').replace(/\/+$/, '')}/connect/gitlab/callback`;

/** Only same-app paths; the connect flow never sends anyone off-site. */
export function safeReturnTo(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//')
    ? value
    : '/create-classroom?provider=gitlab';
}
