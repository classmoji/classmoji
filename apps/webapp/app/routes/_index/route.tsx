import { useState } from 'react';
import { data, redirect } from 'react-router';

import { Alert } from 'antd';
import { auth } from '@classmoji/auth/server';
import getPrisma from '@classmoji/database';
import { isSafeRelativePath } from '@classmoji/auth/site-return';
import { authClient } from '@classmoji/auth/client';
import SignInPage from './SignInPage';
import GitLabSignIn from './GitLabSignIn';
import { loadGitLabSignIn } from './gitlabSignIn.server';
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
          gitlab: await loadGitLabSignIn(url, redirectPath),
          setupComplete: false,
          redirectPath,
          oauthError: null,
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
    // gitlab.com (when configured) and any self-managed instances.
    gitlab: await loadGitLabSignIn(url, redirectPath),
    setupComplete: url.searchParams.get('setup') === 'complete',
    redirectPath,
    // A failed sign-in comes back here with `?error=<code>` (SignInPage words it).
    oauthError: url.searchParams.get('error'),
  };
};

const Index = ({ loaderData }: Route.ComponentProps) => {
  const { isDev, setupComplete, multipleTokens, gitlab, redirectPath, oauthError } = loaderData;

  // Use BetterAuth client for OAuth flow. `redirectPath` was validated in the
  // loader; it is null unless it is a safe relative path.
  const callbackURL = redirectPath ?? '/select-organization';
  const handleGitHubLogin = async () => {
    await authClient.signIn.social({ provider: 'github', callbackURL, errorCallbackURL: '/' });
  };
  // Sits under "Continue with Github", in the same shape.
  const gitlabButtonClass =
    'w-full flex items-center justify-center gap-2 bg-white hover:bg-stone-50 dark:bg-neutral-900 dark:hover:bg-neutral-800 text-gray-900 dark:text-white ring-1 ring-stone-200 dark:ring-neutral-700 font-medium rounded-lg px-4 py-2.5 transition-colors cursor-pointer';
  // While the Gitlab chooser is open it takes the whole column: no Github button.
  const [gitlabChoosing, setGitlabChoosing] = useState(false);
  const gitlabSignIn = (buttonClassName: string) =>
    gitlab.enabled ? (
      <GitLabSignIn
        options={gitlab}
        callbackURL={callbackURL}
        buttonClassName={buttonClassName}
        onChoosingChange={setGitlabChoosing}
      />
    ) : null;

  const setupBanner = setupComplete && (
    <Alert
      type="success"
      message="Github App configured successfully."
      description="Stop the server (Ctrl+C) and restart it, then sign in."
    />
  );

  // In development, the quick test logins sit under the regular sign-in
  if (isDev) {
    return (
      <>
        {setupBanner}
        <SignInPage
          handleGitHubLogin={handleGitHubLogin}
          callbackURL={callbackURL}
          oauthError={oauthError}
          gitlabChoosing={gitlabChoosing}
          gitlabSignIn={gitlabSignIn(gitlabButtonClass)}
        >
          <div className="mb-8 flex flex-col items-center">
            <div className="text-ink-3 text-sm mb-2">Development Login</div>
            {multipleTokens && (
              <>
                <div className="flex flex-wrap justify-center gap-2 mt-2">
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
        </SignInPage>
      </>
    );
  }

  // Deployed: the regular sign-in
  return (
    <>
      {setupBanner}
      <SignInPage
        handleGitHubLogin={handleGitHubLogin}
        callbackURL={callbackURL}
        oauthError={oauthError}
        gitlabChoosing={gitlabChoosing}
        gitlabSignIn={gitlabSignIn(gitlabButtonClass)}
      />
    </>
  );
};

export default Index;
