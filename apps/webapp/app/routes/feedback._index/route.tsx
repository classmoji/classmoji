import { useCallback, useEffect, useState } from 'react';
import { Link, useLoaderData, useLocation, useNavigate, useSearchParams } from 'react-router';
import type { LucideIcon } from 'lucide-react';
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  ClockIcon,
  FlameIcon,
  SearchIcon,
  TrendingUpIcon,
} from 'lucide-react';
import { ClassmojiService, isFeedbackStatus, type FeedbackSort } from '@classmoji/services';
import { NewPostDialog } from '~/components/features/feedback/NewPostDialog';
import { PostListItem } from '~/components/features/feedback/PostListItem';
import {
  CATEGORY_FILTER_LABELS,
  CATEGORY_ORDER,
  ALL_STATUSES,
  STATUS_META,
  STATUSES_BY_CATEGORY,
  isCategory,
  signInHref,
  timeAgo,
} from '~/components/features/feedback/feedback';
import { feedbackViewer } from '~/utils/feedbackViewer.server';
import type { Route } from './+types/route';

const SORTS: { id: FeedbackSort; label: string; icon: LucideIcon }[] = [
  { id: 'top', label: 'Top', icon: TrendingUpIcon },
  { id: 'new', label: 'New', icon: ClockIcon },
  { id: 'trending', label: 'Trending', icon: FlameIcon },
];

/** `?new=` / `?type=` take lower case (`bug`); the database holds `BUG`. */
const categoryParam = (value: string | null) => {
  const upper = value?.toUpperCase() ?? null;
  return isCategory(upper) ? upper : null;
};

const isSort = (value: string | null): value is FeedbackSort =>
  value === 'top' || value === 'new' || value === 'trending';

export const loader = async ({ request }: Route.LoaderArgs) => {
  const url = new URL(request.url);
  const sortParam = url.searchParams.get('sort');
  const statusParam = url.searchParams.get('status');
  const sort: FeedbackSort = isSort(sortParam) ? sortParam : 'top';
  const status = isFeedbackStatus(statusParam) ? statusParam : null;
  const category = categoryParam(url.searchParams.get('type'));
  const query = url.searchParams.get('q') ?? '';
  const { viewerId } = await feedbackViewer(request);
  const [posts, shipped] = await Promise.all([
    ClassmojiService.feedback.listPosts({ sort, status, category, query, viewerId }),
    ClassmojiService.feedback.listRecentlyShipped(5),
  ]);
  return { posts, shipped, sort, status, category, query, signedIn: Boolean(viewerId) };
};

