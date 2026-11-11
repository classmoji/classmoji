import { useEffect, useState } from 'react';
import { Link, useFetcher, useLoaderData, useNavigate, useSearchParams } from 'react-router';
import {
  BTN_PRIMARY_XS,
  BTN_XS,
  Empty,
  FilterChips,
  SearchBox,
  Sheet,
  TABLE_HEAD,
  withParams,
} from '~/components/ui';
import { useNow } from '~/hooks/useNow';
import { relativeTime } from '~/utils/time';
import { feedbackAction, loadFeedback, type Category } from './route.server';

export const loader = loadFeedback;
export const action = feedbackAction;

export const meta = () => [{ title: 'Feedback · Classmoji Admin' }];

type Data = Awaited<ReturnType<typeof loadFeedback>>;

const CATEGORY_LABEL: Record<Category, string> = {
  FEATURE: 'Features',
  BUG: 'Bugs',
  QUESTION: 'Questions',
};

const ROLE_LABELS = { INSTRUCTOR: 'Instructor', TA: 'TA', STUDENT: 'Student', OTHER: 'No class' };

const STATUS_CHIP: Record<string, string> = {
  IN_REVIEW: 'chip chip-upcoming',
  PLANNED: 'chip chip-inprog',
  IN_PROGRESS: 'chip chip-submitted',
  COMPLETED: 'chip chip-done',
  FIXED: 'chip chip-done',
  ANSWERED: 'chip chip-done',
};

/** Instructor · TA · student share of the voters, as one small bar. */
const Mix = ({ roles }: { roles: Record<string, number> }) => {
  const total = Object.values(roles).reduce((a, b) => a + b, 0);
  if (!total) return <span className="text-ink-4">—</span>;
  const parts = [
    { k: 'INSTRUCTOR', c: 'var(--ink-0)' },
    { k: 'TA', c: 'var(--ink-3)' },
    { k: 'STUDENT', c: 'var(--line-strong)' },
    { k: 'OTHER', c: 'var(--line)' },
  ];
  const title = parts
    .filter(p => roles[p.k])
    .map(p => `${roles[p.k]} ${ROLE_LABELS[p.k as keyof typeof ROLE_LABELS]}`)
    .join(' · ');
  return (
    <span
      className="inline-flex h-1.5 w-20 rounded-full overflow-hidden align-middle"
      title={title}
    >
      {parts.map(p =>
        roles[p.k] ? (
          <span key={p.k} style={{ width: `${(100 * roles[p.k]) / total}%`, background: p.c }} />
        ) : null
      )}
    </span>
  );
};

const StatusEditor = ({ post, data }: { post: NonNullable<Data['selected']>; data: Data }) => {
  const fetcher = useFetcher<{ ok?: boolean; error?: string; message?: string }>();
  const [status, setStatus] = useState(post.status ?? '');
  const [note, setNote] = useState('');
  useEffect(() => {
    setStatus(post.status ?? '');
    setNote('');
  }, [post.id, post.status]);
  useEffect(() => {
    if (fetcher.data?.ok) setNote('');
  }, [fetcher.data]);
  return (
    <fetcher.Form method="post" className="space-y-2">
      <input type="hidden" name="intent" value="status" />
      <input type="hidden" name="postId" value={post.id} />
      <div className="flex items-center gap-2">
        <label htmlFor="fb-status" className="text-xs text-ink-3">
          Status
        </label>
        <select
          id="fb-status"
          name="status"
          value={status}
          onChange={e => setStatus(e.target.value)}
          className="rounded-md border border-line bg-panel px-2 py-1 text-sm text-ink-0"
        >
          <option value="">No status</option>
          {data.statuses.map(s => (
            <option key={s} value={s}>
              {data.statusLabels[s] ?? s}
            </option>
          ))}
        </select>
      </div>
      <textarea
        name="note"
        value={note}
        onChange={e => setNote(e.target.value)}
        maxLength={1000}
        rows={2}
        placeholder="Public note (optional). Followers are notified when the status changes or a note is added."
        aria-label="Public note"
        className="w-full rounded-md border border-line bg-panel px-2.5 py-1.5 text-sm text-ink-0 placeholder:text-ink-4 focus:outline-none focus:border-line-strong"
      />
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={fetcher.state !== 'idle' || (status === (post.status ?? '') && !note.trim())}
          className={BTN_PRIMARY_XS}
        >
          {fetcher.state !== 'idle' ? 'Saving…' : 'Save'}
        </button>
        {fetcher.data?.error ? (
          <span role="alert" className="text-xs text-red-600 dark:text-red-400">
            {fetcher.data.error}
          </span>
        ) : fetcher.data?.message ? (
          <span className="text-xs text-mint-ink">{fetcher.data.message}</span>
        ) : null}
      </div>
    </fetcher.Form>
  );
};

