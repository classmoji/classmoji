import { Emoji } from '~/components';
import GitHubIcon from './github.svg';

const SignInPage = ({ handleGitHubLogin }) => {
  return (
    <div className="min-h-screen dark:bg-gray-950 flex flex-col">
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
            <img src={GitHubIcon} alt="GitHub" className="w-5 h-5" />
            Continue with GitHub
          </button>
        </div>
      </main>

      {/* Footer */}
      <footer className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">
        © {new Date().getFullYear()} Classmoji
      </footer>
    </div>
  );
};

export default SignInPage;
