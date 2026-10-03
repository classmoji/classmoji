import { useState, type FormEvent, type ReactNode } from 'react';
import { authClient } from '@classmoji/auth/client';
import { Emoji } from '~/components';
import GitHubIcon from './github.svg';
import GitLabIcon from '~/components/ui/display/gitlab.svg';

type Mode = 'sign-in' | 'sign-up' | 'verify' | 'forgot' | 'reset';

interface SignInPageProps {
  handleGitHubLogin: () => void;
  /** Where to land after signing in (already validated by the loader). */
  callbackURL: string;
  /** A better-auth OAuth error code from `?error=`, if the last attempt failed. */
  oauthError?: string | null;
  children?: ReactNode;
}

const OAUTH_ERRORS: Record<string, string> = {
  account_not_linked:
    'An account with this email already exists. Sign in with your email and password, then connect Github from your account.',
  account_already_linked_to_different_user:
    'That Github account is already connected to another Classmoji account.',
};

const inputClass =
  'w-full rounded-lg border border-stone-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary';

const primaryButtonClass =
  'w-full bg-primary hover:bg-primary/90 disabled:opacity-60 text-white font-medium rounded-lg px-4 py-2.5 transition-colors cursor-pointer disabled:cursor-default';

const linkClass = 'text-gray-900 dark:text-gray-100 hover:underline cursor-pointer';

const errorMessage = (error: { message?: string; code?: string } | null | undefined) =>
  error?.message || 'Something went wrong. Please try again.';

