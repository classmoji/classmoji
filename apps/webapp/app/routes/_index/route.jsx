import { redirect } from 'react-router';

import { auth } from '@classmoji/auth/server';
import { authClient } from '@classmoji/auth/client';
import SignInPage from './SignInPage';

export const loader = async ({ request }) => {
  const session = await auth.api.getSession({ headers: request.headers });

  if (session?.user) {
    return redirect('/select-organization');
  }

  return { isDev: process.env.MODE === 'development' };
};

const Index = ({ loaderData }) => {
  const { isDev } = loaderData;

  const handleGitHubLogin = async () => {
    // Use BetterAuth client for OAuth flow
    await authClient.signIn.social({
      provider: 'github',
      callbackURL: '/select-organization',
    });
  };

  // In development, show quick login buttons for each role
  if (isDev) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-lightGray dark:bg-gray-900 gap-4">
        <div className="text-gray-500 dark:text-gray-400 text-sm mb-2">Development Login</div>

        <button
          onClick={handleGitHubLogin}
          className="font-bold bg-black dark:bg-gray-200 text-white dark:text-black rounded-md px-6 py-3 min-w-[200px] text-center cursor-pointer"
        >
          GitHub OAuth
        </button>

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
      </div>
    );
  }

  // Staging: single OAuth button
  return <SignInPage handleGitHubLogin={handleGitHubLogin} />;
};

export default Index;
