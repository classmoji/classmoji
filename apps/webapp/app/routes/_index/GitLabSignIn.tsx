import { useEffect, useState, type FormEvent } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ChevronDownIcon, ServerIcon } from 'lucide-react';
import { authClient } from '@classmoji/auth/client';
import GitLabIcon from '~/components/ui/display/gitlab.svg';
import type { GitLabChoice, GitLabSignInOptions } from './gitlabSignIn.server';
import { optionButton } from './signInStyles';

/** The last GitLab signed in with on this browser, so it is one click next time. */
const STORAGE_KEY = 'classmoji:gitlab-instance';

function readRemembered(): GitLabChoice | null {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    return value && typeof value.host === 'string' ? (value as GitLabChoice) : null;
  } catch {
    return null;
  }
}

function remember(choice: GitLabChoice | null) {
  try {
    if (choice) localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked: the chooser still works, it just isn't remembered.
  }
}

const hostLabel = (host: string) => new URL(host).host;

type Status = { kind: 'unknown'; host: string } | { kind: 'error'; text: string } | null;

const pendingText = (host: string) =>
  `${hostLabel(host)} is waiting for Classmoji's approval. You can sign in once it is approved.`;

/**
 * "Continue with Gitlab" for gitlab.com and self-managed instances.
 *
 * The first button goes straight to the GitLab this visit is for (an invite or
 * `?gitlab=` link), else the one this browser used last, else gitlab.com, and
 * names the server. The second opens a field in place where a school's
 * address can be typed.
 */