const SignInPage = ({ handleGitHubLogin, callbackURL, oauthError, children }: SignInPageProps) => {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [schoolId, setSchoolId] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(
    oauthError ? (OAUTH_ERRORS[oauthError] ?? 'Sign-in failed. Please try again.') : null
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const go = (next: Mode, message: string | null = null) => {
    setMode(next);
    setError(null);
    setNotice(message);
    setCode('');
  };

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };

  const onSignIn = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const { error: signInError } = await authClient.signIn.email({
        email,
        password,
        callbackURL,
      });
      if (!signInError) {
        window.location.href = callbackURL;
        return;
      }
      if (signInError.status === 403) {
        // Unverified: a fresh code was just mailed.
        go('verify', `We sent a code to ${email}. Enter it to finish signing in.`);
        return;
      }
      setError(errorMessage(signInError));
    });
  };

  const onSignUp = (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      setError('The passwords do not match.');
      return;
    }
    void run(async () => {
      const { error: signUpError } = await authClient.signUp.email({
        name,
        email,
        password,
        callbackURL,
        ...(schoolId.trim() ? { school_id: schoolId.trim() } : {}),
      } as Parameters<typeof authClient.signUp.email>[0]);
      if (signUpError) {
        setError(errorMessage(signUpError));
        return;
      }
      go('verify', `We sent a 6-digit code to ${email}.`);
    });
  };

  const onVerify = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const { error: verifyError } = await authClient.emailOtp.verifyEmail({ email, otp: code });
      if (verifyError) {
        setError(errorMessage(verifyError));
        return;
      }
      window.location.href = callbackURL;
    });
  };

  const onResendVerification = () =>
    run(async () => {
      const { error: sendError } = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: 'email-verification',
      });
      if (sendError) setError(errorMessage(sendError));
      else setNotice(`We sent a new code to ${email}.`);
    });

  const onForgot = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const { error: sendError } = await authClient.forgetPassword.emailOtp({ email });
      if (sendError) {
        setError(errorMessage(sendError));
        return;
      }
      go('reset', `If ${email} has an account, we sent it a code.`);
    });
  };

  const onReset = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const { error: resetError } = await authClient.emailOtp.resetPassword({
        email,
        otp: code,
        password,
      });
      if (resetError) {
        setError(errorMessage(resetError));
        return;
      }
      setPassword('');
      go('sign-in', 'Password updated. Sign in with your new password.');
    });
  };

  const title: Record<Mode, string> = {
    'sign-in': 'Sign in to Classmoji',
    'sign-up': 'Create your account',
    verify: 'Check your email',
    forgot: 'Reset your password',
    reset: 'Choose a new password',
  };

  return (
    <div className="min-h-screen bg-[#fafaf9] dark:bg-neutral-950 flex flex-col">
      <main className="flex-1 flex items-center justify-center px-4">
        <div className="w-full max-w-xs">
          {children}
          <div className="flex justify-center mb-3">
            <Emoji emoji="apple" fontSize="48px" logo />
          </div>

          <h1 className="text-xl font-semibold text-gray-900 dark:text-white text-center mb-6">
            {title[mode]}
          </h1>

          {error && (
            <div className="mb-4 rounded-lg bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 text-sm px-3 py-2">
              {error}
            </div>
          )}
          {notice && !error && (
            <div className="mb-4 rounded-lg bg-stone-100 dark:bg-neutral-900 text-gray-700 dark:text-gray-300 text-sm text-center px-3 py-2">
              {notice}
            </div>
          )}

          {(mode === 'sign-in' || mode === 'sign-up') && (
            <>
              <button
                onClick={handleGitHubLogin}
                className="w-full flex items-center justify-center gap-2 bg-gray-900 hover:bg-gray-800 dark:bg-white dark:hover:bg-gray-100 text-white dark:text-gray-900 font-medium rounded-lg px-4 py-2.5 transition-colors cursor-pointer"
              >
                <img src={GitHubIcon} alt="" className="w-5 h-5 dark:invert" />
                Continue with Github
              </button>
              <button
                type="button"
                disabled
                className="mt-2 w-full flex items-center justify-center gap-2 border border-stone-200 dark:border-neutral-800 bg-transparent text-gray-400 dark:text-gray-500 font-medium rounded-lg px-4 py-2.5 cursor-not-allowed"
              >
                <img src={GitLabIcon} alt="" className="w-5 h-5 opacity-60" />
                Continue with Gitlab
              </button>
              <p className="mt-1.5 text-center text-xs text-gray-400 dark:text-gray-500">
                Gitlab integration coming soon
              </p>
              <div className="flex items-center gap-3 my-5 text-xs text-gray-400 dark:text-gray-500">
                <div className="h-px flex-1 bg-stone-200 dark:bg-neutral-800" />
                or
                <div className="h-px flex-1 bg-stone-200 dark:bg-neutral-800" />
              </div>
            </>
          )}

          {mode === 'sign-in' && (
            <form onSubmit={onSignIn} className="flex flex-col gap-3">
              <input
                className={inputClass}
                type="email"
                autoComplete="email"
                placeholder="Email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
              />
              <input
                className={inputClass}
                type="password"
                autoComplete="current-password"
                placeholder="Password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
              />
              <button type="submit" className={primaryButtonClass} disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
              <div className="flex justify-between text-sm">
                <button type="button" className={linkClass} onClick={() => go('forgot')}>
                  Forgot password?
                </button>
                <button type="button" className={linkClass} onClick={() => go('sign-up')}>
                  Create account
                </button>
              </div>
            </form>
          )}

          {mode === 'sign-up' && (
            <form onSubmit={onSignUp} className="flex flex-col gap-3">
              <input
                className={inputClass}
                autoComplete="name"
                placeholder="Full name"
                value={name}
                onChange={e => setName(e.target.value)}
                required
              />
              <input
                className={inputClass}
                type="email"
                autoComplete="email"
                placeholder="School email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
              />
              <input
                className={inputClass}
                type="password"
                autoComplete="new-password"
                placeholder="Password (8+ characters)"
                minLength={8}
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
              />
              <input
                className={inputClass}
                type="password"
                autoComplete="new-password"
                placeholder="Confirm password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                required
              />
              <input
                className={inputClass}
                placeholder="School ID (optional)"
                value={schoolId}
                onChange={e => setSchoolId(e.target.value)}
              />
              <button type="submit" className={primaryButtonClass} disabled={busy}>
                {busy ? 'Creating account…' : 'Create account'}
              </button>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                You will connect your Github account before creating or joining a classroom.
              </p>
              <button
                type="button"
                className={`${linkClass} text-sm`}
                onClick={() => go('sign-in')}
              >
                Already have an account? Sign in
              </button>
            </form>
          )}

          {mode === 'verify' && (
            <form onSubmit={onVerify} className="flex flex-col gap-3">
              <input
                className={`${inputClass} text-center tracking-widest font-mono text-lg`}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6-digit code"
                maxLength={6}
                value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
                required
              />
              <button type="submit" className={primaryButtonClass} disabled={busy}>
                {busy ? 'Verifying…' : 'Verify email'}
              </button>
              <div className="flex justify-between text-sm">
                <button type="button" className={linkClass} onClick={onResendVerification}>
                  Send a new code
                </button>
                <button type="button" className={linkClass} onClick={() => go('sign-in')}>
                  Back
                </button>
              </div>
            </form>
          )}

          {mode === 'forgot' && (
            <form onSubmit={onForgot} className="flex flex-col gap-3">
              <input
                className={inputClass}
                type="email"
                autoComplete="email"
                placeholder="Email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
              />
              <button type="submit" className={primaryButtonClass} disabled={busy}>
                {busy ? 'Sending…' : 'Send reset code'}
              </button>
              <button
                type="button"
                className={`${linkClass} text-sm`}
                onClick={() => go('sign-in')}
              >
                Back to sign in
              </button>
            </form>
          )}

          {mode === 'reset' && (
            <form onSubmit={onReset} className="flex flex-col gap-3">
              <input
                className={`${inputClass} text-center tracking-widest font-mono text-lg`}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6-digit code"
                maxLength={6}
                value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
                required
              />
              <input
                className={inputClass}
                type="password"
                autoComplete="new-password"
                placeholder="New password (8+ characters)"
                minLength={8}
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
              />
              <button type="submit" className={primaryButtonClass} disabled={busy}>
                {busy ? 'Saving…' : 'Set new password'}
              </button>
              <button
                type="button"
                className={`${linkClass} text-sm`}
                onClick={() => go('sign-in')}
              >
                Back to sign in
              </button>
            </form>
          )}
        </div>
      </main>

      <footer className="py-6 text-center text-sm text-ink-3">
        © {new Date().getFullYear()} Classmoji
      </footer>
    </div>
  );
};

export default SignInPage;
