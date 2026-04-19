import { redirect } from 'react-router';

import { Alert } from 'antd';
import { auth } from '@classmoji/auth/server';
import { authClient } from '@classmoji/auth/client';
import SignInPage from './SignInPage';
import type { Route } from './+types/route';

export const loader = async ({ request }: Route.LoaderArgs) => {
  const session = await auth.api.getSession({ headers: request.headers });

  if (session?.user) {
    return redirect('/select-organization');
  }

  const url = new URL(request.url);
  return {
    isDev: process.env.NODE_ENV === 'development',
    multipleTokens: process.env.MULTIPLE_TOKENS === 'true',
    setupComplete: url.searchParams.get('setup') === 'complete',
  };
};

const Index = ({ loaderData }: Route.ComponentProps) => {
  const { isDev, setupComplete, multipleTokens } = loaderData;

  const handleGitHubLogin = async () => {
    // Use BetterAuth client for OAuth flow
    await authClient.signIn.social({
      provider: 'github',
      callbackURL: '/select-organization',
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
      <div className="flex flex-col items-center justify-center h-screen bg-bg-0 gap-4">
        {setupBanner}
        <div className="text-ink-2 text-xs uppercase tracking-wide mb-2">Development Login</div>

        <button
          onClick={handleGitHubLogin}
          className="btn btn-primary min-w-[200px] justify-center"
        >
          GitHub OAuth
        </button>

        {multipleTokens && (
          <>
            <div className="flex gap-3 mt-4">
              <button
                onClick={() => (window.location.href = '/test-login?role=owner')}
                className="btn btn-sm"
              >
                Owner
              </button>
              <button
                onClick={() => (window.location.href = '/test-login?role=instructor')}
                className="btn btn-sm"
              >
                Instructor
              </button>
              <button
                onClick={() => (window.location.href = '/test-login?role=ta')}
                className="btn btn-sm"
              >
                TA
              </button>
              <button
                onClick={() => (window.location.href = '/test-login?role=student')}
                className="btn btn-sm"
              >
                Student
              </button>
            </div>

            <div className="text-ink-3 text-xs mt-2">
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
