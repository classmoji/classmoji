import { useCallback, useEffect, useState } from 'react';
import { useLoaderData, useLocation, useNavigate, useSearchParams } from 'react-router';
import { ChevronDownIcon, PlusIcon, SearchIcon } from 'lucide-react';
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
} from '~/components/features/feedback/feedback';
import { feedbackViewer } from '~/utils/feedbackViewer.server';
import type { Route } from './+types/route';

const SORTS: { id: FeedbackSort; label: string }[] = [
  { id: 'top', label: 'Top' },
  { id: 'new', label: 'New' },
  { id: 'trending', label: 'Trending' },
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
  const posts = await ClassmojiService.feedback.listPosts({
    sort,
    status,
    category,
    query,
    viewerId,
    scope: 'all',
  });
  return { posts, sort, status, category, query, signedIn: Boolean(viewerId) };
};

export default function FeedbackBoard() {
  const { posts, sort, status, category, query, signedIn } = useLoaderData<typeof loader>();
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

  const setCategory = (c: (typeof CATEGORY_ORDER)[number] | null) => {
    const next = new URLSearchParams(searchParams);
    if (c) next.set('type', c.toLowerCase());
    else next.delete('type');
    // A status filter from another type would match nothing.
    if (c && status && !STATUSES_BY_CATEGORY[c].includes(status)) next.delete('status');
    setSearchParams(next, { preventScrollReset: true, replace: true });
  };

  const filtered = Boolean(query || status || category);
  const selectClass =
    'h-[34px] cursor-pointer appearance-none rounded-lg border border-line-2 bg-panel pl-3 pr-8 text-[13px] text-ink-1 transition-colors duration-150 hover:border-line-strong focus:border-accent focus:outline-none';

  return (
    <div className="mx-auto w-full max-w-[1396px] px-4 pb-24 pt-8 sm:px-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-[22px] font-bold tracking-tight text-ink-0">Feedback</h1>
        <button
          type="button"
          onClick={openDialog}
          className="inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-accent px-4 text-[13px] font-semibold text-white transition-colors duration-150 hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
        >
          <PlusIcon className="h-4 w-4" aria-hidden />
          New post
        </button>
      </div>

      <div className="mt-5 flex flex-col gap-3 border-b border-line pb-3 md:flex-row md:items-center md:justify-between">
        <div role="group" aria-label="Type of post" className="flex flex-wrap gap-2">
          {[null, ...CATEGORY_ORDER].map(c => (
            <button
              key={c ?? 'all'}
              type="button"
              aria-pressed={category === c}
              onClick={() => setCategory(c)}
              className={`h-8 cursor-pointer rounded-full border px-3 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                category === c
                  ? 'border-line-strong bg-panel text-ink-0'
                  : 'border-line text-ink-3 hover:bg-panel-hover hover:text-ink-0'
              }`}
            >
              {c ? CATEGORY_FILTER_LABELS[c] : 'All'}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 md:flex-none">
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
              className="h-[34px] w-full rounded-lg border border-line-2 bg-panel pl-8 pr-3 text-[13px] text-ink-1 placeholder:text-ink-4 transition-colors duration-150 hover:border-line-strong focus:border-accent focus:outline-none md:w-56"
            />
          </div>
          <div className="relative">
            <label htmlFor="sort-select" className="sr-only">
              Sort posts
            </label>
            <select
              id="sort-select"
              value={sort}
              onChange={e => setParam('sort', e.target.value === 'top' ? null : e.target.value)}
              className={selectClass}
            >
              {SORTS.map(({ id, label }) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
            <ChevronDownIcon
              className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-3"
              aria-hidden
            />
          </div>
          <div className="relative">
            <label htmlFor="status-filter" className="sr-only">
              Filter by status
            </label>
            <select
              id="status-filter"
              value={status ?? ''}
              onChange={e => setParam('status', e.target.value || null)}
              className={selectClass}
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
        <div>
          {posts.map(post => (
            <PostListItem key={post.id} post={post} signedIn={signedIn} />
          ))}
        </div>
      ) : (
        <div className="py-16 text-center">
          <p className="text-sm font-semibold text-ink-0">
            {filtered ? 'No posts match' : 'No posts yet'}
          </p>
          {filtered ? (
            <button
              type="button"
              onClick={() => {
                setSearch('');
                const next = new URLSearchParams();
                const keptSort = searchParams.get('sort');
                if (keptSort) next.set('sort', keptSort);
                setSearchParams(next, { preventScrollReset: true, replace: true });
              }}
              className="mt-2 cursor-pointer text-[13px] font-medium text-accent hover:underline"
            >
              Clear filters
            </button>
          ) : (
            <p className="mt-1 text-[13px] text-ink-2">Be the first to suggest something.</p>
          )}
        </div>
      )}

      <NewPostDialog open={dialogOpen} onClose={closeDialog} initialCategory={newCategory} />
    </div>
  );
}
