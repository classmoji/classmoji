import { Link, useLoaderData } from 'react-router';
import {
  Avatar,
  Empty,
  FilterChips,
  PageHeader,
  Pager,
  RoleChip,
  SearchBox,
  Sheet,
  SortHeader,
  TABLE_HEAD,
  useReturnTo,
} from '~/components/ui';
import { ViewAsButton } from '~/components/ViewAsButton';
import { relativeTime } from '~/utils/time';
import { loadPeople } from './route.server';

export const loader = loadPeople;

export const meta = () => [{ title: 'People · Classmoji Admin' }];

const PROVIDER_LABEL: Record<string, string> = { github: 'Github', gitlab: 'Gitlab' };

const fmtDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';

const People = () => {
  const { rows, total, page, pageSize, query, filters } = useLoaderData<typeof loader>();
  const returnTo = useReturnTo();
  const from = encodeURIComponent(returnTo);

  return (
    <>
      <PageHeader title="People">
        <SearchBox
          query={query}
          placeholder="Name, email, git username, id, or @domain…"
          label="Search people"
        />
      </PageHeader>

      <Sheet className="min-h-[calc(100vh-14rem)]">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3 px-1">
          <FilterChips param="role" options={filters} />
          {query ? <span className="text-xs text-ink-3">matching “{query}”</span> : null}
        </div>

        {rows.length === 0 ? (
          <Empty title="No one found" hint={query ? 'Try a different search.' : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={TABLE_HEAD}>
                  <SortHeader value="name" label="Person" defaultDir="asc" />
                  <th className="font-semibold py-2 pr-3">Role</th>
                  <SortHeader value="classes" label="Classes" className="text-right" />
                  <th className="font-semibold py-2 pr-3">Signs in with</th>
                  <th className="font-semibold py-2 pr-3">Email domain</th>
                  <SortHeader value="seen" label="Last seen" />
                  <SortHeader value="joined" label="First sign-in" />
                  <th className="py-2 w-px" />
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.id} className="border-t border-line row-hover">
                    <td className="py-1.5 pr-3">
                      <Link
                        to={`/people/${row.id}?from=${from}`}
                        className="flex items-center gap-2 min-w-0 group"
                      >
                        <Avatar name={row.name} image={row.image} size={22} />
                        <span className="truncate font-medium text-ink-0 group-hover:underline">
                          {row.name}
                        </span>
                        {row.login && row.login !== row.name ? (
                          <span className="truncate text-xs text-ink-3">@{row.login}</span>
                        ) : null}
                      </Link>
                    </td>
                    <td className="py-1.5 pr-3">
                      {row.role ? <RoleChip role={row.role} /> : <span className="text-ink-4">—</span>}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-ink-1">
                      {row.classes || '—'}
                    </td>
                    <td className="py-1.5 pr-3 text-ink-2 whitespace-nowrap">
                      {row.providers.map(p => PROVIDER_LABEL[p] ?? p).join(', ') || '—'}
                    </td>
                    <td className="py-1.5 pr-3 text-ink-2 truncate max-w-[12rem]">
                      {row.domain ?? '—'}
                    </td>
                    <td
                      className="py-1.5 pr-3 text-ink-2 whitespace-nowrap tabular-nums"
                      title={row.lastSeenAt ?? 'Not seen since tracking began (Oct 31, 2026)'}
                    >
                      {row.lastSeenAt ? relativeTime(row.lastSeenAt) : <span className="text-ink-4">—</span>}
                    </td>
                    <td className="py-1.5 pr-3 text-ink-3 whitespace-nowrap">
                      {row.firstSignInAt ? fmtDate(row.firstSignInAt) : <span className="text-ink-4">never</span>}
                    </td>
                    <td className="py-1.5 text-right">
                      <ViewAsButton userId={row.id} name={row.name} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager page={page} pageSize={pageSize} total={total} />
      </Sheet>
    </>
  );
};

export default People;
