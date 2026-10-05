import { useCallback, useState } from 'react';
import { Link, useLoaderData, useLocation, useNavigate, useSearchParams } from 'react-router';
import type { LucideIcon } from 'lucide-react';
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  ClockIcon,
  FlameIcon,
  TrendingUpIcon,
} from 'lucide-react';
import { ClassmojiService, isFeedbackStatus, type FeedbackSort } from '@classmoji/services';
import { NewPostDialog } from '~/components/features/feedback/NewPostDialog';
import { PostListItem } from '~/components/features/feedback/PostListItem';
import {
  STATUS_META,
  STATUS_ORDER,
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

const isSort = (value: string | null): value is FeedbackSort =>
  value === 'top' || value === 'new' || value === 'trending';

export const loader = async ({ request }: Route.LoaderArgs) => {
  const url = new URL(request.url);
  const sortParam = url.searchParams.get('sort');
  const statusParam = url.searchParams.get('status');
  const sort: FeedbackSort = isSort(sortParam) ? sortParam : 'top';
  const status = isFeedbackStatus(statusParam) ? statusParam : null;
  const query = url.searchParams.get('q') ?? '';
  const { viewerId } = await feedbackViewer(request);
  const [posts, shipped] = await Promise.all([
    ClassmojiService.feedback.listPosts({ sort, status, query, viewerId }),
    ClassmojiService.feedback.listRecentlyShipped(5),
  ]);
  return { posts, shipped, sort, status, query, signedIn: Boolean(viewerId) };
};

export default function FeedbackBoard() {
  const { posts, shipped, sort, status, query, signedIn } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [dialogOpen, setDialogOpen] = useState(false);
  const closeDialog = useCallback(() => setDialogOpen(false), []);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { preventScrollReset: true, replace: true });
  };

  const openDialog = () => {
    if (!signedIn) navigate(signInHref(`${location.pathname}${location.search}`));
    else setDialogOpen(true);
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
              Tell us how Classmoji could work better for your class. Upvote the ideas you want
              most.
            </p>
          </div>
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
          <div className="flex items-center gap-2 py-2.5">
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
                <option value="">All statuses</option>
                {STATUS_ORDER.map(s => (
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
              {query || status ? 'No posts match' : 'No posts yet'}
            </p>
            <p className="mt-1 text-[13px] text-ink-2">
              {query || status
                ? 'Try another status, or create a post so others can vote on it.'
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
            <p className="mt-3 px-1 text-[13px] text-ink-4">Shipped requests will show up here.</p>
          )}
        </section>
      </aside>

      <NewPostDialog open={dialogOpen} onClose={closeDialog} />
    </div>
  );
}
