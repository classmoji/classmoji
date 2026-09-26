import { Emoji } from '~/components';
import GitHubIcon from './github.svg';
import GitLabIcon from '~/components/ui/display/gitlab.svg';

interface SignInPageProps {
  handleGitHubLogin: () => void;
  /** Absent when GitLab sign-in is not configured on this deployment. */
  handleGitLabLogin?: () => void;
  /** A failed sign-in, already turned into a sentence by the loader. */
  error?: string | null;
}

const SignInPage = ({ handleGitHubLogin, handleGitLabLogin, error }: SignInPageProps) => {
  return (
    <div className="min-h-screen bg-[#fafaf9] dark:bg-neutral-950 flex flex-col">
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

          {error && (
            <p className="mb-4 rounded-lg bg-amber-50 dark:bg-amber-900/20 ring-1 ring-amber-200 dark:ring-amber-800 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
              {error}
            </p>
          )}

          {/* GitHub OAuth button */}
          <button
            onClick={handleGitHubLogin}
            className="w-full flex items-center justify-center gap-2 bg-primary hover:bg-primary/90 text-white font-medium rounded-lg px-4 py-2.5 transition-colors cursor-pointer"
          >
            <img src={GitHubIcon} alt="GitHub" className="w-5 h-5" />
            Continue with GitHub
          </button>

          {handleGitLabLogin && (
            <button
              onClick={handleGitLabLogin}
              className="mt-3 w-full flex items-center justify-center gap-2 bg-white hover:bg-stone-50 dark:bg-neutral-900 dark:hover:bg-neutral-800 text-gray-900 dark:text-white ring-1 ring-stone-200 dark:ring-neutral-700 font-medium rounded-lg px-4 py-2.5 transition-colors cursor-pointer"
            >
              <img src={GitLabIcon} alt="Gitlab" className="w-5 h-5" />
              Continue with Gitlab
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
