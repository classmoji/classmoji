import { useCallback, useMemo, useState } from 'react';
import { Link, data, useLoaderData } from 'react-router';
import {
  BellIcon,
  BellOffIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  LinkIcon,
  MessageSquareIcon,
  PlusIcon,
  Share2Icon,
  Trash2Icon,
} from 'lucide-react';
import { ClassmojiService } from '@classmoji/services';
import { FeedbackAvatar } from '~/components/features/feedback/FeedbackAvatar';
import { LinkedText } from '~/components/features/feedback/LinkedText';
import { CommentComposer } from '~/components/features/feedback/CommentComposer';
import { CommentItem } from '~/components/features/feedback/CommentItem';
import { NewPostDialog } from '~/components/features/feedback/NewPostDialog';
import { StatusLabel } from '~/components/features/feedback/StatusLabel';
import {
  useFeedbackAction,
  useOptimisticVote,
} from '~/components/features/feedback/useFeedbackAction';
import { VoteButton } from '~/components/features/feedback/VoteButton';
import {
  authorName,
  CATEGORY_EMOJI,
  CATEGORY_LABELS,
  formatDate,
  STATUS_META,
  STATUS_ORDER,
  type FeedbackCommentView,
} from '~/components/features/feedback/feedback';
import { feedbackViewer } from '~/utils/feedbackViewer.server';
import type { Route } from './+types/route';

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const { viewerId, isAdmin } = await feedbackViewer(request);
  const post = await ClassmojiService.feedback.getPost(params.postId ?? '', viewerId);
  if (!post) throw data('Not found', { status: 404 });
  return { post, viewerId, isAdmin, signedIn: Boolean(viewerId) };
};

export const meta = ({ data: loaderData }: Route.MetaArgs) => [
  { title: loaderData ? `${loaderData.post.title} - Classmoji feedback` : 'Feedback - Classmoji' },
];

type CommentSort = 'top' | 'new';

const actionClass =
  'inline-flex cursor-pointer items-center gap-2.5 rounded-md py-1.5 text-[13px] text-ink-2 transition-colors duration-150 hover:text-ink-0';

