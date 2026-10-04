import { useState } from 'react';
import { Trash2Icon } from 'lucide-react';
import { FeedbackAvatar } from '~/components/features/feedback/FeedbackAvatar';
import { CommentComposer } from './CommentComposer';
import { LinkedText } from './LinkedText';
import { authorName, formatDate, type FeedbackCommentView } from './feedback';
import { useFeedbackAction, useOptimisticVote } from './useFeedbackAction';
import { VoteButton } from './VoteButton';

interface CommentItemProps {
  comment: FeedbackCommentView;
  postId: string;
  signedIn: boolean;
  viewerId: string | null;
  isAdmin: boolean;
  /** Replies are one level deep, so only top-level comments offer "Reply". */
  isReply?: boolean;
}

export function CommentItem({
  comment,
  postId,
  signedIn,
  viewerId,
  isAdmin,
  isReply = false,
}: CommentItemProps) {
  const [replying, setReplying] = useState(false);
  const vote = useOptimisticVote(
    'comment-vote',
    'commentId',
    comment.id,
    comment.vote_count,
    comment.viewerVoted,
    signedIn
  );
  const remove = useFeedbackAction(signedIn);
  const canDelete = isAdmin || (viewerId !== null && comment.author?.id === viewerId);
  const name = authorName(comment.author);

  if (remove.pending) return null;

  return (
    <li>
      <div className="flex items-center gap-2.5">
        <FeedbackAvatar name={name} image={comment.author?.image} size={isReply ? 24 : 32} />
        <span className="text-[13px] font-semibold text-ink-0">{name}</span>
        <span className="text-[12px] text-ink-4">{formatDate(comment.created_at)}</span>
      </div>
      <div className={isReply ? 'pl-[34px]' : 'pl-[42px]'}>
        <p className="mt-1.5 whitespace-pre-line break-words text-[13px] leading-relaxed text-ink-1">
          <LinkedText text={comment.body} />
        </p>
        <div className="mt-2 flex items-center justify-between">
          <div className="flex items-center gap-4">
            {!isReply && (
              <button
                type="button"
                onClick={() => setReplying(v => !v)}
                aria-expanded={replying}
                className="cursor-pointer rounded-md text-[12px] font-medium text-ink-3 transition-colors duration-150 hover:text-ink-0"
              >
                Reply
              </button>
            )}
            {canDelete && (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm('Delete this comment and its replies?')) {
                    remove.submit({ intent: 'delete-comment', commentId: comment.id });
                  }
                }}
                className="inline-flex cursor-pointer items-center gap-1 rounded-md text-[12px] font-medium text-ink-4 transition-colors duration-150 hover:text-rose-ink"
              >
                <Trash2Icon className="h-3.5 w-3.5" aria-hidden />
                Delete
              </button>
            )}
          </div>
          <VoteButton size="sm" count={vote.count} voted={vote.voted} onToggle={vote.toggle} />
        </div>
        {replying && (
          <div className="mt-3">
            <CommentComposer
              compact
              autoFocus
              postId={postId}
              parentId={comment.id}
              signedIn={signedIn}
              placeholder={`Reply to ${name}…`}
              onCancel={() => setReplying(false)}
              onPosted={() => setReplying(false)}
            />
          </div>
        )}
        {comment.replies && comment.replies.length > 0 && (
          <ul className="mt-4 flex flex-col gap-5 border-l border-line pl-4">
            {comment.replies.map(reply => (
              <CommentItem
                key={reply.id}
                comment={reply}
                postId={postId}
                signedIn={signedIn}
                viewerId={viewerId}
                isAdmin={isAdmin}
                isReply
              />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}
