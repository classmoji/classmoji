import { useState } from 'react';
import { useFetcher, useLoaderData } from 'react-router';
import { gitLabInstancesAction, loadGitLabInstances } from './route.server';
import type { InstanceRow } from './route.server';

export const loader = loadGitLabInstances;
export const action = gitLabInstancesAction;

export const meta = () => [{ title: 'Gitlab instances · Classmoji Admin' }];

const inputClass =
  'rounded-md border border-line bg-panel px-2 py-1 text-xs text-ink-0 focus:outline-none focus:border-line-strong';

type Health = {
  reachable: boolean;
  error: string | null;
  projectsChecked: number;
  missingHooks: number;
  failingHooks: number;
  examples: string[];
};

/** Reachability and a sample of the instance's project webhooks. */
const HealthCheck = ({ row }: { row: InstanceRow }) => {
  const check = useFetcher<{ health?: Health; error?: string }>();
  const health = check.data?.health;
  return (
    <div className="flex flex-col items-end gap-1">
      <check.Form method="post">
        <input type="hidden" name="intent" value="check" />
        <input type="hidden" name="instanceId" value={row.id} />
        <button
          type="submit"
          disabled={check.state !== 'idle'}
          className="rounded-md border border-line px-2.5 py-1 text-xs font-medium text-ink-2 hover:bg-nav-hover disabled:opacity-40"
        >
          {check.state !== 'idle' ? 'Checking…' : 'Check health'}
        </button>
      </check.Form>
      {health ? (
        <div className="text-[11px] text-right max-w-[22rem]">
          {!health.reachable ? (
            <span className="text-red-600 dark:text-red-400">
              Unreachable: {health.error ?? 'unknown error'}
            </span>
          ) : health.error ? (
            <span className="text-red-600 dark:text-red-400">{health.error}</span>
          ) : (
            <span
              className={
                health.missingHooks + health.failingHooks > 0
                  ? 'text-amber-700 dark:text-amber-400'
                  : 'text-ink-3'
              }
            >
              Reachable · {health.projectsChecked} projects checked · {health.missingHooks} missing,{' '}
              {health.failingHooks} failing webhooks
            </span>
          )}
          {health.examples.length > 0 ? (
            <div className="text-ink-3">{health.examples.join(', ')}</div>
          ) : null}
          {health.missingHooks + health.failingHooks > 0 ? (
            <div className="text-ink-3">
              Fix: the classroom&apos;s Settings → Projects → Repair webhooks, or wait for the
              nightly repair.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

const InstanceActions = ({ row }: { row: InstanceRow }) => {
  const toggle = useFetcher<{ error?: string }>();
  const creds = useFetcher<{ error?: string; ok?: boolean }>();
  const [editing, setEditing] = useState(false);
  const pending = toggle.formData?.get('disabled');
  const disabled = pending === undefined ? row.disabled : pending === 'true';
  const error = toggle.data?.error ?? creds.data?.error;

  return (
    <div className="flex flex-col items-end gap-1.5">
      <HealthCheck row={row} />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setEditing(v => !v)}
          className="rounded-md border border-line px-2.5 py-1 text-xs font-medium text-ink-2 hover:bg-nav-hover"
        >
          Replace credentials
        </button>
        <toggle.Form method="post">
          <input type="hidden" name="intent" value="toggle" />
          <input type="hidden" name="instanceId" value={row.id} />
          <input type="hidden" name="disabled" value={disabled ? 'false' : 'true'} />
          <button
            type="submit"
            disabled={toggle.state !== 'idle'}
            className={
              'rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-40 ' +
              (disabled
                ? 'border-line text-ink-2 hover:bg-nav-hover'
                : 'border-line-strong bg-accent-soft text-ink-0')
            }
          >
            {disabled ? 'Off' : 'On'}
          </button>
        </toggle.Form>
      </div>
      {editing && creds.data?.ok !== true ? (
        <creds.Form method="post" className="flex flex-wrap justify-end gap-2">
          <input type="hidden" name="intent" value="credentials" />
          <input type="hidden" name="instanceId" value={row.id} />
          <input name="clientId" placeholder="Application ID" className={inputClass} required />
          <input
            name="clientSecret"
            type="password"
            placeholder="Secret"
            className={inputClass}
            required
          />
          <button
            type="submit"
            disabled={creds.state !== 'idle'}
            className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40"
          >
            Save
          </button>
        </creds.Form>
      ) : null}
      {creds.data?.ok ? <span className="text-[11px] text-ink-3">Credentials replaced</span> : null}
      {error ? (
        <span role="alert" className="text-[11px] text-red-600 dark:text-red-400">
          {error}
        </span>
      ) : null}
    </div>
  );
};

const GitLabInstances = () => {
  const { rows, defaultHost } = useLoaderData<typeof loader>();

  return (
    <>
      <div className="flex items-center justify-between gap-3 mt-2 mb-4">
        <h1 className="text-lg font-semibold text-ink-1 shrink-0">Gitlab instances</h1>
      </div>

      <div className="rounded-2xl bg-panel ring-1 ring-line px-3 py-4 sm:px-4 min-h-[calc(100vh-14rem)]">
        <p className="text-xs text-ink-3 mb-3 px-1">
          Self-managed Gitlabs connected at /gitlab/setup. The default instance ({defaultHost}) is
          configured from env and not listed. Turning one off stops sign-in and new connections;
          classrooms already on it keep working.
        </p>

        {rows.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <div className="font-medium">No self-managed Gitlabs yet</div>
            <div className="text-sm">They appear here once someone connects one.</div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-ink-4">
                  <th className="font-semibold py-2 pr-4">Host</th>
                  <th className="font-semibold py-2 pr-4">Connected by</th>
                  <th className="font-semibold py-2 pr-4">Groups</th>
                  <th className="font-semibold py-2 pr-4">Connections</th>
                  <th className="font-semibold py-2 pr-4 text-right">Sign-in</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.id} className="border-t border-line row-hover align-top">
                    <td className="py-2.5 pr-4">
                      <a
                        href={row.host}
                        target="_blank"
                        rel="noreferrer"
                        className="text-ink-0 font-medium hover:underline"
                      >
                        {new URL(row.host).host}
                      </a>
                      <div className="text-ink-3 text-xs">
                        since {new Date(row.createdAt).toLocaleDateString()}
                      </div>
                    </td>
                    <td className="py-2.5 pr-4 text-ink-2">{row.createdBy ?? 'Unknown'}</td>
                    <td className="py-2.5 pr-4 text-ink-2">{row.groups}</td>
                    <td className="py-2.5 pr-4 text-ink-2">{row.connections}</td>
                    <td className="py-2.5">
                      <InstanceActions row={row} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
};

export default GitLabInstances;
