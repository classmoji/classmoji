import { redirect } from 'react-router';

import { Alert } from 'antd';
import { auth, isGitLabAuthConfigured } from '@classmoji/auth/server';
import { authClient } from '@classmoji/auth/client';
import SignInPage from './SignInPage';
import { GithubFilled, GitlabFilled } from '@ant-design/icons';
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
    gitlabEnabled: isGitLabAuthConfigured,
  };
};

const Index = ({ loaderData }: Route.ComponentProps) => {
  const { isDev, setupComplete, multipleTokens, gitlabEnabled } = loaderData;

  const handleGitHubLogin = async () => {
    // Use BetterAuth client for OAuth flow
    await authClient.signIn.social({
      provider: 'github',
      callbackURL: '/select-organization',
    });
  };

  const handleGitLabLogin = async () => {
    await authClient.signIn.social({
      provider: 'gitlab',
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
      <div className="flex flex-col items-center justify-center h-screen bg-lightGray dark:bg-neutral-900 gap-4">
        {setupBanner}
        <div className="text-ink-3 text-sm mb-2">Development Login</div>

        <button
          onClick={handleGitHubLogin}
          className="font-bold bg-black hover:bg-neutral-800 text-white ring-1 ring-neutral-700 rounded-md px-6 py-3 min-w-[200px] flex items-center justify-center gap-2 cursor-pointer"
        >
          <GithubFilled style={{ fontSize: 20 }} />
          Continue with GitHub
        </button>

        {gitlabEnabled && (
          <button
            onClick={handleGitLabLogin}
            className="font-bold bg-white dark:bg-neutral-900 text-gray-900 dark:text-white ring-1 ring-gray-300 dark:ring-neutral-700 hover:bg-gray-50 dark:hover:bg-neutral-800 rounded-md px-6 py-3 min-w-[200px] flex items-center justify-center gap-2 cursor-pointer"
          >
            <GitlabFilled style={{ fontSize: 20, color: '#FC6D26' }} />
            Continue with GitLab
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
        handleGitHubLogin={handleGitHubLogin}
        handleGitLabLogin={handleGitLabLogin}
        gitlabEnabled={gitlabEnabled}
      />
    </>
  );
};

export default Index;
