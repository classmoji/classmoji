import { Form, Link, useLoaderData } from 'react-router';
import { IconSearch } from '@tabler/icons-react';
import { useDebouncedSearch } from '~/hooks/useDebouncedSearch';
import { loadClassrooms } from './route.server';
import type { ClassroomRow } from './route.server';

export const loader = loadClassrooms;

export const meta = () => [{ title: 'Classrooms · Classmoji Admin' }];

/** ACTIVE is the normal case and gets no badge — only exceptions are called out. */
const StatusBadge = ({ row }: { row: ClassroomRow }) => {
  if (row.isArchived) return <span className="chip chip-ghost">archived</span>;
  if (row.status === 'LOCKED') return <span className="chip chip-locked">locked</span>;
  if (row.status === 'UNPUBLISHED') return <span className="chip chip-upcoming">unpublished</span>;
  if (row.isExample) return <span className="chip chip-ghost">example</span>;
  return null;
};

const Classrooms = () => {
  const { rows, total, query } = useLoaderData<typeof loader>();
  const { inputRef, onSearchChange, searching } = useDebouncedSearch(query);

  return (
    <>
      <div className="flex items-center justify-between gap-3 mt-2 mb-4">
        <h1 className="text-lg font-semibold text-ink-1 shrink-0">Classrooms</h1>
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
              placeholder="Search by name, slug, or org…"
              aria-label="Search classrooms"
              className="w-full rounded-md border border-line bg-panel pl-9 pr-8 py-1.5 text-sm text-ink-0 placeholder:text-ink-4 focus:outline-none focus:border-line-strong"
            />
            {searching ? (
              <span
                aria-hidden
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

      <div className="rounded-2xl bg-panel ring-1 ring-line p-5 sm:p-6 min-h-[calc(100vh-14rem)]">
        <p className="text-xs text-ink-3 mb-3">
          {query ? `${total} matching “${query}”` : `${total} classrooms`}
        </p>

        {rows.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <div className="font-medium">No classrooms found</div>
            <div className="text-sm">
              {query ? 'Try a different search term.' : 'No classrooms exist yet.'}
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-ink-4">
                  <th className="font-semibold py-2 pr-4">Classroom</th>
                  <th className="font-semibold py-2 pr-4">Organization</th>
                  <th className="font-semibold py-2 pr-4 text-right">Students</th>
                  <th className="font-semibold py-2 pr-4 text-right">Staff</th>
                  <th className="font-semibold py-2 pr-4">Created</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.id} className="border-t border-line row-hover">
                    <td className="py-2.5 pr-4">
                      <Link
                        to={`/classrooms/${row.slug}`}
                        className="block min-w-0 hover:underline"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-ink-0 font-medium truncate">{row.name}</span>
                          <StatusBadge row={row} />
                        </div>
                        <div className="text-ink-3 text-xs truncate">{row.slug}</div>
                      </Link>
                    </td>
                    <td className="py-2.5 pr-4 text-ink-2">{row.orgLogin}</td>
                    <td className="py-2.5 pr-4 text-ink-1 text-right tabular-nums">
                      {row.students}
                    </td>
                    <td className="py-2.5 pr-4 text-ink-1 text-right tabular-nums">{row.staff}</td>
                    <td className="py-2.5 pr-4 text-ink-3 whitespace-nowrap">
                      {new Date(row.createdAt).toLocaleDateString()}
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

export default Classrooms;
