import { useState } from 'react';
import { Form, useLoaderData } from 'react-router';
import { authClient } from '@classmoji/auth/client';
import { IconSearch, IconUserShare } from '@tabler/icons-react';
import { useDebouncedSearch } from '~/hooks/useDebouncedSearch';
import { loadUsers } from './route.server';
import type { AdminUserRow } from './route.server';

export const loader = loadUsers;

export const meta = () => [{ title: 'Users · Classmoji Admin' }];

/**
 * Breadcrumb telling the webapp's ImpersonationBanner to send "Stop viewing"
 * back here instead of to a classroom roster.
 *
 * A cookie rather than sessionStorage because the two apps are different
 * origins and web storage is origin-scoped. Domain matches the session cookie's
 * resolution so it travels exactly as far.
 */
const ORIGIN_COOKIE = 'cm_impersonation_origin';

const setOriginCookie = (cookieDomain: string | null) => {
  const parts = [
    `${ORIGIN_COOKIE}=admin`,
    'path=/',
    // Matches better-auth's impersonationSessionDuration (1 hour), so the
    // breadcrumb cannot outlive the session it describes.
    'max-age=3600',
    'samesite=lax',
  ];
  if (cookieDomain) parts.push(`domain=${cookieDomain}`);
  if (window.location.protocol === 'https:') parts.push('secure');
  document.cookie = parts.join('; ');
};

const initials = (row: AdminUserRow) =>
  (row.name ?? row.login ?? row.email ?? '?').trim().charAt(0).toUpperCase();

const AdminUsers = () => {
  const { rows, total, query, truncated, limit, adminUserId, webappUrl, cookieDomain } =
    useLoaderData<typeof loader>();
  const { inputRef, onSearchChange, searching } = useDebouncedSearch(query);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const impersonate = async (row: AdminUserRow) => {
    setPendingId(row.id);
    setError(null);
    try {
      const { error: authError } = await authClient.admin.impersonateUser({ userId: row.id });
      if (authError) throw new Error(authError.message ?? 'Impersonation was refused.');

      setOriginCookie(cookieDomain);
      // Full navigation, not react-router navigate(): the webapp is a different
      // origin. The session cookie better-auth just set travels with it.
      window.location.href = webappUrl;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Impersonation failed.');
      setPendingId(null);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between gap-3 mt-2 mb-4">
        <h1 className="text-lg font-semibold text-ink-1 shrink-0">Users</h1>
        {/* Still a real GET form, so it works without JS and the query stays
              in the URL (shareable, survives reload). The button is only a
              no-JS fallback — with JS the debounced onChange submits. */}
        <Form method="get" className="min-w-0" onChange={onSearchChange}>
          <div className="relative min-w-0 sm:w-80">
            <IconSearch
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-4 pointer-events-none"
            />
            <input
              ref={inputRef}
              type="search"
              name="q"
              defaultValue={query}
              placeholder="Search by username, name, or email…"
              aria-label="Search users"
              className="w-full rounded-md border border-line bg-panel pl-9 pr-8 py-1.5 text-sm text-ink-0 placeholder:text-ink-4 focus:outline-none focus:border-line-strong"
            />
            {searching ? (
              <span
                aria-hidden
                // Tailwind's animate-spin, not the webapp's `.spin` — that
                // class lives outside the shared components.css slice.
                className="absolute right-3 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2 border-line-strong border-t-transparent animate-spin"
              />
            ) : null}
            <noscript>
              <button
                type="submit"
                className="ml-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white"
              >
                Search
              </button>
            </noscript>
          </div>
        </Form>
      </div>

      {error ? (
        <div className="mb-4 rounded-lg bg-peach-bg border border-peach-bord text-peach-ink px-4 py-2.5 text-sm">
          {error}
        </div>
      ) : null}

      <div className="rounded-2xl bg-panel ring-1 ring-line p-5 sm:p-6 min-h-[calc(100vh-14rem)]">
        <div className="flex items-baseline justify-between mb-3">
          <p className="text-xs text-ink-3">
            {query ? `${total} matching “${query}”` : `${total} users`}
            {truncated ? ` · showing first ${limit}` : ''}
          </p>
        </div>

        {rows.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <div className="font-medium">No users found</div>
            <div className="text-sm">
              {query ? 'Try a different search term.' : 'The database has no users yet.'}
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-ink-4">
                  <th className="font-semibold py-2 pr-4">User</th>
                  <th className="font-semibold py-2 pr-4">Classrooms</th>
                  <th className="font-semibold py-2 pr-4">Joined</th>
                  <th className="font-semibold py-2 w-px" />
                </tr>
              </thead>
              <tbody>
                {rows.map(row => {
                  const isSelf = row.id === adminUserId;
                  return (
                    <tr key={row.id} className="border-t border-line row-hover">
                      <td className="py-2.5 pr-4">
                        <div className="flex items-center gap-2.5 min-w-0">
                          {row.image ? (
                            <img src={row.image} alt="" className="w-7 h-7 rounded-full shrink-0" />
                          ) : (
                            <span className="w-7 h-7 rounded-full shrink-0 bg-accent-soft text-accent-ink grid place-items-center text-[11px] font-semibold">
                              {initials(row)}
                            </span>
                          )}
                          <div className="min-w-0">
                            <div className="text-ink-0 font-medium truncate">
                              {row.name ?? row.login ?? '—'}
                            </div>
                            <div className="text-ink-3 text-xs truncate">
                              {row.login ? `@${row.login}` : (row.email ?? row.id)}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="py-2.5 pr-4">
                        {row.classrooms.length === 0 ? (
                          <span className="text-ink-4">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {row.classrooms.slice(0, 3).map(c => (
                              <span
                                key={`${c.slug}-${c.role}`}
                                title={`${c.name} · ${c.role}`}
                                className="chip"
                              >
                                {c.slug}
                              </span>
                            ))}
                            {row.classrooms.length > 3 ? (
                              <span className="text-ink-4 text-xs self-center">
                                +{row.classrooms.length - 3}
                              </span>
                            ) : null}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 pr-4 text-ink-3 whitespace-nowrap">
                        {new Date(row.createdAt).toLocaleDateString()}
                      </td>
                      <td className="py-2.5">
                        <button
                          type="button"
                          onClick={() => impersonate(row)}
                          disabled={isSelf || pendingId !== null}
                          title={
                            isSelf
                              ? 'This is you'
                              : `Sign in to Classmoji as ${row.login ?? row.id}`
                          }
                          className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-line px-2.5 py-1 text-xs font-medium text-ink-1 hover:bg-nav-hover disabled:opacity-40 disabled:hover:bg-transparent"
                        >
                          <IconUserShare size={14} />
                          {pendingId === row.id ? 'Starting…' : 'Impersonate'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="mt-3 text-xs text-ink-4">
        Impersonation sessions expire after 1 hour. Use “Stop viewing” in the banner to return here.
      </p>
    </>
  );
};

export default AdminUsers;