const MergeControl = ({ post, data }: { post: NonNullable<Data['selected']>; data: Data }) => {
  const fetcher = useFetcher<{ ok?: boolean; error?: string; redirectTo?: string }>();
  const [open, setOpen] = useState(false);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  useEffect(() => {
    if (fetcher.data?.redirectTo) {
      navigate(withParams(params, { post: fetcher.data.redirectTo }), { replace: true });
      setOpen(false);
    }
  }, [fetcher.data, navigate, params]);
  if (!open) {
    return (
      <button type="button" className={BTN_XS} onClick={() => setOpen(true)}>
        Merge into…
      </button>
    );
  }
  return (
    <fetcher.Form method="post" className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="intent" value="merge" />
      <input type="hidden" name="postId" value={post.id} />
      <select
        name="originalId"
        aria-label="Merge into"
        defaultValue=""
        className="max-w-[16rem] rounded-md border border-line bg-panel px-2 py-1 text-sm text-ink-0"
      >
        <option value="" disabled>
          Pick the original…
        </option>
        {data.mergeTargets.map(t => (
          <option key={t.id} value={t.id}>
            {t.title} ({t.vote_count})
          </option>
        ))}
      </select>
      <button type="submit" className={BTN_PRIMARY_XS} disabled={fetcher.state !== 'idle'}>
        Merge
      </button>
      <button type="button" className={BTN_XS} onClick={() => setOpen(false)}>
        Cancel
      </button>
      {fetcher.data?.error ? (
        <span role="alert" className="text-xs text-red-600 dark:text-red-400">
          {fetcher.data.error}
        </span>
      ) : null}
      <p className="w-full text-[11px] text-ink-3">
        Votes, follows and comments move to the original; this post&apos;s link redirects there.
      </p>
    </fetcher.Form>
  );
};

