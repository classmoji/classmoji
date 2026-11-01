import { Form, Link, useLoaderData, useSearchParams } from 'react-router';
import { Empty, FilterChips, Pager, Sheet, TABLE_HEAD } from '~/components/ui';
import { relativeTime } from '~/utils/time';
import { loadActivity } from './route.server';

export const loader = loadActivity;

export const meta = () => [{ title: 'Activity log · Classmoji Admin' }];

const ACTION_CHIP: Record<string, { label: string; className: string }> = {
  impersonate: { label: 'View as', className: 'chip chip-submitted' },
  'delivery.toggle': { label: 'Delivery', className: 'chip chip-lect' },
  'delivery.bulk': { label: 'Delivery (bulk)', className: 'chip chip-lect' },
  'user.view': { label: 'Opened person', className: 'chip chip-ghost' },
  'classroom.view': { label: 'Opened class', className: 'chip chip-ghost' },
  export: { label: 'Export', className: 'chip chip-submitted' },
};

const ActivityLog = () => {
  const { rows, total, page, pageSize, kinds, actors, actor } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const keep = [...params.entries()].filter(([k]) => k !== 'actor' && k !== 'page');

  return (
    <Sheet className="min-h-[calc(100vh-14rem)]">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3 px-1">
        <FilterChips param="kind" options={kinds} />
        <Form method="get" onChange={e => e.currentTarget.requestSubmit()}>
          {keep.map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <label htmlFor="activity-actor" className="text-xs text-ink-3 mr-2">
            Admin
          </label>
          <select
            id="activity-actor"
            name="actor"
            defaultValue={actor}
            className="rounded-md border border-line bg-panel px-2 py-1 text-sm text-ink-0"
          >
            <option value="">Anyone</option>
            {actors.map(a => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Form>
      </div>

      {rows.length === 0 ? (
        <Empty
          title="Nothing recorded"
          hint="View as, content-delivery changes and page views appear here."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className={TABLE_HEAD}>
                <th className="font-semibold py-2 pr-3">When</th>
                <th className="font-semibold py-2 pr-3">Admin</th>
                <th className="font-semibold py-2 pr-3">Action</th>
                <th className="font-semibold py-2 pr-3">What</th>
                <th className="font-semibold py-2">Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const chip = ACTION_CHIP[r.action] ?? {
                  label: r.action,
                  className: 'chip chip-ghost',
                };
                return (
                  <tr key={r.id} className="border-t border-line row-hover">
                    <td
                      className="py-1.5 pr-3 text-ink-3 whitespace-nowrap tabular-nums"
                      title={new Date(r.at).toLocaleString()}
                    >
                      {relativeTime(r.at)}
                    </td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">
                      {r.actor ? (
                        <Link to={`/people/${r.actor.id}`} className="text-ink-1 hover:underline">
                          {r.actor.name ?? 'Unnamed'}
                        </Link>
                      ) : (
                        <span className="text-ink-4">deleted user</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3">
                      <span className={chip.className}>{chip.label}</span>
                    </td>
                    <td className="py-1.5 pr-3 text-ink-1">
                      {r.href ? (
                        <Link to={r.href} className="hover:underline">
                          {r.text}
                        </Link>
                      ) : (
                        r.text
                      )}
                    </td>
                    <td className="py-1.5 text-ink-3">
                      {r.reason ? `“${r.reason}”` : (r.filter ?? '')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pager page={page} pageSize={pageSize} total={total} />
    </Sheet>
  );
};

export default ActivityLog;
