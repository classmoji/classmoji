import { useEffect, useState, type FormEvent } from 'react';
import { authClient } from '@classmoji/auth/client';
import GitLabIcon from '~/components/ui/display/gitlab.svg';
import { GITLAB_BUTTON_LOGO } from '~/components/ui/gitlabButton';
import type { GitLabChoice, GitLabSignInOptions } from './gitlabSignIn.server';

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
 * Goes straight to the GitLab this visit is for (an invite or `?gitlab=` link),
 * else the one this browser used last, else gitlab.com. The button names the
 * server; the link under it opens a chooser where a school's address can be
 * typed.
 */
export default function GitLabSignIn({
  options,
  callbackURL,
  buttonClassName,
  onChoosingChange,
}: {
  options: GitLabSignInOptions;
  callbackURL: string;
  buttonClassName: string;
  /** The chooser opened or closed, so the page can give it the room. */
  onChoosingChange?: (choosing: boolean) => void;
}) {
  const [remembered, setRemembered] = useState<GitLabChoice | null>(null);
  useEffect(() => setRemembered(readRemembered()), []);

  const defaultChoice: GitLabChoice | null = options.defaultHost
    ? { id: null, host: options.defaultHost }
    : null;
  const target = options.preselected ?? remembered ?? defaultChoice;

  const [choosing, setChoosing] = useState(Boolean(options.unknownHost || options.pendingHost));
  useEffect(() => onChoosingChange?.(choosing), [choosing, onChoosingChange]);
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

  if (!choosing && target) {
    return (
      <div className="w-full">
        <button
          onClick={() => signIn(target)}
          disabled={busy}
          title={hostLabel(target.host)}
          className={buttonClassName}
        >
          <img src={GitLabIcon} alt="" className={`w-4 h-4 shrink-0 ${GITLAB_BUTTON_LOGO}`} />
          {/* Name the server, so gitlab.com and a school's Gitlab never look alike. */}
          <span className="min-w-0 truncate whitespace-nowrap">
            Continue with {target.id === null ? 'Gitlab.com' : hostLabel(target.host)}
          </span>
        </button>
        <div className="mt-3 text-center text-sm text-ink-3">
          <button
            type="button"
            onClick={() => setChoosing(true)}
            className="underline-offset-2 hover:underline cursor-pointer"
          >
            {target.id === null ? 'Use a self-hosted Gitlab' : 'Use a different Gitlab'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full rounded-lg ring-1 ring-stone-200 dark:ring-neutral-700 bg-white dark:bg-neutral-900 p-5 text-left">
      <div className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-white mb-2">
        <img src={GitLabIcon} alt="" className="w-4 h-4" />
        Sign in with Gitlab
      </div>

      {defaultChoice && (
        <button
          type="button"
          onClick={() => signIn(defaultChoice)}
          disabled={busy}
          className="w-full mb-3 rounded-md px-3 py-2 text-sm font-medium text-gray-900 dark:text-white ring-1 ring-stone-200 dark:ring-neutral-700 hover:bg-stone-50 dark:hover:bg-neutral-800 cursor-pointer"
        >
          {hostLabel(defaultChoice.host)}
        </button>
      )}

      <form onSubmit={lookUp}>
        <label htmlFor="gitlab-host" className="block text-xs text-ink-3 mb-1">
          Self-hosted Gitlab address
        </label>
        <div className="flex gap-2">
          <input
            id="gitlab-host"
            value={hostInput}
            onChange={e => setHostInput(e.target.value)}
            placeholder="gitlab.school.edu"
            autoComplete="url"
            className="min-w-0 flex-1 rounded-md px-3 py-2 text-sm bg-white dark:bg-neutral-950 text-gray-900 dark:text-white ring-1 ring-stone-200 dark:ring-neutral-700 focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <button
            type="submit"
            disabled={busy || !hostInput.trim()}
            className="rounded-md px-4 py-2 text-sm font-medium bg-primary text-white hover:bg-primary/90 disabled:opacity-50 cursor-pointer"
          >
            Go
          </button>
        </div>
      </form>

      {status?.kind === 'unknown' && (
        <p className="mt-3 text-xs text-gray-700 dark:text-gray-300">
          {hostLabel(status.host)} isn&apos;t connected to Classmoji yet. Students: ask your
          instructor for the class sign-in link. Instructors and Gitlab admins:{' '}
          <a
            href={`/gitlab/setup?host=${encodeURIComponent(status.host)}`}
            className="font-medium text-primary hover:underline"
          >
            set it up
          </a>
          .
        </p>
      )}
      {status?.kind === 'error' && (
        <p className="mt-3 text-xs text-red-600 dark:text-red-400">{status.text}</p>
      )}

      {target && (
        <button
          type="button"
          onClick={() => {
            setChoosing(false);
            setStatus(null);
          }}
          className="mt-3 text-xs text-ink-3 hover:underline cursor-pointer"
        >
          Back
        </button>
      )}
    </div>
  );
}
