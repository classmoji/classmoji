import { redirect } from 'react-router';

import { Alert } from 'antd';
import { auth } from '@classmoji/auth/server';
import { authClient } from '@classmoji/auth/client';
import SignInPage from './SignInPage';
import type { Route } from './+types/route';

export const loader = async ({ request }: Route.LoaderArgs) => {
  const session = await auth.api.getSession({ headers: request.headers });
  const url = new URL(request.url);

  // OAuth resume: if BetterAuth bounced an unauthenticated user here for
  // login (loginPage in oauth-provider config), the URL carries the original
  // OAuth authorize params (response_type, client_id, code_challenge, etc.)
  // plus a signed `sig`. Once the user has a session, we re-trigger
  // /authorize with those exact params so BetterAuth completes the flow
  // (which will then bounce to the consent page or directly to the
  // redirect_uri with an auth code).
  const isOAuthResume =
    url.searchParams.has('response_type') &&
    url.searchParams.has('client_id') &&
    url.searchParams.has('redirect_uri');

  if (session?.user) {
    if (isOAuthResume) {
      // Forward all original OAuth params (including BetterAuth's sig) to
      // the proxy at /authorize, which forwards to /api/auth/oauth2/authorize.
      // Now the request carries the user's session cookie, so BetterAuth
      // proceeds to the consent step instead of bouncing back to loginPage.
      return redirect(`/authorize?${url.searchParams.toString()}`);
    }
    return redirect('/select-organization');
  }

  // Unauthenticated user: render sign-in page. If OAuth params are present,
  // preserve them across the GitHub OAuth round-trip so we land back here
  // and can re-enter the resume branch above.
  return {
    isDev: process.env.NODE_ENV === 'development',
    multipleTokens: process.env.MULTIPLE_TOKENS === 'true',
    setupComplete: url.searchParams.get('setup') === 'complete',
    oauthResumeQuery: isOAuthResume ? url.searchParams.toString() : null,
  };
};

const Index = ({ loaderData }: Route.ComponentProps) => {
  const { isDev, setupComplete, multipleTokens, oauthResumeQuery } = loaderData;

  const handleGitHubLogin = async () => {
    // If we got here via an OAuth authorize redirect (Claude Code, etc.),
    // bring the OAuth params back to `/` after sign-in so the loader's
    // resume branch can re-trigger /authorize with the new session cookie.
    const callbackURL = oauthResumeQuery ? `/?${oauthResumeQuery}` : '/select-organization';
    await authClient.signIn.social({
      provider: 'github',
      callbackURL,
    });
  };

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
      <div className="flex flex-col items-center justify-center h-screen bg-lightGray dark:bg-gray-900 gap-4">
        {setupBanner}
        <div className="text-gray-500 dark:text-gray-400 text-sm mb-2">Development Login</div>

        <button
          onClick={handleGitHubLogin}
          className="font-bold bg-black dark:bg-gray-200 text-white dark:text-black rounded-md px-6 py-3 min-w-[200px] text-center cursor-pointer"
        >
          GitHub OAuth
        </button>

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

            <div className="text-gray-400 dark:text-gray-500 text-xs mt-2">
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
      <SignInPage handleGitHubLogin={handleGitHubLogin} />
    </>
  );
};

export default Index;
