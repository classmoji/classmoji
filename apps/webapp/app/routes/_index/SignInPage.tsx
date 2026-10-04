import { useEffect, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowLeftIcon, EyeIcon, EyeOffIcon, Loader2Icon, MailIcon } from 'lucide-react';
import { authClient } from '@classmoji/auth/client';
import { Emoji } from '~/components';
import { fieldClass, labelClass, optionButton, primaryButton, quietLink } from './signInStyles';
import siteBackdrop from './site-backdrop.jpg';

/** `providers` lists the ways in; the rest are the email flows behind "Continue with email". */
type Mode = 'providers' | 'sign-in' | 'sign-up' | 'verify' | 'forgot' | 'reset';

interface SignInPageProps {
  handleGitHubLogin: () => void;
  /** Where to land after signing in (already validated by the loader). */
  callbackURL: string;
  /** A better-auth OAuth error code from `?error=`, if the last attempt failed. */
  oauthError?: string | null;
  /** The Gitlab sign-in control; null when no Gitlab is available. */
  gitlabSignIn?: ReactNode;
  /**
   * Show classmoji.io blurred behind the card, so arriving from the site's
   * "Sign In" reads as a dialog over the page just left. Off when the visit
   * has its own context (a class invite, a school's Gitlab).
   */
  backdrop?: boolean;
  /** Shown above the card (the development quick logins). */
  children?: ReactNode;
}

/**
 * better-auth (and the Gitlab instance plugin) send a failed sign-in back here
 * with `?error=<code>`. Only known codes get a sentence; anything else gets a
 * generic one, so the query string never becomes page copy.
 */
const OAUTH_ERRORS: Record<string, string> = {
  // Implicit linking is off: an email match never merges accounts.
  account_not_linked:
    'An account with this email already exists. Sign in the way you usually do, then connect this account from your settings.',
  account_already_linked_to_different_user:
    'That account is already connected to another Classmoji account.',
  access_denied: 'Sign-in was cancelled.',
  gitlab_instance_unavailable: 'That Gitlab is no longer available for sign-in.',
  gitlab_setup_credentials:
    'Gitlab rejected that Application ID or Secret, or the callback URL on the application does not match. Check them and try again.',
  gitlab_setup_failed: 'Could not save that Gitlab. Try again.',
  email_is_missing: 'Your Gitlab account has no email address Classmoji can read.',
};

/** Where "closing" the sign-in goes when there's no page to return to. */
const PUBLIC_SITE = 'https://classmoji.io';

/**
 * Back to the page the visitor came from when it was another site (classmoji.io,
 * or the local site in development), else the public site.
 */
const leaveSignIn = () => {
  let target = PUBLIC_SITE;
  try {
    const from = document.referrer ? new URL(document.referrer) : null;
    if (from && from.origin !== window.location.origin) target = from.href;
  } catch {
    // An unreadable referrer: fall back to the public site.
  }
  window.location.href = target;
};

const errorMessage = (error: { message?: string; code?: string } | null | undefined) =>
  error?.message || 'Something went wrong. Please try again.';

