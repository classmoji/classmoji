import { Link, useLoaderData } from 'react-router';
import { loadFeedbackRanking } from './route.server';

export const loader = loadFeedbackRanking;

export const meta = () => [{ title: 'Feedback · Classmoji Admin' }];

const STATUS_LABELS: Record<string, string> = {
  IN_REVIEW: 'In review',
  PLANNED: 'Planned',
  IN_PROGRESS: 'In progress',
};

const ROLE_LABELS = { INSTRUCTOR: 'Instructor', TA: 'TA', STUDENT: 'Student', OTHER: 'No class' };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Feature requests by voters, then classes: which one to build next. */
export default function FeedbackRanking() {
  const { ranking, selectedId, voters, webappUrl } = useLoaderData<typeof loader>();
  const selected = ranking.find(post => post.id === selectedId) ?? null;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 mt-2 mb-4">
        <h1 className="text-lg font-semibold text-ink-1">Feature requests</h1>
        <p className="text-xs text-ink-3">Open requests, duplicates merged. Most voters first.</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="rounded-2xl bg-panel ring-1 ring-line px-3 py-4 sm:px-4 overflow-x-auto">
          {ranking.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <div className="font-medium">No open feature requests</div>
              <div className="text-sm">They show up here as people post and vote.</div>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-ink-3">
                  <th className="px-2 py-2 font-semibold">Request</th>
                  <th className="px-2 py-2 font-semibold">Voters</th>
                  <th className="px-2 py-2 font-semibold">Who</th>
                  <th className="px-2 py-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {ranking.map(post => (
                  <tr
                    key={post.id}
                    className={`border-t border-line ${post.id === selectedId ? 'bg-panel-hover' : ''}`}
                  >
                    <td className="px-2 py-2.5">
                      <Link
                        to={`?post=${post.id}`}
                        preventScrollReset
                        className="font-medium text-ink-0 hover:underline"
                      >
                        {post.title}
                      </Link>
                    </td>
                    <td className="px-2 py-2.5 font-semibold tabular-nums text-ink-0">
                      {post.voters}
                    </td>
                    <td className="px-2 py-2.5 text-xs text-ink-2 whitespace-nowrap">
                      {[
                        post.roles.INSTRUCTOR && `${post.roles.INSTRUCTOR} instr`,
                        post.roles.TA && `${post.roles.TA} TA`,
                        post.roles.STUDENT && `${post.roles.STUDENT} stud`,
                        post.roles.OTHER && `${post.roles.OTHER} other`,
                      ]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </td>
                    <td className="px-2 py-2.5 text-xs text-ink-2">
                      {post.status ? (STATUS_LABELS[post.status] ?? post.status) : 'No status'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-3 px-2 text-xs text-ink-3">
            No weighted score: the vote count as it is. Each voter counts by their highest role in
            any class (as of today).
          </p>
        </div>

        <aside className="rounded-2xl bg-panel ring-1 ring-line px-4 py-4 self-start">
          {selected && voters ? (
            <>
              <h2 className="text-sm font-semibold text-ink-0">{selected.title}</h2>
              <p className="mt-0.5 text-xs text-ink-3">
                {plural(voters.length, 'voter')} · admins only, never on the board
              </p>
              <ul className="mt-3 divide-y divide-line text-sm">
                {voters.map(voter => (
                  <li key={voter.userId} className="flex items-start justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-ink-0">
                        {voter.name || voter.email || 'Unnamed'}
                      </div>
                      <div className="truncate text-xs text-ink-3">{voter.email}</div>
                    </div>
                    <div className="shrink-0 text-right text-xs text-ink-1">
                      {ROLE_LABELS[voter.role]}
                    </div>
                  </li>
                ))}
              </ul>
              <a
                href={`${webappUrl}/feedback/p/${selected.id}`}
                className="mt-3 inline-block text-sm text-accent hover:underline"
              >
                Open the post
              </a>
            </>
          ) : (
            <div className="text-center py-12 text-gray-500">
              <div className="font-medium">Pick a request</div>
              <div className="text-sm">See who voted for it.</div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
