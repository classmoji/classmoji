import { Link } from 'react-router';
import { plainText } from './LinkedText';
import { MessageSquareIcon } from 'lucide-react';
import { FeedbackAvatar } from '~/components/features/feedback/FeedbackAvatar';
import { authorName, timeAgo, type FeedbackPostSummary } from './feedback';
import { StatusLabel } from './StatusLabel';
import { useOptimisticVote } from './useFeedbackAction';
import { VoteButton } from './VoteButton';

export function PostListItem({ post, signedIn }: { post: FeedbackPostSummary; signedIn: boolean }) {
  const vote = useOptimisticVote(
    'vote',
    'postId',
    post.id,
    post.vote_count,
    post.viewerVoted,
    signedIn
  );

  return (
    <article className="group relative flex gap-8 px-8 py-5 transition-colors duration-150 hover:bg-panel-hover">
      <div className="min-w-0 flex-1">
        {post.status && (
          <div className="mb-1.5">
            <StatusLabel status={post.status} />
          </div>
        )}
        <h3 className="text-[15px] font-semibold leading-snug text-ink-0">
          <Link
            to={`/feedback/p/${post.id}`}
            className="rounded-sm text-ink-0! no-underline after:absolute after:inset-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {post.title}
          </Link>
        </h3>
        {post.body && (
          <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-ink-2">
            {plainText(post.body)}
          </p>
        )}
        <div className="mt-3 flex items-center gap-2 text-[12px]">
          <FeedbackAvatar
            name={authorName(post.author, post.is_anonymous)}
            anonymous={post.is_anonymous}
            image={post.author?.image}
            size={22}
          />
          <span className="font-medium text-ink-1">
            {authorName(post.author, post.is_anonymous)}
          </span>
          <span className="text-ink-4">{timeAgo(post.created_at)}</span>
          {post.comment_count > 0 && (
            <span className="ml-auto inline-flex items-center gap-1.5 text-ink-3">
              <MessageSquareIcon className="h-3.5 w-3.5" aria-hidden />
              {post.comment_count}
              <span className="sr-only">comments</span>
            </span>
          )}
        </div>
      </div>
      <VoteButton
        className="relative z-10 self-start"
        count={vote.count}
        voted={vote.voted}
        onToggle={vote.toggle}
      />
    </article>
  );
}