export default function FeedbackBoard() {
  const { posts, shipped, sort, status, category, query, signedIn } =
    useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newCategory, setNewCategory] = useState<ReturnType<typeof categoryParam>>(null);
  const closeDialog = useCallback(() => setDialogOpen(false), []);

  // `?new=feature|bug|question` (the help dialog's links) opens the form with
  // that type picked; signed out, sign-in comes back here with the same link.
  useEffect(() => {
    const wanted = categoryParam(searchParams.get('new'));
    if (!wanted) return;
    if (!signedIn) {
      navigate(signInHref(`${location.pathname}${location.search}`));
      return;
    }
    setNewCategory(wanted);
    setDialogOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete('new');
    setSearchParams(next, { replace: true, preventScrollReset: true });
    // Runs when the link arrives, not on every filter change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.get('new'), signedIn]);

  // The search box types freely; the URL (and the loader) follow a beat later.
  const [search, setSearch] = useState(query);
  useEffect(() => setSearch(query), [query]);
  useEffect(() => {
    if (search.trim() === query) return;
    const timer = window.setTimeout(() => setParam('q', search.trim() || null), 300);
    return () => window.clearTimeout(timer);
    // `setParam` is rebuilt each render; the search text is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { preventScrollReset: true, replace: true });
  };

  const openDialog = () => {
    if (!signedIn) navigate(signInHref(`${location.pathname}${location.search}`));
    else {
      setNewCategory(null);
      setDialogOpen(true);
    }
  };

  return (
    <div className="mx-auto grid max-w-6xl gap-10 px-6 pb-24 pt-10 lg:grid-cols-[minmax(0,1fr)_280px] lg:gap-14">
      <section
        aria-labelledby="feedback-heading"
        className="overflow-hidden rounded-2xl bg-panel ring-1 ring-stone-200 dark:ring-neutral-800"
      >
        <div className="flex flex-col gap-4 px-8 pb-5 pt-7 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 id="feedback-heading" className="text-lg font-bold tracking-tight text-ink-0">
              Have something to say?
            </h1>
            <p className="mt-1 text-[13px] text-ink-2">
              Ask a question, report a bug, or suggest what Classmoji should do next. Upvote the
              ideas you want most.
            </p>
          </div>
        </div>

        <div role="group" aria-label="Type of post" className="flex flex-wrap gap-2 px-8 pb-4">
          {[null, ...CATEGORY_ORDER].map(c => (
            <button
              key={c ?? 'all'}
              type="button"
              aria-pressed={category === c}
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                if (c) next.set('type', c.toLowerCase());
                else next.delete('type');
                // A status filter from another type would match nothing.
                if (c && status && !STATUSES_BY_CATEGORY[c].includes(status)) next.delete('status');
                setSearchParams(next, { preventScrollReset: true, replace: true });
              }}
              className={`cursor-pointer rounded-full border px-3 py-1 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                category === c
                  ? 'border-line-strong bg-stone-50 text-ink-0 dark:bg-neutral-800/60'
                  : 'border-line text-ink-3 hover:bg-panel-hover hover:text-ink-0'
              }`}
            >
              {c ? CATEGORY_FILTER_LABELS[c] : 'All'}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-3 border-y border-line px-8 md:flex-row md:items-stretch md:justify-between">
          <div role="tablist" aria-label="Sort posts" className="flex gap-5 self-stretch">
            {SORTS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                role="tab"
                type="button"
                aria-selected={sort === id}
                onClick={() => setParam('sort', id === 'top' ? null : id)}
                className={`-mb-px inline-flex cursor-pointer items-center gap-1.5 border-b-2 py-3 md:py-0 text-[13px] font-medium transition-colors duration-150 ${
                  sort === id
                    ? 'border-accent text-ink-0'
                    : 'border-transparent text-ink-3 hover:text-ink-0'
                }`}
              >
                <Icon className="h-4 w-4" aria-hidden />
                {label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 py-2.5">
            <div className="relative">
              <SearchIcon
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-3"
                aria-hidden
              />
              <label htmlFor="board-search" className="sr-only">
                Search posts
              </label>
              <input
                id="board-search"
                type="search"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search posts"
                className="h-[32px] w-full rounded-lg border border-line-2 bg-panel pl-8 pr-3 text-[13px] text-ink-1 placeholder:text-ink-4 transition-colors duration-150 hover:border-line-strong focus:border-accent focus:outline-none sm:w-56"
              />
            </div>
            <label htmlFor="status-filter" className="sr-only">
              Filter by status
            </label>
            <div className="relative">
              <select
                id="status-filter"
                value={status ?? ''}
                onChange={e => setParam('status', e.target.value || null)}
                className="h-[32px] cursor-pointer appearance-none rounded-lg border border-line-2 bg-panel pl-3 pr-8 text-[13px] text-ink-1 transition-colors duration-150 hover:border-line-strong focus:border-accent focus:outline-none"
              >
                <option value="">All open</option>
                {(category ? STATUSES_BY_CATEGORY[category] : ALL_STATUSES).map(s => (
                  <option key={s} value={s}>
                    {STATUS_META[s].label}
                  </option>
                ))}
              </select>
              <ChevronDownIcon
                className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-3"
                aria-hidden
              />
            </div>
          </div>
        </div>

        {posts.length > 0 ? (
          <div className="divide-y divide-line">
            {posts.map(post => (
              <PostListItem key={post.id} post={post} signedIn={signedIn} />
            ))}
          </div>
        ) : (
          <div className="px-8 py-16 text-center">
            <p className="text-sm font-semibold text-ink-0">
              {query || status || category ? 'No posts match' : 'No posts yet'}
            </p>
            <p className="mt-1 text-[13px] text-ink-2">
              {query || status || category
                ? 'Try another filter, or create a post so others can vote on it.'
                : 'Be the first to suggest something.'}
            </p>
          </div>
        )}
      </section>

      <aside className="flex flex-col gap-8 lg:sticky lg:top-6 lg:self-start">
        <button
          type="button"
          onClick={openDialog}
          className="inline-flex h-11 w-full cursor-pointer items-center justify-center rounded-xl bg-accent text-[13px] font-semibold text-white transition-colors duration-150 hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
        >
          Create a new post
        </button>

        <section aria-labelledby="shipped-heading">
          <h2
            id="shipped-heading"
            className="flex items-center gap-2 px-1 text-[12px] font-semibold uppercase tracking-wide text-ink-3"
          >
            <CheckCircle2Icon className="h-4 w-4 text-mint-ink" aria-hidden />
            Recently shipped
          </h2>
          {shipped.length > 0 ? (
            <ul className="mt-3 flex flex-col">
              {shipped.map(post => (
                <li key={post.id}>
                  <Link
                    to={`/feedback/p/${post.id}`}
                    className="block rounded-lg px-1 py-2 text-ink-0! no-underline transition-colors duration-150 hover:bg-panel-hover"
                  >
                    <span className="line-clamp-2 text-[13px] font-medium leading-snug">
                      {post.title}
                    </span>
                    {post.status_changed_at && (
                      <span className="mt-0.5 block text-[12px] text-ink-4">
                        {timeAgo(post.status_changed_at)}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 px-1 text-[13px] text-ink-4">Shipped posts will show up here.</p>
          )}
        </section>
      </aside>

      <NewPostDialog open={dialogOpen} onClose={closeDialog} initialCategory={newCategory} />
    </div>
  );
}
