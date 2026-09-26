import { data, redirect } from 'react-router';

import { Alert } from 'antd';
import { auth } from '@classmoji/auth/server';
import getPrisma from '@classmoji/database';
import { isSafeRelativePath } from '@classmoji/auth/site-return';
import { authClient } from '@classmoji/auth/client';
import SignInPage from './SignInPage';
import GitHubIcon from './github.svg';
import GitLabIcon from '~/components/ui/display/gitlab.svg';
import type { Route } from './+types/route';

/**
 * `?redirect=` is honoured for RELATIVE PATHS ONLY, and generously bounded
 * because /site-return carries a signed token in its query string.
 *
 * Absolute URLs are never honoured — not even to hosts we own. A course site
 * that wants a visitor back sends them through /site-return with a signed
 * token, which is re-verified and re-checked against the database; that is the
 * one and only cross-origin mechanism. Widening this parameter would quietly
 * become a second, unauthenticated one.
 */
const REDIRECT_PARAM_MAX_LENGTH = 1024;

/**
 * better-auth sends a failed OAuth sign-in back here with `?error=<code>`
 * (the `errorCallbackURL` below). Only known codes get a sentence; anything
 * else gets a generic one, so the query string never becomes page copy.
 */
const SIGN_IN_ERRORS: Record<string, string> = {
  // Implicit linking is off: an email match never merges accounts.
  account_not_linked:
    'You already have a Classmoji account with this email. Sign in the way you usually do, then connect this account in Settings.',
  access_denied: 'Sign-in was cancelled.',
};

function signInErrorMessage(code: string | null): string | null {
  if (!code) return null;
  return SIGN_IN_ERRORS[code] ?? 'Sign-in failed. Please try again.';
}

export const loader = async ({ request }: Route.LoaderArgs) => {
  const url = new URL(request.url);

  // Validated here, in the loader, and handed to the component already safe —
  // so there is exactly one place that decides what this parameter may contain.
  const requestedRedirect = url.searchParams.get('redirect');
  const redirectPath = isSafeRelativePath(requestedRedirect, REDIRECT_PARAM_MAX_LENGTH)
    ? requestedRedirect
    : null;

  const session = await auth.api.getSession({ headers: request.headers });

  if (session?.user) {
    // A session can outlive its user: the cookie cache serves it for up to a
    // day after the row is gone (deleted account, dev DB reset). Sending that
    // browser into the app loops it between here, the picker, and
    // registration, so end the session instead and show the sign-in page.
    const exists = await getPrisma().user.findUnique({
      where: { id: session.user.id },
      select: { id: true },
    });
    if (!exists) {
      const signOut = await auth.api.signOut({ headers: request.headers, returnHeaders: true });
      // Render sign-in directly with the cookie-clearing headers, rather than
      // redirecting to ourselves and trusting the cookies to have cleared.
      return data(
        {
          isDev: process.env.NODE_ENV === 'development',
          multipleTokens: process.env.MULTIPLE_TOKENS === 'true',
          gitlabEnabled: Boolean(process.env.GITLAB_CLIENT_ID),
          signInError: null,
          setupComplete: false,
          redirectPath,
        },
        { headers: signOut.headers }
      );
    }

    // Already signed in: honour the destination they were headed for, e.g. an
    // in-flight /site-return?token=… bounce.
    return redirect(redirectPath ?? '/select-organization');
  }

  return {
    isDev: process.env.NODE_ENV === 'development',
    multipleTokens: process.env.MULTIPLE_TOKENS === 'true',
    // Mirrors the server: the GitLab provider is only registered when configured.
    gitlabEnabled: Boolean(process.env.GITLAB_CLIENT_ID),
    signInError: signInErrorMessage(url.searchParams.get('error')),
    setupComplete: url.searchParams.get('setup') === 'complete',
    redirectPath,
  };
};

const Index = ({ loaderData }: Route.ComponentProps) => {
  const { isDev, setupComplete, multipleTokens, gitlabEnabled, signInError, redirectPath } =
    loaderData;

  // Use BetterAuth client for OAuth flow. `redirectPath` was validated in the
  // loader; it is null unless it is a safe relative path.
  const signInWith = (provider: 'github' | 'gitlab') => async () => {
    await authClient.signIn.social({
      provider,
      callbackURL: redirectPath ?? '/select-organization',
      errorCallbackURL: '/',
    });
  };
  const handleGitHubLogin = signInWith('github');
  const handleGitLabLogin = gitlabEnabled ? signInWith('gitlab') : undefined;

  const errorBanner = signInError && (
    <Alert type="warning" showIcon message={signInError} className="max-w-md" />
  );

  const setupBanner = setupComplete && (
    <Alert
      type="success"
      message="Github App configured successfully."
      description="Stop the server (Ctrl+C) and restart it, then sign in."
    />
  );

  // In development, show quick login buttons for each role
  if (isDev) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-lightGray dark:bg-neutral-900 gap-4">
        {setupBanner}
        {errorBanner}
        <div className="text-ink-3 text-sm mb-2">Development Login</div>

        <button
          onClick={handleGitHubLogin}
          className="flex items-center justify-center gap-2 font-bold bg-black text-white dark:ring-1 dark:ring-neutral-700 rounded-md px-6 py-3 min-w-[200px] cursor-pointer"
        >
          <img src={GitHubIcon} alt="" className="w-5 h-5" />
          Continue with Github
        </button>

        {handleGitLabLogin && (
          <button
            onClick={handleGitLabLogin}
            className="flex items-center justify-center gap-2 font-bold bg-white dark:bg-neutral-800 text-gray-900 dark:text-white ring-1 ring-stone-200 dark:ring-neutral-700 rounded-md px-6 py-3 min-w-[200px] cursor-pointer"
          >
            <img src={GitLabIcon} alt="" className="w-5 h-5" />
            Continue with Gitlab
          </button>
        )}

        {multipleTokens && (
          <>
            <div className="flex gap-3 mt-4">
              <button
                onClick={() => (window.location.href = '/test-login?role=owner')}
                className="font-medium bg-violet-500/80 hover:bg-violet-500 text-white rounded-md px-4 py-2 text-sm cursor-pointer"
              >
                Owner
              </button>
              <button
                onClick={() => (window.location.href = '/test-login?role=instructor')}
                className="font-medium bg-amber-500/80 hover:bg-amber-500 text-white rounded-md px-4 py-2 text-sm cursor-pointer"
              >
                Instructor
              </button>
              <button
                onClick={() => (window.location.href = '/test-login?role=ta')}
                className="font-medium bg-sky-500/80 hover:bg-sky-500 text-white rounded-md px-4 py-2 text-sm cursor-pointer"
              >
                TA
              </button>
              <button
                onClick={() => (window.location.href = '/test-login?role=student')}
                className="font-medium bg-primary/80 hover:bg-primary text-white rounded-md px-4 py-2 text-sm cursor-pointer"
              >
                Student
              </button>
            </div>

            <div className="text-ink-4 text-xs mt-2">
              Quick login uses test tokens from environment
            </div>
          </>
        )}
      </div>
    );
  }

  // Staging: single OAuth button
  return (
    <>
      {setupBanner}
      <SignInPage
        error={signInError}
        handleGitHubLogin={handleGitHubLogin}
        handleGitLabLogin={handleGitLabLogin}
      />
    </>
  );
};

export default Index;