const SignInPage = ({
  handleGitHubLogin,
  callbackURL,
  oauthError,
  gitlabSignIn,
  backdrop = false,
  children,
}: SignInPageProps) => {
  const reduced = useReducedMotion();
  const [mode, setMode] = useState<Mode>('providers');

  // With the backdrop the card reads as a dialog over the site, so it closes like
  // one: Escape, or a click outside the card.
  useEffect(() => {
    if (!backdrop) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') leaveSignIn();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [backdrop]);
  const onOutsideClick = (e: MouseEvent) => {
    if (backdrop && e.target === e.currentTarget) leaveSignIn();
  };
  const [showPassword, setShowPassword] = useState(false);
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

  const title: Record<Exclude<Mode, 'providers'>, string> = {
    'sign-in': 'Sign in with email',
    'sign-up': 'Create your account',
    verify: 'Check your email',
    forgot: 'Reset your password',
    reset: 'Choose a new password',
  };

  // Each screen slides in from the side it was reached from.
  const forward = mode !== 'providers';
  const motionProps = reduced
    ? {}
    : {
        initial: { opacity: 0, x: forward ? 12 : -12 },
        animate: { opacity: 1, x: 0 },
        exit: { opacity: 0, x: forward ? -12 : 12 },
        transition: { duration: 0.18, ease: [0.22, 1, 0.36, 1] as const },
      };

  const spinner = busy && <Loader2Icon className="h-4 w-4 animate-spin" aria-hidden />;

  const messages = (
    <>
      {error && (
        <div
          role="alert"
          className="mb-5 rounded-lg border border-rose-bord bg-rose-bg px-3.5 py-2.5 text-sm text-rose-ink"
        >
          {error}
        </div>
      )}
      {notice && !error && (
        <div
          role="status"
          className="mb-5 rounded-lg border border-mint-bord bg-mint-bg px-3.5 py-2.5 text-sm text-mint-ink"
        >
          {notice}
        </div>
      )}
    </>
  );

  const codeField = (
    <div>
      <label htmlFor="auth-code" className={labelClass}>
        6-digit code
      </label>
      <input
        id="auth-code"
        className={`mt-1.5 ${fieldClass} text-center font-mono text-base tracking-[0.4em]`}
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        maxLength={6}
        value={code}
        onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
        required
      />
    </div>
  );

  const emailField = (label: string, autoFocus = false) => (
    <div>
      <label htmlFor="auth-email" className={labelClass}>
        {label}
      </label>
      <input
        id="auth-email"
        className={`mt-1.5 ${fieldClass}`}
        type="email"
        autoComplete="email"
        autoFocus={autoFocus}
        placeholder="you@school.edu"
        value={email}
        onChange={e => setEmail(e.target.value)}
        required
      />
    </div>
  );

  return (
    <div
      onClick={onOutsideClick}
      className="relative isolate flex min-h-screen flex-col items-center overflow-hidden bg-[#fafaf9] px-4 py-8 dark:bg-neutral-950 sm:px-6"
    >
      {backdrop && (
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
          {/* A still of the site's home page: blurred and dimmed, it's only a hint. */}
          <img
            src={siteBackdrop}
            alt=""
            className="h-full w-full scale-110 object-cover object-top blur-xl"
          />
          <div className="absolute inset-0 bg-stone-900/25 dark:bg-neutral-950/75" />
        </div>
      )}
      <main
        onClick={onOutsideClick}
        className="flex w-full flex-1 flex-col items-center justify-center py-10"
      >
        {children}

        <div className="w-full max-w-[440px] overflow-hidden rounded-2xl bg-panel shadow-[0_1px_2px_rgba(20,10,40,0.04),0_12px_32px_-20px_rgba(20,25,50,0.22)] ring-1 ring-stone-200 dark:shadow-[0_12px_32px_-18px_rgba(0,0,0,0.6)] dark:ring-neutral-800">
          <div className="px-6 pb-8 pt-9 sm:px-8">
            <AnimatePresence mode="wait" initial={false}>
              {mode === 'providers' ? (
                <motion.div key="providers" {...motionProps}>
                  <h1 className="flex items-center justify-center gap-2.5 text-center text-2xl font-bold leading-tight tracking-tight text-ink-0">
                    <Emoji emoji="apple" fontSize="30px" logo />
                    Sign in to Classmoji
                  </h1>
                  <p className="mt-2 text-center text-sm text-ink-2">
                    Use the account your class runs on.
                  </p>

                  <div className="mt-8">
                    {messages}
                    <div className="flex flex-col gap-3">
                      <button type="button" onClick={handleGitHubLogin} className={optionButton}>
                        <svg viewBox="0 0 16 16" aria-hidden className="h-4 w-4 fill-current">
                          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                        </svg>
                        Continue with Github
                      </button>
                      {gitlabSignIn}
                    </div>

                    <div
                      className="my-3 flex items-center gap-4 text-sm text-ink-3"
                      role="separator"
                    >
                      <span className="h-px flex-1 bg-line" />
                      or
                      <span className="h-px flex-1 bg-line" />
                    </div>

                    <button type="button" onClick={() => go('sign-in')} className={optionButton}>
                      <MailIcon className="h-4 w-4 text-ink-2" aria-hidden />
                      Continue with email
                    </button>
                  </div>
                </motion.div>
              ) : (
                <motion.div key={mode} {...motionProps}>
                  <button
                    type="button"
                    onClick={() =>
                      go(mode === 'reset' || mode === 'forgot' ? 'sign-in' : 'providers')
                    }
                    className="-ml-1 inline-flex items-center gap-1.5 rounded-md px-1 text-sm font-medium text-ink-3 transition-colors duration-150 hover:text-ink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent cursor-pointer"
                  >
                    <ArrowLeftIcon className="h-4 w-4" aria-hidden />
                    {mode === 'reset' || mode === 'forgot'
                      ? 'Back to sign in'
                      : 'Other sign-in options'}
                  </button>
                  <h1 className="mt-4 text-xl font-semibold leading-tight tracking-tight text-ink-0">
                    {title[mode]}
                  </h1>

                  <div className="mt-7">
                    {messages}

                    {mode === 'sign-in' && (
                      <form onSubmit={onSignIn} className="flex flex-col gap-4">
                        {emailField('Email', true)}
                        <div>
                          <div className="flex items-center justify-between">
                            <label htmlFor="auth-password" className={labelClass}>
                              Password
                            </label>
                            <button
                              type="button"
                              className={quietLink}
                              onClick={() => go('forgot')}
                            >
                              Forgot password?
                            </button>
                          </div>
                          <div className="relative mt-1.5">
                            <input
                              id="auth-password"
                              className={`${fieldClass} pr-11`}
                              type={showPassword ? 'text' : 'password'}
                              autoComplete="current-password"
                              value={password}
                              onChange={e => setPassword(e.target.value)}
                              required
                            />
                            <button
                              type="button"
                              onClick={() => setShowPassword(v => !v)}
                              aria-label={showPassword ? 'Hide password' : 'Show password'}
                              aria-pressed={showPassword}
                              className="absolute right-1.5 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-md text-ink-3 transition-colors duration-150 hover:text-ink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent cursor-pointer"
                            >
                              {showPassword ? (
                                <EyeOffIcon className="h-4 w-4" aria-hidden />
                              ) : (
                                <EyeIcon className="h-4 w-4" aria-hidden />
                              )}
                            </button>
                          </div>
                        </div>
                        <button type="submit" className={primaryButton} disabled={busy}>
                          {spinner}
                          {busy ? 'Signing in' : 'Sign in'}
                        </button>
                      </form>
                    )}

                    {mode === 'sign-up' && (
                      <form onSubmit={onSignUp} className="flex flex-col gap-4">
                        <div>
                          <label htmlFor="auth-name" className={labelClass}>
                            Full name
                          </label>
                          <input
                            id="auth-name"
                            className={`mt-1.5 ${fieldClass}`}
                            autoComplete="name"
                            autoFocus
                            value={name}
                            onChange={e => setName(e.target.value)}
                            required
                          />
                        </div>
                        {emailField('School email')}
                        <div>
                          <label htmlFor="auth-new-password" className={labelClass}>
                            Password
                          </label>
                          <input
                            id="auth-new-password"
                            className={`mt-1.5 ${fieldClass}`}
                            type="password"
                            autoComplete="new-password"
                            placeholder="8+ characters"
                            minLength={8}
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            required
                          />
                        </div>
                        <div>
                          <label htmlFor="auth-confirm-password" className={labelClass}>
                            Confirm password
                          </label>
                          <input
                            id="auth-confirm-password"
                            className={`mt-1.5 ${fieldClass}`}
                            type="password"
                            autoComplete="new-password"
                            value={confirmPassword}
                            onChange={e => setConfirmPassword(e.target.value)}
                            required
                          />
                        </div>
                        <div>
                          <label htmlFor="auth-school-id" className={labelClass}>
                            School ID <span className="font-normal text-ink-3">(optional)</span>
                          </label>
                          <input
                            id="auth-school-id"
                            className={`mt-1.5 ${fieldClass}`}
                            value={schoolId}
                            onChange={e => setSchoolId(e.target.value)}
                          />
                        </div>
                        <button type="submit" className={primaryButton} disabled={busy}>
                          {spinner}
                          {busy ? 'Creating account' : 'Create account'}
                        </button>
                        <p className="text-xs leading-relaxed text-ink-3">
                          You will connect your Github or Gitlab account before creating or joining
                          a classroom.
                        </p>
                      </form>
                    )}

                    {mode === 'verify' && (
                      <form onSubmit={onVerify} className="flex flex-col gap-4">
                        {codeField}
                        <button type="submit" className={primaryButton} disabled={busy}>
                          {spinner}
                          {busy ? 'Verifying' : 'Verify email'}
                        </button>
                        <button
                          type="button"
                          className={`${quietLink} self-center`}
                          onClick={onResendVerification}
                        >
                          Send a new code
                        </button>
                      </form>
                    )}

                    {mode === 'forgot' && (
                      <form onSubmit={onForgot} className="flex flex-col gap-4">
                        {emailField('Email', true)}
                        <button type="submit" className={primaryButton} disabled={busy}>
                          {spinner}
                          {busy ? 'Sending' : 'Send reset code'}
                        </button>
                      </form>
                    )}

                    {mode === 'reset' && (
                      <form onSubmit={onReset} className="flex flex-col gap-4">
                        {codeField}
                        <div>
                          <label htmlFor="auth-reset-password" className={labelClass}>
                            New password
                          </label>
                          <input
                            id="auth-reset-password"
                            className={`mt-1.5 ${fieldClass}`}
                            type="password"
                            autoComplete="new-password"
                            placeholder="8+ characters"
                            minLength={8}
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            required
                          />
                        </div>
                        <button type="submit" className={primaryButton} disabled={busy}>
                          {spinner}
                          {busy ? 'Saving' : 'Set new password'}
                        </button>
                      </form>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {mode !== 'verify' && mode !== 'forgot' && mode !== 'reset' && (
            <div className="border-t border-line bg-[#fafaf9] px-6 py-5 text-center text-sm text-ink-1 dark:bg-neutral-950/40">
              {mode === 'sign-up' ? 'Already have an account?' : 'New to Classmoji?'}{' '}
              <button
                type="button"
                onClick={() => go(mode === 'sign-up' ? 'sign-in' : 'sign-up')}
                className="rounded-md font-semibold text-accent transition-colors duration-150 hover:text-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent cursor-pointer"
              >
                {mode === 'sign-up' ? 'Sign in' : 'Create an account'}
              </button>
            </div>
          )}
        </div>
      </main>

      <footer className="text-xs text-ink-4">© {new Date().getFullYear()} Classmoji</footer>
    </div>
  );
};

export default SignInPage;
