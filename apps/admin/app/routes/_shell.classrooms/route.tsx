import { Link, useLoaderData, useSearchParams } from 'react-router';
import {
  Dot,
  Empty,
  FilterChips,
  PageHeader,
  Pager,
  SearchBox,
  Sheet,
  SortHeader,
  StatusChips,
  TABLE_HEAD,
  useReturnTo,
  withParams,
  ExportLink,
} from '~/components/ui';
import { relativeTime } from '~/utils/time';
import { loadClassrooms } from './route.server';

export const loader = loadClassrooms;

export const meta = () => [{ title: 'Classrooms · Classmoji Admin' }];

const HEALTH_TONE = { critical: 'critical', ok: 'ok' } as const;

const Classrooms = () => {
  const { rows, total, page, pageSize, query, statusFilters, problems } =
    useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const from = encodeURIComponent(useReturnTo());
  const problemsOn = params.get('health') === 'problems';
  const provider = params.get('provider') ?? '';

  const toggle = (on: boolean, label: string, to: string) => (
    <Link
      to={to}
      preventScrollReset
      aria-current={on ? 'true' : undefined}
      className={`rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${
        on ? 'bg-ink-0 text-panel border-ink-0' : 'border-line text-ink-2 bg-panel hover:text-ink-0'
      }`}
    >
      {label}
    </Link>
  );

  return (
    <>
      <PageHeader title="Classrooms">
        <ExportLink />
        <SearchBox
          query={query}
          placeholder="Name, slug, org, or owner…"
          label="Search classrooms"
        />
      </PageHeader>

      <Sheet className="min-h-[calc(100vh-14rem)]">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3 px-1">
          <FilterChips param="status" options={statusFilters} />
          <div className="flex flex-wrap gap-1.5">
            {toggle(
              problemsOn,
              `Has problems${problems ? ` ${problems}` : ''}`,
              withParams(params, { health: problemsOn ? null : 'problems' })
            )}
            {toggle(
              provider === 'github',
              'Github',
              withParams(params, { provider: provider === 'github' ? null : 'github' })
            )}
            {toggle(
              provider === 'gitlab',
              'Gitlab',
              withParams(params, { provider: provider === 'gitlab' ? null : 'gitlab' })
            )}
          </div>
        </div>

        {rows.length === 0 ? (
          <Empty title="No classrooms found" hint={query ? 'Try a different search.' : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={TABLE_HEAD}>
                  <th className="py-2 pr-2 w-4" aria-label="Health" />
                  <SortHeader value="name" label="Classroom" defaultDir="asc" />
                  <th className="font-semibold py-2 pr-3">Owner</th>
                  <th className="font-semibold py-2 pr-3">Org</th>
                  <SortHeader value="students" label="Students" className="text-right" />
                  <th className="font-semibold py-2 pr-3 text-right">Pending</th>
                  <th className="font-semibold py-2 pr-3 text-right">Staff</th>
                  <SortHeader value="activity" label="Last activity" />
                  <th className="font-semibold py-2 pr-3">Delivery</th>
                  <th className="font-semibold py-2 pr-3">Plan</th>
                  <SortHeader value="created" label="Created" />
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.id} className="border-t border-line row-hover">
                    <td
                      className="py-1.5 pr-2"
                      title={row.reasons.join(' · ') || 'No problems found'}
                    >
                      <Dot tone={HEALTH_TONE[row.health]} />
                    </td>
                    <td className="py-1.5 pr-3 max-w-[20rem]">
                      <Link
                        to={`/classrooms/${encodeURIComponent(row.slug)}?from=${from}`}
                        className="font-medium text-ink-0 hover:underline"
                      >
                        {row.name}
                      </Link>{' '}
                      <span className="text-xs text-ink-3">{row.slug}</span>{' '}
                      <StatusChips
                        status={row.status}
                        isArchived={row.isArchived}
                        isExample={row.isExample}
                      />
                    </td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">
                      {row.owner ? (
                        <Link to={`/people/${row.owner.id}`} className="text-ink-1 hover:underline">
                          {row.owner.name ?? 'Unnamed'}
                        </Link>
                      ) : (
                        <span className="text-ink-4">—</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-ink-2 whitespace-nowrap">
                      {row.org}
                      {row.provider === 'GITLAB' ? (
                        <span className="text-ink-4"> · Gitlab</span>
                      ) : null}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{row.accepted}</td>
                    <td
                      className={`py-1.5 pr-3 text-right tabular-nums ${row.pending ? 'text-amber-ink' : 'text-ink-4'}`}
                    >
                      {row.pending || '—'}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-ink-2">{row.staff}</td>
                    <td className="py-1.5 pr-3 text-ink-2 whitespace-nowrap">
                      {row.lastActivity ? (
                        relativeTime(row.lastActivity)
                      ) : (
                        <span className="text-ink-4">—</span>
                      )}
                    </td>
                    <td className={`py-1.5 pr-3 ${row.delivery ? 'text-ink-1' : 'text-ink-4'}`}>
                      {row.delivery ? 'On' : 'Off'}
                    </td>
                    <td className="py-1.5 pr-3">
                      {row.plan === 'Pro' ? (
                        <span className="chip chip-done">Pro</span>
                      ) : (
                        <span className="text-ink-4">Free</span>
                      )}
                    </td>
                    <td className="py-1.5 text-ink-3 whitespace-nowrap">
                      {new Date(row.createdAt).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
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

export default Classrooms;
