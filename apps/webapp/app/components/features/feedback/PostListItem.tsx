import { Link } from 'react-router';
import { MessageSquareIcon } from 'lucide-react';
import { plainText } from './LinkedText';
import { CATEGORY_LABELS, CATEGORY_EMOJI, timeAgo, type FeedbackPostSummary } from './feedback';
import { StatusLabel } from './StatusLabel';
import { useOptimisticVote } from './useFeedbackAction';
import { VoteButton } from './VoteButton';

/**
 * One compact board row: vote, type + title, a one-line excerpt (desktop
 * only), posted date and replies, and the status in its own column (under
 * the title on phones).
 */
export function PostListItem({ post, signedIn }: { post: FeedbackPostSummary; signedIn: boolean }) {
  const vote = useOptimisticVote(
    'vote',
    'postId',
    post.id,
    post.vote_count,
    post.viewerVoted,
    signedIn
  );
  const excerpt = post.bug_what_happened || post.body;

  return (
    <article className="group relative grid grid-cols-[2.75rem_minmax(0,1fr)] items-center gap-4 border-b border-line px-2 py-3 transition-colors duration-150 hover:bg-panel-hover sm:grid-cols-[2.75rem_minmax(0,1fr)_auto] sm:px-3">
      <VoteButton
        size="stack"
        className="relative z-10"
        count={vote.count}
        voted={vote.voted}
        onToggle={vote.toggle}
      />
      <div className="min-w-0">
        <h3 className="text-[15px] font-semibold leading-snug text-ink-0">
          <span className="mr-1.5" role="img" aria-label={CATEGORY_LABELS[post.category]}>
            {CATEGORY_EMOJI[post.category]}
          </span>
          <Link
            to={`/feedback/p/${post.id}`}
            className="rounded-sm text-ink-0! no-underline after:absolute after:inset-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {post.title}
          </Link>
        </h3>
        {excerpt && (
          <p className="mt-0.5 hidden truncate text-[13px] text-ink-2 sm:block">
            {plainText(excerpt)}
          </p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-4">
          {post.status && (
            <span className="sm:hidden">
              <StatusLabel status={post.status} />
            </span>
          )}
          <span>{timeAgo(post.created_at)}</span>
          {post.comment_count > 0 && (
            <span className="inline-flex items-center gap-1">
              <MessageSquareIcon className="h-3.5 w-3.5" aria-hidden />
              {post.comment_count}
              <span className="sr-only">{post.comment_count === 1 ? 'reply' : 'replies'}</span>
            </span>
          )}
        </div>
      </div>
      <div className="hidden min-w-[7rem] justify-end sm:flex">
        {post.status && <StatusLabel status={post.status} />}
      </div>
    </article>
  );
}