export default function GitLabSignIn({
  options,
  callbackURL,
}: {
  options: GitLabSignInOptions;
  callbackURL: string;
}) {
  const reduced = useReducedMotion();
  const [remembered, setRemembered] = useState<GitLabChoice | null>(null);
  useEffect(() => setRemembered(readRemembered()), []);

  const defaultChoice: GitLabChoice | null = options.defaultHost
    ? { id: null, host: options.defaultHost }
    : null;
  const target = options.preselected ?? remembered ?? defaultChoice;

  const [choosing, setChoosing] = useState(Boolean(options.unknownHost || options.pendingHost));
  const [hostInput, setHostInput] = useState(
    options.unknownHost || options.pendingHost
      ? hostLabel((options.unknownHost || options.pendingHost) as string)
      : ''
  );
  const [status, setStatus] = useState<Status>(
    options.pendingHost
      ? { kind: 'error', text: pendingText(options.pendingHost) }
      : options.unknownHost
        ? { kind: 'unknown', host: options.unknownHost }
        : null
  );
  const [busy, setBusy] = useState(false);

  const signIn = async (choice: GitLabChoice, { retried = false } = {}) => {
    setBusy(true);
    setStatus(null);
    remember(choice);
    if (choice.id === null) {
      await authClient.signIn.social({ provider: 'gitlab', callbackURL, errorCallbackURL: '/' });
      return;
    }
    try {
      const response = await fetch('/api/auth/gitlab-instance/sign-in', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instanceId: choice.id, callbackURL, errorCallbackURL: '/' }),
      });
      const body = (await response.json().catch(() => null)) as {
        url?: string;
        message?: string;
      } | null;
      if (response.ok && body?.url) {
        window.location.href = body.url;
        return;
      }
      // A remembered instance that was removed, re-registered, turned off or
      // is waiting for approval: forget it and say where its host stands now.
      remember(null);
      setRemembered(null);
      setChoosing(true);
      setHostInput(hostLabel(choice.host));
      if (!retried) {
        await checkHost(choice.host, { retried: true });
        return;
      }
      setStatus({ kind: 'error', text: body?.message ?? 'Could not start Gitlab sign-in.' });
    } catch {
      setStatus({ kind: 'error', text: 'Could not start Gitlab sign-in.' });
    }
    setBusy(false);
  };

  /** Where a host stands with Classmoji; signs in when it is ready. */
  const checkHost = async (host: string, { retried = false } = {}) => {
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch(`/api/gitlab-instances/lookup?host=${encodeURIComponent(host)}`);
      const body = (await response.json().catch(() => null)) as
        | { status: 'ok'; instance: GitLabChoice }
        | { status: 'unknown' | 'disabled' | 'pending'; host: string }
        | { status: 'invalid' }
        | null;
      if (body?.status === 'ok') {
        await signIn(body.instance, { retried });
        return;
      }
      if (body?.status === 'unknown') setStatus({ kind: 'unknown', host: body.host });
      else if (body?.status === 'pending')
        setStatus({ kind: 'error', text: pendingText(body.host) });
      else if (body?.status === 'disabled') {
        setStatus({ kind: 'error', text: `Sign-in with ${hostLabel(body.host)} is turned off.` });
      } else
        setStatus({ kind: 'error', text: 'Enter your Gitlab address, like gitlab.school.edu' });
    } catch {
      setStatus({ kind: 'error', text: 'Could not check that address. Try again.' });
    }
    setBusy(false);
  };

  const lookUp = async (event: FormEvent) => {
    event.preventDefault();
    if (!hostInput.trim()) return;
    await checkHost(hostInput.trim());
  };

  return (
    <div className="flex flex-col gap-3">
      {target && (
        <button
          type="button"
          onClick={() => signIn(target)}
          disabled={busy}
          title={hostLabel(target.host)}
          className={optionButton}
        >
          <img src={GitLabIcon} alt="" className="h-4 w-4 shrink-0" />
          {/* Name the server, so gitlab.com and a school's Gitlab never look alike. */}
          <span className="min-w-0 truncate">
            Continue with {target.id === null ? 'Gitlab.com' : hostLabel(target.host)}
          </span>
        </button>
      )}

      <div>
        <button
          type="button"
          aria-expanded={choosing}
          aria-controls="self-hosted-gitlab"
          onClick={() => {
            setChoosing(open => !open);
            setStatus(null);
          }}
          className={optionButton}
        >
          <ServerIcon className="h-4 w-4 shrink-0 text-ink-2" aria-hidden />
          {target && target.id !== null
            ? 'Use a different Gitlab'
            : 'Continue with self-hosted Gitlab'}
          <ChevronDownIcon
            className={`h-3.5 w-3.5 text-ink-3 transition-transform duration-200 ease-out ${choosing ? 'rotate-180' : ''}`}
            aria-hidden
          />
        </button>

        <AnimatePresence initial={false}>
          {choosing && (
            <motion.div
              id="self-hosted-gitlab"
              initial={reduced ? false : { height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={reduced ? undefined : { height: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              // Clips while it grows; the inset gives the focus ring room inside the clip.
              className="-mx-1 overflow-hidden px-1"
            >
              <form onSubmit={lookUp} noValidate className="pb-1 pt-3">
                <label htmlFor="gitlab-host" className="text-xs font-medium text-ink-1">
                  Your Gitlab address
                </label>
                <div className="mt-1.5 flex gap-2">
                  <input
                    id="gitlab-host"
                    type="text"
                    inputMode="url"
                    autoComplete="url"
                    placeholder="gitlab.yourschool.edu"
                    value={hostInput}
                    onChange={e => {
                      setHostInput(e.target.value);
                      if (status?.kind === 'error') setStatus(null);
                    }}
                    aria-invalid={status?.kind === 'error'}
                    aria-describedby={status ? 'gitlab-host-status' : undefined}
                    className={`h-[32px] min-w-0 flex-1 rounded-lg border bg-panel px-3 text-sm text-ink-0 placeholder:text-ink-4 focus:outline-none focus:ring-2 ${
                      status?.kind === 'error'
                        ? 'border-rose-ink focus:ring-rose-ink/25'
                        : 'border-line-2 focus:border-accent focus:ring-accent/25'
                    }`}
                  />
                  <button
                    type="submit"
                    disabled={busy || !hostInput.trim()}
                    className="h-[32px] shrink-0 rounded-lg bg-accent px-3 text-sm font-semibold text-white transition-colors duration-150 hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:opacity-50 cursor-pointer disabled:cursor-default"
                  >
                    Continue
                  </button>
                </div>

                {status?.kind === 'unknown' && (
                  <p
                    id="gitlab-host-status"
                    className="mt-2 text-xs leading-relaxed text-ink-2"
                  >
                    {hostLabel(status.host)} isn&apos;t connected to Classmoji yet. Students: ask
                    your instructor for the class sign-in link. Instructors and Gitlab admins:{' '}
                    <a
                      href={`/gitlab/setup?host=${encodeURIComponent(status.host)}`}
                      className="font-medium text-accent hover:underline"
                    >
                      set it up
                    </a>
                    .
                  </p>
                )}
                {status?.kind === 'error' && (
                  <p id="gitlab-host-status" className="mt-1.5 text-xs text-rose-ink">
                    {status.text}
                  </p>
                )}

                {/* A school's Gitlab is remembered; gitlab.com stays one click away. */}
                {defaultChoice && target?.id !== null && (
                  <button
                    type="button"
                    onClick={() => signIn(defaultChoice)}
                    disabled={busy}
                    className="mt-2 text-xs font-medium text-ink-3 hover:text-ink-0 cursor-pointer"
                  >
                    Use {hostLabel(defaultChoice.host)} instead
                  </button>
                )}
              </form>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
