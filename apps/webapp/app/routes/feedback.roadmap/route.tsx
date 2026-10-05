import { useState } from 'react';
import { plainText } from '~/components/features/feedback/LinkedText';
import { Link, useLoaderData } from 'react-router';
import { SearchIcon } from 'lucide-react';
import { ClassmojiService } from '@classmoji/services';
import { FeedbackAvatar } from '~/components/features/feedback/FeedbackAvatar';
import { StatusLabel } from '~/components/features/feedback/StatusLabel';
import { useOptimisticVote } from '~/components/features/feedback/useFeedbackAction';
import { VoteButton } from '~/components/features/feedback/VoteButton';
import {
  authorName,
  CATEGORY_EMOJI,
  CATEGORY_LABELS,
  STATUS_META,
  STATUS_ORDER,
  type FeedbackPostSummary,
} from '~/components/features/feedback/feedback';
import { feedbackViewer } from '~/utils/feedbackViewer.server';
import type { Route } from './+types/route';

export const loader = async ({ request }: Route.LoaderArgs) => {
  const { viewerId } = await feedbackViewer(request);
  const columns = await ClassmojiService.feedback.listRoadmap(viewerId);
  return { columns, signedIn: Boolean(viewerId) };
};

export const meta = () => [{ title: 'Roadmap - Classmoji' }];

function RoadmapCard({ post, signedIn }: { post: FeedbackPostSummary; signedIn: boolean }) {
  const vote = useOptimisticVote(
    'vote',
    'postId',
    post.id,
    post.vote_count,
    post.viewerVoted,
    signedIn
  );
  return (
    <li className="relative rounded-xl bg-panel p-[14px] ring-1 ring-stone-200 transition-[box-shadow] duration-150 hover:ring-line-strong dark:ring-neutral-800">
      <div className="flex items-start justify-between gap-3">
        <span className="inline-flex items-center gap-1.5 pt-1 text-[12px] font-medium text-ink-3">
          <span aria-hidden>{CATEGORY_EMOJI[post.category]}</span>
          {CATEGORY_LABELS[post.category]}
        </span>
        <VoteButton
          size="sm"
          className="relative z-10"
          count={vote.count}
          voted={vote.voted}
          onToggle={vote.toggle}
        />
      </div>
      <h3 className="mt-1 text-[13px] font-semibold leading-snug text-ink-0">
        <Link
          to={`/feedback/p/${post.id}`}
          className="rounded-sm text-ink-0! no-underline after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {post.title}
        </Link>
      </h3>
      {post.body && (
        <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-ink-2">
          {plainText(post.body)}
        </p>
      )}
      <div className="mt-3 flex items-center gap-2 text-[12px] text-ink-3">
        <FeedbackAvatar
          name={authorName(post.author, post.is_anonymous)}
          anonymous={post.is_anonymous}
          image={post.author?.image}
          size={20}
        />
        {authorName(post.author, post.is_anonymous)}
      </div>
    </li>
  );
}

export default function Roadmap() {
  const { columns, signedIn } = useLoaderData<typeof loader>();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  return (
    <div>
      {/* A full-width search strip under the header, like the board's own. */}
      <div className="border-b border-line bg-stone-100/70 dark:bg-neutral-900">
        <div className="relative mx-auto max-w-[1396px] px-6">
          <SearchIcon
            className="pointer-events-none absolute left-6 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-4"
            aria-hidden
          />
          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search the roadmap"
            className="h-10 w-full appearance-none border-0! bg-transparent pl-7 text-[13px] text-ink-0 shadow-none! outline-none! ring-0! placeholder:text-ink-4 focus:border-0! focus:shadow-none! focus:outline-none! focus:ring-0! focus-visible:outline-none!"
          />
        </div>
      </div>

      <div className="mx-auto max-w-[1396px] px-6 pb-24 pt-8">
        <div className="grid gap-8 md:grid-cols-2 md:gap-10 xl:grid-cols-[repeat(4,307px)] xl:justify-between xl:gap-10">
          {STATUS_ORDER.map(status => {
            const posts = columns[status].filter(p => !q || p.title.toLowerCase().includes(q));
            return (
              <section key={status} aria-labelledby={`col-${status}`} className="min-w-0">
                <div className="px-1">
                  <h2 id={`col-${status}`} className="flex items-center gap-2">
                    <StatusLabel status={status} size="md" />
                    <span className="text-[13px] tabular-nums text-ink-4">{posts.length}</span>
                  </h2>
                  <p className="mt-0.5 text-[13px] text-ink-3">{STATUS_META[status].description}</p>
                </div>
                <ul className="mt-4 flex flex-col gap-3">
                  {posts.map(post => (
                    <RoadmapCard key={post.id} post={post} signedIn={signedIn} />
                  ))}
                  {posts.length === 0 && (
                    <li className="rounded-xl border border-dashed border-line-2 px-4 py-8 text-center text-[13px] text-ink-4">
                      Nothing here yet
                    </li>
                  )}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
