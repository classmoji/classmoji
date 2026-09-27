import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ClassmojiService } from '@classmoji/services';
import { Emoji } from '~/components';
import GitLabIcon from '~/components/ui/display/gitlab.svg';
import type { Route } from './+types/route';

/** Scopes the application needs: sign-in (read_user) and acting on groups. */
const SCOPES = ['api', 'read_user', 'read_repository', 'write_repository'];

/** `?error=` codes the setup round trip can come back with. */
const ERRORS: Record<string, string> = {
  gitlab_setup_credentials:
    'Gitlab rejected that Application ID or Secret, or the callback URLs on the application do not match the ones above.',
  gitlab_setup_failed: 'Could not save that Gitlab. Try again.',
  gitlab_setup_exists: 'That Gitlab has already been requested or set up.',
  access_denied: 'You cancelled on Gitlab. Nothing was saved.',
  email_is_missing: 'Your Gitlab account has no email address Classmoji can read.',
  account_not_linked:
    'The Gitlab is set up, but you already have a Classmoji account with this email. Sign in the way you usually do.',
};

/**
 * /gitlab/setup: connect a self-managed GitLab to Classmoji.
 *
 * PUBLIC: whoever sets it up (an instructor, or the school's GitLab admin)
 * usually has no Classmoji account yet. They register an OAuth application on
 * their GitLab and paste its credentials here. A successful OAuth round trip
 * saves the instance as a REQUEST: a Classmoji platform admin approves it
 * before anyone can sign in through it, and the requester is emailed.
 */
export const loader = async ({ request }: Route.LoaderArgs) => {
  const url = new URL(request.url);
  const webappUrl = (process.env.WEBAPP_URL ?? url.origin).replace(/\/+$/, '');
  const svc = ClassmojiService.gitlabInstance;

  // Back from a successful setup: the request is waiting for approval.
  const pending = url.searchParams.get('gitlab_setup') === 'pending';

  const error = url.searchParams.get('error');
  return {
    pending,
    host: svc.normalizeHost(url.searchParams.get('host')) ?? '',
    error: error ? (ERRORS[error] ?? 'Setup failed. Check the details and try again.') : null,
    callbackUrls: [
      `${webappUrl}/api/auth/gitlab-instance/callback`,
      `${webappUrl}/connect/gitlab/callback`,
    ],
    scopes: SCOPES,
    egressIps: svc.egressIps(),
  };
};

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-md bg-stone-50 dark:bg-neutral-800 ring-1 ring-stone-200 dark:ring-neutral-700 px-2.5 py-1.5">
      <code className="flex-1 min-w-0 truncate text-xs text-gray-800 dark:text-gray-200">
        {value}
      </code>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="shrink-0 text-xs font-medium text-primary hover:underline cursor-pointer"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

const inputClass =
  'w-full rounded-md px-2.5 py-1.5 text-sm bg-white dark:bg-neutral-950 text-gray-900 dark:text-white ring-1 ring-stone-200 dark:ring-neutral-700 focus:outline-none focus:ring-2 focus:ring-primary';