export default function FeedbackPostPage() {
  const { post, viewerId, isAdmin, signedIn } = useLoaderData<typeof loader>();
  const [sort, setSort] = useState<CommentSort>('top');
  const [copied, setCopied] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const closeDialog = useCallback(() => setDialogOpen(false), []);

  const vote = useOptimisticVote(
    'vote',
    'postId',
    post.id,
    post.vote_count,
    post.viewerVoted,
    signedIn
  );
  const follow = useFeedbackAction(signedIn);
  const following =
    follow.fetcher.formData?.get('intent') === 'follow' ? !post.viewerFollows : post.viewerFollows;
  const status = useFeedbackAction(signedIn);
  const remove = useFeedbackAction(signedIn);
  // Deleting redirects to the board from the action itself.
  const canDelete = isAdmin || post.viewerIsAuthor;

  const comments = useMemo(
    () =>
      [...(post.comments as FeedbackCommentView[])].sort((a, b) =>
        sort === 'top'
          ? b.vote_count - a.vote_count
          : new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      ),
    [post.comments, sort]
  );

  const copyLink = () => {
    navigator.clipboard?.writeText(window.location.href).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  };
  const share = () => {
    if (navigator.share)
      navigator.share({ title: post.title, url: window.location.href }).catch(() => undefined);
    else copyLink();
  };

  const shownStatus =
    status.fetcher.formData?.get('intent') === 'set-status'
      ? (status.fetcher.formData.get('status') as string) || null
      : post.status;

  return (
    <div className="mx-auto grid max-w-6xl px-6 gap-12 pb-24 pt-8 lg:grid-cols-[minmax(0,1fr)_320px]">
      <article className="min-w-0">
        <Link
          to="/feedback"
          className="-ml-1 inline-flex items-center gap-1 rounded-md px-1 text-[13px] font-medium text-ink-3! no-underline transition-colors duration-150 hover:text-ink-0!"
        >
          <ChevronLeftIcon className="h-4 w-4" aria-hidden />
          Back to feedback
        </Link>
        <h1 className="mt-4 text-balance text-2xl font-bold leading-tight tracking-tight text-ink-0">
          {post.title}
        </h1>
        <div className="mt-4 flex flex-col gap-3">
          {post.body ? (
            post.body.split(/\n{2,}/).map((para, i) => (
              <p
                key={i}
                className="whitespace-pre-line break-words text-sm leading-relaxed text-ink-1"
              >
                <LinkedText text={para} />
              </p>
            ))
          ) : (
            <p className="text-[13px] text-ink-4">No details were added.</p>
          )}
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-4">
          {shownStatus && STATUS_ORDER.includes(shownStatus as (typeof STATUS_ORDER)[number]) && (
            <StatusLabel status={shownStatus as (typeof STATUS_ORDER)[number]} />
          )}
          <span className="inline-flex items-center gap-1.5 text-[13px] text-ink-3">
            <MessageSquareIcon className="h-4 w-4" aria-hidden />
            {post.comment_count} {post.comment_count === 1 ? 'comment' : 'comments'}
          </span>
          <div className="ml-auto">
            <VoteButton count={vote.count} voted={vote.voted} onToggle={vote.toggle} />
          </div>
        </div>

        <div className="mt-8">
          <CommentComposer postId={post.id} signedIn={signedIn} />
        </div>

        <section aria-labelledby="comments-heading" className="mt-10">
          <div className="flex items-center justify-between">
            <h2 id="comments-heading" className="text-sm font-semibold text-ink-0">
              Comments <span className="font-normal text-ink-4">{post.comment_count}</span>
            </h2>
            {post.comments.length > 1 && (
              <select
                value={sort}
                onChange={e => setSort(e.target.value as CommentSort)}
                aria-label="Sort comments"
                className="h-8 rounded-md border border-line-2 bg-panel px-2 text-[12px] text-ink-1 focus:border-accent focus:outline-none"
              >
                <option value="top">Top</option>
                <option value="new">Newest</option>
              </select>
            )}
          </div>
          {comments.length > 0 ? (
            <ul className="mt-6 flex flex-col gap-7">
              {comments.map(comment => (
                <CommentItem
                  key={comment.id}
                  comment={comment}
                  postId={post.id}
                  signedIn={signedIn}
                  viewerId={viewerId}
                  isAdmin={isAdmin}
                />
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-[13px] text-ink-3">
              No comments yet. Share how this would help your class.
            </p>
          )}
        </section>
      </article>

      <aside className="flex flex-col gap-6 lg:sticky lg:top-6 lg:self-start">
        <button
          type="button"
          onClick={() => follow.submit({ intent: 'follow', postId: post.id })}
          aria-pressed={following}
          className={`inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg text-[13px] font-semibold transition-colors duration-150 ${
            following
              ? 'border border-line-2 bg-panel text-ink-0 hover:border-line-strong'
              : 'bg-accent text-white hover:bg-accent-hover'
          }`}
        >
          {following ? (
            <BellOffIcon className="h-4 w-4" aria-hidden />
          ) : (
            <BellIcon className="h-4 w-4" aria-hidden />
          )}
          {following ? 'Unfollow' : 'Follow this post'}
        </button>

        <dl className="rounded-xl bg-panel p-4 text-[13px] ring-1 ring-stone-200 dark:ring-neutral-800">
          {[
            ['Board', `${CATEGORY_EMOJI[post.category]} ${CATEGORY_LABELS[post.category]}`],
            ['Created by', authorName(post.author, post.is_anonymous)],
            ['Date', formatDate(post.created_at)],
          ].map(([label, value]) => (
            <div key={label} className="flex items-center justify-between gap-3 py-1.5">
              <dt className="text-ink-3">{label}</dt>
              <dd className="flex min-w-0 items-center gap-2 truncate font-medium text-ink-0">
                {label === 'Created by' && (
                  <FeedbackAvatar
                    anonymous={post.is_anonymous}
                    name={value}
                    image={post.author?.image}
                    size={20}
                  />
                )}
                {value}
              </dd>
            </div>
          ))}
          <div className="flex items-center justify-between gap-3 py-1.5">
            <dt className="text-ink-3">Status</dt>
            <dd>
              {isAdmin ? (
                <div className="relative">
                  <select
                    aria-label="Status"
                    value={shownStatus ?? ''}
                    onChange={e =>
                      status.submit({
                        intent: 'set-status',
                        postId: post.id,
                        status: e.target.value,
                      })
                    }
                    className={`h-[32px] cursor-pointer appearance-none rounded-lg border border-line-2 bg-panel pl-3 pr-8 text-[13px] font-medium transition-colors duration-150 hover:border-line-strong focus:border-accent focus:outline-none ${
                      shownStatus && shownStatus in STATUS_META
                        ? STATUS_META[shownStatus as keyof typeof STATUS_META].ink
                        : 'text-ink-3'
                    }`}
                  >
                    <option value="">Not on roadmap</option>
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
              ) : post.status ? (
                <StatusLabel status={post.status} />
              ) : (
                <span className="text-ink-4">None</span>
              )}
            </dd>
          </div>
        </dl>

        <div>
          <h2 className="text-[13px] font-semibold text-ink-2">Actions</h2>
          <div className="mt-2 flex flex-col items-start">
            <button
              type="button"
              onClick={() => (signedIn ? setDialogOpen(true) : follow.submit({}))}
              className={actionClass}
            >
              <PlusIcon className="h-4 w-4" aria-hidden />
              Submit a new post
            </button>
            <button type="button" onClick={copyLink} className={actionClass}>
              <LinkIcon className="h-4 w-4" aria-hidden />
              <span aria-live="polite">{copied ? 'Link copied' : 'Copy link'}</span>
            </button>
            <button type="button" onClick={share} className={actionClass}>
              <Share2Icon className="h-4 w-4" aria-hidden />
              Share
            </button>
            {canDelete && (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm('Delete this post and all its comments?')) {
                    remove.submit({ intent: 'delete-post', postId: post.id });
                  }
                }}
                className={`${actionClass} hover:text-rose-ink`}
              >
                <Trash2Icon className="h-4 w-4" aria-hidden />
                Delete post
              </button>
            )}
          </div>
        </div>
      </aside>

      <NewPostDialog open={dialogOpen} onClose={closeDialog} />
    </div>
  );
}
