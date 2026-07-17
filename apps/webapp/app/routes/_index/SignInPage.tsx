import { GithubFilled, GitlabFilled } from '@ant-design/icons';
import { Emoji } from '~/components';

interface SignInPageProps {
  handleGitHubLogin: () => void;
  handleGitLabLogin?: () => void;
  gitlabEnabled?: boolean;
}

const SignInPage = ({
  handleGitHubLogin,
  handleGitLabLogin,
  gitlabEnabled = false,
}: SignInPageProps) => {
  return (
    <div className="min-h-screen bg-[#fdfdfd] dark:bg-neutral-950 flex flex-col">
      {/* Main content */}
      <main className="flex-1 flex items-center justify-center px-4">
        <div className="w-64">
          {/* Logo - just the apple */}
          <div className="flex justify-center mb-3">
            <Emoji emoji="apple" fontSize="48px" logo />
          </div>

          {/* Sign-in card */}
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white text-center mb-6">
            Sign in to Classmoji
          </h1>

          {/* GitHub OAuth button */}
          <button
            onClick={handleGitHubLogin}
            className="w-full flex items-center justify-center gap-2 bg-primary hover:bg-primary/90 text-white font-medium rounded-lg px-4 py-2.5 transition-colors cursor-pointer"
          >
            <GithubFilled style={{ fontSize: 20 }} />
            Continue with GitHub
          </button>

          {/* GitLab OAuth button (only when configured) */}
          {gitlabEnabled && handleGitLabLogin && (
            <button
              onClick={handleGitLabLogin}
              className="mt-3 w-full flex items-center justify-center gap-2 bg-white dark:bg-neutral-900 text-gray-900 dark:text-white font-medium rounded-lg px-4 py-2.5 ring-1 ring-gray-300 dark:ring-neutral-700 hover:bg-gray-50 dark:hover:bg-neutral-800 transition-colors cursor-pointer"
            >
              <GitlabFilled style={{ fontSize: 20, color: '#FC6D26' }} />
              Continue with GitLab
            </button>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="py-6 text-center text-sm text-ink-3">
        © {new Date().getFullYear()} Classmoji
      </footer>
    </div>
  );
};

export default SignInPage;
