import { Emoji } from '~/components';
import GitHubIcon from './github.svg';

interface SignInPageProps {
  handleGitHubLogin: () => void;
}

const SignInPage = ({ handleGitHubLogin }: SignInPageProps) => {
  return (
    <div className="min-h-screen bg-bg-0 flex flex-col">
      {/* Main content */}
      <main className="flex-1 flex items-center justify-center px-4">
        <div className="panel w-80 px-8 py-10">
          {/* Logo - just the apple */}
          <div className="flex justify-center mb-4">
            <Emoji emoji="apple" fontSize="48px" logo />
          </div>

          {/* Sign-in card */}
          <h1 className="display text-2xl text-ink-0 text-center mb-8">
            Sign in to Classmoji
          </h1>

          {/* GitHub OAuth button */}
          <button
            onClick={handleGitHubLogin}
            className="btn btn-primary w-full justify-center"
          >
            <img src={GitHubIcon} alt="GitHub" className="w-5 h-5" />
            Continue with GitHub
          </button>
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