export default function GitLabSetup({ loaderData }: Route.ComponentProps) {
  const { pending, callbackUrls, scopes, egressIps } = loaderData;

  const [host, setHost] = useState(loaderData.host);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(loaderData.error);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/gitlab-instance/setup', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          host,
          clientId,
          clientSecret,
          note,
          callbackURL: `/gitlab/setup?host=${encodeURIComponent(host.trim())}`,
          errorCallbackURL: '/gitlab/setup',
        }),
      });
      const body = (await response.json().catch(() => null)) as {
        url?: string;
        message?: string;
      } | null;
      if (response.ok && body?.url) {
        window.location.href = body.url;
        return;
      }
      setError(body?.message ?? 'Setup failed. Check the details and try again.');
    } catch {
      setError('Setup failed. Check your connection and try again.');
    }
    setBusy(false);
  };

  return (
    <div className="min-h-screen bg-[#fafaf9] dark:bg-neutral-950 px-4 py-12">
      <div className="mx-auto max-w-xl">
        <div className="flex items-center justify-center gap-3 mb-6">
          <Emoji emoji="apple" fontSize="36px" logo />
          <span className="text-ink-4">+</span>
          <img src={GitLabIcon} alt="Gitlab" className="w-9 h-9" />
        </div>

        {pending ? (
          <div className="rounded-2xl bg-white dark:bg-neutral-900 ring-1 ring-stone-200 dark:ring-neutral-800 p-6">
            <h1 className="text-lg font-semibold text-gray-900 dark:text-white">
              Request sent{loaderData.host ? ` for ${new URL(loaderData.host).host}` : ''}
            </h1>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              Your credentials work. The Classmoji team reviews every new Gitlab before anyone can
              sign in through it, usually within a day. We&apos;ll email you at the address on your
              Gitlab account as soon as it is approved, with a sign-in link to share with your
              students.
            </p>
          </div>
        ) : (
          <div className="rounded-2xl bg-white dark:bg-neutral-900 ring-1 ring-stone-200 dark:ring-neutral-800 p-6">
            <h1 className="text-lg font-semibold text-gray-900 dark:text-white">
              Connect your school&apos;s Gitlab
            </h1>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              A one-time step per Gitlab server. After this, instructors and students on it sign in
              with one click. Best done by your Gitlab admin, so the application belongs to the
              school rather than one person; any instructor can request it too. The Classmoji team
              approves each new Gitlab before it can be used.
            </p>

            <ol className="mt-5 space-y-5 text-sm text-gray-800 dark:text-gray-200">
              <li>
                <p className="font-medium">1. Create an application on your Gitlab</p>
                <p className="mt-1 text-gray-600 dark:text-gray-400">
                  Use a group you own: <em>Group &gt; Settings &gt; Applications</em>. It keeps
                  working when people leave. Gitlab admins can use <em>Admin &gt; Applications</em>{' '}
                  and tick <em>Trusted</em> so students skip the approval screen.
                </p>
              </li>
              <li>
                <p className="font-medium">2. Fill it in</p>
                <div className="mt-2 space-y-3">
                  <div>
                    <p className="text-xs text-ink-3 mb-1">Name</p>
                    <CopyField value="Classmoji" />
                  </div>
                  <div>
                    <p className="text-xs text-ink-3 mb-1">
                      Redirect URI (both lines, one per line)
                    </p>
                    <div className="space-y-1.5">
                      {callbackUrls.map(u => (
                        <CopyField key={u} value={u} />
                      ))}
                    </div>
                  </div>
                  <p className="text-xs text-gray-600 dark:text-gray-400">
                    Keep <em>Confidential</em> ticked. Scopes:{' '}
                    {scopes.map((s, i) => (
                      <span key={s}>
                        <code className="rounded bg-stone-100 dark:bg-neutral-800 px-1">{s}</code>
                        {i < scopes.length - 1 ? ', ' : ''}
                      </span>
                    ))}
                    .
                  </p>
                </div>
              </li>
              <li>
                <p className="font-medium">3. Paste the credentials</p>
                <form onSubmit={submit} className="mt-2 space-y-3">
                  <div>
                    <label htmlFor="host" className="block text-xs text-ink-3 mb-1">
                      Gitlab address
                    </label>
                    <input
                      id="host"
                      value={host}
                      onChange={e => setHost(e.target.value)}
                      placeholder="gitlab.school.edu"
                      required
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label htmlFor="client-id" className="block text-xs text-ink-3 mb-1">
                      Application ID
                    </label>
                    <input
                      id="client-id"
                      value={clientId}
                      onChange={e => setClientId(e.target.value)}
                      required
                      autoComplete="off"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label htmlFor="client-secret" className="block text-xs text-ink-3 mb-1">
                      Secret
                    </label>
                    <input
                      id="client-secret"
                      type="password"
                      value={clientSecret}
                      onChange={e => setClientSecret(e.target.value)}
                      required
                      autoComplete="off"
                      className={inputClass}
                    />
                  </div>

                  <div>
                    <label htmlFor="note" className="block text-xs text-ink-3 mb-1">
                      Your role and course
                    </label>
                    <textarea
                      id="note"
                      value={note}
                      onChange={e => setNote(e.target.value)}
                      required
                      maxLength={500}
                      rows={2}
                      placeholder="Instructor for CS 10, Fall 2026 (or: Gitlab admin at the CS department)"
                      className={inputClass}
                    />
                  </div>

                  {error && (
                    <p className="rounded-lg bg-amber-50 dark:bg-amber-900/20 ring-1 ring-amber-200 dark:ring-amber-800 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
                      {error}
                    </p>
                  )}

                  <button
                    type="submit"
                    disabled={busy}
                    className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50 cursor-pointer"
                  >
                    {busy ? 'Checking…' : 'Check and send for approval'}
                  </button>
                  <p className="text-xs text-ink-3">
                    You&apos;ll approve Classmoji on your Gitlab once; that proves the credentials
                    work. Nobody can sign in through it until the Classmoji team approves it. Your
                    Gitlab must be reachable from the internet.
                  </p>
                  {egressIps.length > 0 && (
                    <p className="text-xs text-ink-3">
                      Only reachable on campus? Ask IT to allow these Classmoji addresses, both for
                      your Gitlab and for its outgoing webhooks: {egressIps.join(', ')}.
                    </p>
                  )}
                </form>
              </li>
            </ol>
          </div>
        )}

        <p className="mt-6 text-center text-xs text-ink-3">
          <Link to="/" className="hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