const Detail = ({ data }: { data: Data }) => {
  const post = data.selected;
  const [params] = useSearchParams();
  const now = useNow();
  if (!post) {
    return (
      <Sheet className="self-start">
        <Empty title="Pick a post" hint="Read it, set its status, merge it, see who voted." />
      </Sheet>
    );
  }
  const bugParts = [
    ['What happened', post.bug.whatHappened],
    ['Expected', post.bug.expected],
    ['Steps', post.bug.steps],
  ].filter(([, v]) => v) as Array<[string, string]>;

  return (
    <section className="rounded-2xl bg-panel ring-1 ring-line self-start min-w-0 lg:sticky lg:top-4 max-h-[calc(100vh-2rem)] overflow-y-auto">
      <div className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-sm font-semibold text-ink-0">{post.title}</h2>
          <a
            href={`${data.webappUrl}/feedback/p/${post.id}`}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-ink-3 hover:text-ink-1 whitespace-nowrap"
          >
            Open on board ↗
          </a>
        </div>
        <p className="text-xs text-ink-3">
          {post.author ? (
            <Link to={`/people/${post.author.id}`} className="hover:underline">
              {post.author.name ?? 'Someone'}
            </Link>
          ) : (
            'Anonymous'
          )}{' '}
          · {relativeTime(post.createdAt, now)} · {post.votes} vote{post.votes === 1 ? '' : 's'}
        </p>
        {bugParts.length ? (
          <dl className="space-y-2 text-sm">
            {bugParts.map(([label, value]) => (
              <div key={label}>
                <dt className="text-[11px] uppercase tracking-wider text-ink-4">{label}</dt>
                <dd className="text-ink-1 whitespace-pre-wrap">{value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-sm text-ink-1 whitespace-pre-wrap">{post.body}</p>
        )}
        <div className="border-t border-line pt-3 space-y-3">
          <StatusEditor post={post} data={data} />
          <MergeControl post={post} data={data} />
        </div>
      </div>

      <nav className="flex gap-1 border-y border-line px-4">
        {(['voters', 'comments'] as const).map(t => (
          <Link
            key={t}
            to={withParams(params, { tab: t === 'voters' ? null : t })}
            preventScrollReset
            className={`-mb-px px-2.5 py-2 text-sm border-b-2 ${
              data.tab === t
                ? 'border-accent text-ink-0 font-medium'
                : 'border-transparent text-ink-3'
            }`}
          >
            {t === 'voters'
              ? `Voters ${data.voters?.length ?? 0}`
              : `Comments ${post.comments.length + post.updates.length}`}
          </Link>
        ))}
      </nav>

      {data.tab === 'voters' ? (
        data.voters && data.voters.length ? (
          <ul className="divide-y divide-line">
            {data.voters.map(v => (
              <li
                key={v.userId}
                className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
              >
                <div className="min-w-0">
                  <Link
                    to={`/people/${v.userId}`}
                    className="block truncate font-medium text-ink-0 hover:underline"
                  >
                    {v.name || v.email || 'Unnamed'}
                  </Link>
                  <span className="block truncate text-xs text-ink-3">{v.email}</span>
                </div>
                <span className="text-xs text-ink-1 shrink-0">{ROLE_LABELS[v.role]}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="No votes yet" />
        )
      ) : (
        <ol className="px-4 py-3 space-y-3 text-sm">
          {[
            ...post.updates.map(u => ({
              key: `u-${u.createdAt}`,
              at: u.createdAt,
              who: 'Classmoji team',
              id: null as string | null,
              body: `${u.to ? `→ ${data.statusLabels[u.to] ?? u.to}. ` : ''}${u.note ?? ''}`,
              maintainer: true,
            })),
            ...post.comments.flatMap(c => [
              {
                key: c.id,
                at: c.createdAt,
                who: c.author?.name ?? 'Anonymous',
                id: c.author?.id ?? null,
                body: c.body,
                maintainer: c.maintainer,
              },
              ...c.replies.map(r => ({
                key: r.id,
                at: r.createdAt,
                who: `↳ ${r.author?.name ?? 'Anonymous'}`,
                id: r.author?.id ?? null,
                body: r.body,
                maintainer: r.maintainer,
              })),
            ]),
          ]
            .sort((a, b) => a.at.localeCompare(b.at))
            .map(c => (
              <li key={c.key}>
                <div className="text-xs text-ink-3">
                  {c.id ? (
                    <Link to={`/people/${c.id}`} className="font-medium text-ink-1 hover:underline">
                      {c.who}
                    </Link>
                  ) : (
                    <span className="font-medium text-ink-1">{c.who}</span>
                  )}
                  {c.maintainer ? <span className="chip chip-inprog ml-1.5">team</span> : null} ·{' '}
                  {relativeTime(c.at, now)}
                </div>
                <p className="text-ink-1 whitespace-pre-wrap">{c.body}</p>
              </li>
            ))}
          {post.comments.length + post.updates.length === 0 ? (
            <li className="text-ink-3">No comments yet. Reply on the board.</li>
          ) : null}
        </ol>
      )}
    </section>
  );
};

const Feedback = () => {
  const data = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const now = useNow();

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 mt-2 mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold text-ink-1">Feedback</h1>
          <div className="inline-flex rounded-lg border border-line p-0.5 text-sm bg-panel">
            {(Object.keys(CATEGORY_LABEL) as Category[]).map(c => (
              <Link
                key={c}
                to={`?category=${c}`}
                aria-current={c === data.category ? 'true' : undefined}
                className={`rounded-md px-3 py-1 ${
                  c === data.category
                    ? 'bg-nav-hover text-ink-0 font-medium'
                    : 'text-ink-2 hover:text-ink-0'
                }`}
              >
                {CATEGORY_LABEL[c]}
                <span className="ml-1 text-ink-4 tabular-nums">{data.categoryCounts[c]}</span>
              </Link>
            ))}
          </div>
        </div>
        <SearchBox
          query={data.query}
          placeholder="Search posts…"
          label="Search posts"
          className="sm:w-64"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
        <Sheet className="min-w-0">
          <div className="mb-3 px-1">
            <FilterChips
              param="state"
              options={[
                { value: '', label: 'Open', count: data.stateCounts.open },
                { value: 'stale', label: 'No reply in 7+ days', count: data.stateCounts.stale },
                {
                  value: 'closed',
                  label:
                    data.category === 'BUG'
                      ? 'Fixed'
                      : data.category === 'QUESTION'
                        ? 'Answered'
                        : 'Completed',
                  count: data.stateCounts.closed,
                },
                { value: 'all', label: 'All', count: data.stateCounts.all },
              ]}
            />
          </div>
          {data.posts.length === 0 ? (
            <Empty title="Nothing here" hint={data.query ? 'Try a different search.' : undefined} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className={TABLE_HEAD}>
                    <th className="font-semibold py-2 pr-3">Post</th>
                    {data.category === 'FEATURE' ? (
                      <>
                        <th className="font-semibold py-2 pr-3 text-right">Votes</th>
                        <th className="font-semibold py-2 pr-3">Who</th>
                      </>
                    ) : (
                      <th className="font-semibold py-2 pr-3">From</th>
                    )}
                    <th className="font-semibold py-2 pr-3">Status</th>
                    <th className="font-semibold py-2 pr-3">Last reply</th>
                    <th className="font-semibold py-2">Posted</th>
                  </tr>
                </thead>
                <tbody>
                  {data.posts.map(p => {
                    const stale =
                      !p.lastReplyAt &&
                      now.getTime() - new Date(p.createdAt).getTime() > 7 * 86_400_000;
                    return (
                      <tr
                        key={p.id}
                        className={`border-t border-line ${p.id === data.selected?.id ? 'bg-nav-hover' : 'row-hover'}`}
                      >
                        <td className="py-1.5 pr-3 max-w-[22rem]">
                          <Link
                            to={withParams(params, { post: p.id, tab: null })}
                            preventScrollReset
                            className="font-medium text-ink-0 hover:underline"
                          >
                            {p.title}
                          </Link>
                          {p.comments ? (
                            <span className="ml-1.5 text-xs text-ink-4">💬 {p.comments}</span>
                          ) : null}
                        </td>
                        {data.category === 'FEATURE' ? (
                          <>
                            <td className="py-1.5 pr-3 text-right font-semibold tabular-nums">
                              {p.votes}
                            </td>
                            <td className="py-1.5 pr-3">
                              {p.roles ? <Mix roles={p.roles} /> : null}
                            </td>
                          </>
                        ) : (
                          <td className="py-1.5 pr-3 text-ink-2 whitespace-nowrap">
                            {p.author?.name ?? 'Anonymous'}
                          </td>
                        )}
                        <td className="py-1.5 pr-3">
                          {p.status ? (
                            <span className={STATUS_CHIP[p.status] ?? 'chip chip-ghost'}>
                              {data.statusLabels[p.status] ?? p.status}
                            </span>
                          ) : (
                            <span className="chip chip-ghost">No status</span>
                          )}
                        </td>
                        <td
                          className={`py-1.5 pr-3 whitespace-nowrap ${stale ? 'text-rose-ink' : 'text-ink-3'}`}
                        >
                          {p.lastReplyAt ? relativeTime(p.lastReplyAt, now) : 'none'}
                        </td>
                        <td className="py-1.5 text-ink-3 whitespace-nowrap">
                          {relativeTime(p.createdAt, now)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {data.category === 'FEATURE' ? (
            <p className="mt-3 px-1 text-xs text-ink-3">
              Votes are the count as it is. The bar shows instructors (dark), TAs and students
              (light), by each voter&apos;s highest role today.
            </p>
          ) : null}
        </Sheet>
        <Detail data={data} />
      </div>
    </>
  );
};

export default Feedback;
