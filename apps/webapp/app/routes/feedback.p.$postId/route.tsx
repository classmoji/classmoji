import { useEffect, useMemo, useState } from 'react';
import { Link, data, redirect, useLoaderData } from 'react-router';
import { BellIcon, BellRingIcon, ChevronDownIcon, ChevronLeftIcon, Trash2Icon } from 'lucide-react';
import { ClassmojiService } from '@classmoji/services';
import { FeedbackAvatar } from '~/components/features/feedback/FeedbackAvatar';
import { LinkedText } from '~/components/features/feedback/LinkedText';
import { MaintainerBadge } from '~/components/features/feedback/MaintainerBadge';
import { CommentComposer } from '~/components/features/feedback/CommentComposer';
import { CommentItem } from '~/components/features/feedback/CommentItem';
import { ParticipantStack } from '~/components/features/feedback/ParticipantStack';
import { StatusLabel } from '~/components/features/feedback/StatusLabel';
import {
  useFeedbackAction,
  useOptimisticVote,
} from '~/components/features/feedback/useFeedbackAction';
import { VoteButton } from '~/components/features/feedback/VoteButton';
import {
  authorName,
  BUG_SECTIONS,
  CATEGORY_EMOJI,
  CATEGORY_LABELS,
  formatDate,
  ALL_STATUSES,
  STATUS_META,
  STATUSES_BY_CATEGORY,
  type FeedbackCommentView,
} from '~/components/features/feedback/feedback';
import { feedbackViewer } from '~/utils/feedbackViewer.server';
import type { Route } from './+types/route';

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const { viewerId, isAdmin } = await feedbackViewer(request);
  const post = await ClassmojiService.feedback.getPost(params.postId ?? '', viewerId);
  if (!post) throw data('Not found', { status: 404 });
  // A merged duplicate lives on in its original.
  if (post.duplicate_of_id) throw redirect(`/feedback/p/${post.duplicate_of_id}`);
  return { post, viewerId, isAdmin, signedIn: Boolean(viewerId) };
};

export const meta = ({ data: loaderData }: Route.MetaArgs) => [
  { title: loaderData ? `${loaderData.post.title} - Classmoji feedback` : 'Feedback - Classmoji' },
];

const fieldClass =
  'h-[34px] min-w-0 rounded-lg border border-line-2 bg-panel px-2.5 text-[13px] text-ink-1 placeholder:text-ink-4 focus:border-accent focus:outline-none';

type Status = (typeof ALL_STATUSES)[number];

export default function FeedbackPostPage() {
  const { post, viewerId, isAdmin, signedIn } = useLoaderData<typeof loader>();
  const [nextStatus, setNextStatus] = useState<string>(post.status ?? '');
  const [note, setNote] = useState('');
  const [duplicateOf, setDuplicateOf] = useState('');
  const answered = useFeedbackAction(signedIn);
  const merge = useFeedbackAction(signedIn);

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

  // Comments read oldest first (replies stay under their comment); the
  // team's status notes sit above them, newest first, so news isn't buried.
  const comments = useMemo(
    () =>
      [...(post.comments as FeedbackCommentView[])].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      ),
    [post.comments]
  );
  const updates = useMemo(
    () =>
      [...post.updates].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      ),
    [post.updates]
  );

  const shownStatus =
    status.fetcher.formData?.get('intent') === 'set-status'
      ? (status.fetcher.formData.get('status') as string) || null
      : answered.fetcher.formData?.get('intent') === 'mark-answered'
        ? answered.fetcher.formData.get('answered') === 'false'
          ? null
          : 'ANSWERED'
        : post.status;
  const statusChanged = nextStatus !== (post.status ?? '');
  // The note is cleared once the update went through; on an error it stays.
  useEffect(() => {
    if (status.fetcher.state === 'idle' && status.fetcher.data?.ok) setNote('');
  }, [status.fetcher.state, status.fetcher.data]);

  const author = authorName(post.author, post.is_anonymous);

  // Everyone named in the conversation: the author, then commenters (replies
  // too) in the order they first spoke. Anonymous ones are left out.
  const participants = useMemo(() => {
    const seen = new Map<string, NonNullable<FeedbackCommentView['author']>>();
    if (post.author && !post.is_anonymous) seen.set(post.author.id, post.author);
    const all = (post.comments as FeedbackCommentView[])
      .flatMap(c => [c, ...(c.replies ?? [])])
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    for (const c of all)
      if (c.author && !c.is_anonymous && !seen.has(c.author.id)) seen.set(c.author.id, c.author);
    return [...seen.values()];
  }, [post.author, post.is_anonymous, post.comments]);

  return (
    <div className="mx-auto w-full max-w-[1396px] px-4 pb-24 pt-8 sm:px-6">
      <Link
        to="/feedback"
        className="-ml-1 inline-flex items-center gap-1 rounded-md px-1 text-[13px] font-medium text-ink-3! no-underline transition-colors duration-150 hover:text-ink-0!"
      >
        <ChevronLeftIcon className="h-4 w-4" aria-hidden />
        Back to feedback
      </Link>

      <article>
        <div className="mt-4 grid grid-cols-[2.75rem_minmax(0,1fr)] items-start gap-4">
          <VoteButton size="stack" count={vote.count} voted={vote.voted} onToggle={vote.toggle} />
          <div className="min-w-0">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <h1 className="text-balance text-2xl font-bold leading-tight tracking-tight text-ink-0">
                {post.title}
              </h1>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => follow.submit({ intent: 'follow', postId: post.id })}
                  aria-pressed={following}
                  className={`inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-line-2 bg-panel px-3 text-[13px] font-medium transition-colors duration-150 hover:border-line-strong ${
                    following ? 'text-accent-ink' : 'text-ink-1'
                  }`}
                >
                  {following ? (
                    <BellRingIcon className="h-4 w-4" aria-hidden />
                  ) : (
                    <BellIcon className="h-4 w-4" aria-hidden />
                  )}
                  {following ? 'Following' : 'Follow'}
                </button>
                {post.category === 'QUESTION' && post.viewerIsAuthor && (
                  <button
                    type="button"
                    onClick={() =>
                      answered.submit({
                        intent: 'mark-answered',
                        postId: post.id,
                        answered: String(shownStatus !== 'ANSWERED'),
                      })
                    }
                    className="inline-flex h-9 cursor-pointer items-center rounded-lg border border-line-2 bg-panel px-3 text-[13px] font-medium text-ink-1 transition-colors duration-150 hover:border-line-strong"
                  >
                    {shownStatus === 'ANSWERED' ? 'Mark as not answered' : 'Mark as answered'}
                  </button>
                )}
              </div>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-3">
              <span>
                <span aria-hidden>{CATEGORY_EMOJI[post.category]}</span>{' '}
                {CATEGORY_LABELS[post.category]}
              </span>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-1.5">
                <FeedbackAvatar
                  anonymous={post.is_anonymous}
                  name={author}
                  image={post.author?.image}
                  size={20}
                />
                {author}
                {post.authorIsMaintainer && <MaintainerBadge />}
              </span>
              <span aria-hidden>·</span>
              <span>{formatDate(post.created_at)}</span>
              <span aria-hidden>·</span>
              {shownStatus && ALL_STATUSES.includes(shownStatus as Status) ? (
                <StatusLabel status={shownStatus as Status} />
              ) : (
                <span className="text-[12px] font-semibold text-ink-3">Open</span>
              )}
            </div>
            {participants.length > 1 && (
              <div className="mt-3 flex items-center gap-2 text-[12px] text-ink-3">
                <ParticipantStack
                  people={participants.slice(0, 8)}
                  total={participants.length}
                  size={26}
                />
                <span>{participants.length} people in this conversation</span>
              </div>
            )}
          </div>
        </div>

        <div className="mt-6 flex flex-col gap-3 sm:pl-[3.75rem]">
          {post.bug_what_happened ? (
            // A bug report from the form: the Github template's sections.
            BUG_SECTIONS.filter(({ field }) => post[field]).map(({ field, label }) => (
              <section key={field}>
                <h2 className="text-[13px] font-semibold text-ink-1">{label}</h2>
                <p className="mt-1 whitespace-pre-line break-words text-[15px] leading-relaxed text-ink-1">
                  <LinkedText text={post[field] ?? ''} />
                </p>
              </section>
            ))
          ) : post.body ? (
            post.body.split(/\n{2,}/).map((para, i) => (
              <p
                key={i}
                className="whitespace-pre-line break-words text-[15px] leading-relaxed text-ink-1"
              >
                <LinkedText text={para} />
              </p>
            ))
          ) : (
            <p className="text-[13px] text-ink-4">No details were added.</p>
          )}
        </div>
      </article>

      {updates.length > 0 && (
        <section aria-labelledby="updates-heading" className="mt-8 sm:pl-[3.75rem]">
          <h2 id="updates-heading" className="text-sm font-semibold text-ink-0">
            Updates from the team
          </h2>
          <ol className="mt-3 flex flex-col gap-4 border-l-2 border-line pl-4">
            {updates.map(update => (
              <li key={update.id}>
                <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
                  {update.to_status ? (
                    <StatusLabel status={update.to_status} />
                  ) : (
                    <span className="font-semibold">Status cleared</span>
                  )}
                  <span>· Classmoji team</span>
                  <MaintainerBadge />
                  <span>· {formatDate(update.created_at)}</span>
                </div>
                {update.note && (
                  <p className="mt-1 whitespace-pre-line break-words text-sm leading-relaxed text-ink-1">
                    <LinkedText text={update.note} />
                  </p>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      <section aria-labelledby="discussion-heading" className="mt-10 border-t border-line pt-6">
        <h2 id="discussion-heading" className="text-sm font-semibold text-ink-0">
          Discussion{' '}
          <span className="font-normal text-ink-4">
            {post.comment_count > 0
              ? `${post.comment_count} ${post.comment_count === 1 ? 'reply' : 'replies'}`
              : ''}
          </span>
        </h2>
        {comments.length > 0 ? (
          <ul className="mt-5 flex flex-col gap-6">
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
          <p className="mt-3 text-[13px] text-ink-3">No replies yet.</p>
        )}

        <div className="mt-8">
          <CommentComposer postId={post.id} signedIn={signedIn} rows={2} />
        </div>
      </section>

      {isAdmin ? (
        <section
          aria-labelledby="manage-heading"
          className="mt-10 flex flex-col gap-4 rounded-xl border border-dashed border-line-strong p-4"
        >
          <h2 id="manage-heading" className="text-[13px] font-semibold text-ink-1">
            Manage <span className="font-normal text-ink-4">· admins only</span>
          </h2>
          <form
            className="flex flex-col gap-2"
            onSubmit={e => {
              e.preventDefault();
              status.submit({ intent: 'set-status', postId: post.id, status: nextStatus, note });
            }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <select
                  aria-label="Status"
                  value={nextStatus}
                  onChange={e => setNextStatus(e.target.value)}
                  className={`h-[34px] cursor-pointer appearance-none rounded-lg border border-line-2 bg-panel pl-3 pr-8 text-[13px] font-medium transition-colors duration-150 hover:border-line-strong focus:border-accent focus:outline-none ${
                    nextStatus && nextStatus in STATUS_META
                      ? STATUS_META[nextStatus as keyof typeof STATUS_META].ink
                      : 'text-ink-3'
                  }`}
                >
                  <option value="">Open</option>
                  {/* Only this type's statuses: a bug is never "Planned". */}
                  {STATUSES_BY_CATEGORY[post.category].map(s => (
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
              <label htmlFor="status-note" className="sr-only">
                Public note (optional)
              </label>
              <input
                id="status-note"
                maxLength={1000}
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="Public note (optional). Followers get this."
                className={`${fieldClass} flex-1`}
              />
              <button
                type="submit"
                disabled={status.pending || (!statusChanged && !note.trim())}
                className="h-[34px] cursor-pointer rounded-lg bg-accent px-3.5 text-[13px] font-semibold text-white transition-colors duration-150 hover:bg-accent-hover disabled:cursor-default disabled:opacity-50"
              >
                {status.pending ? 'Updating…' : 'Update and notify'}
              </button>
            </div>
            {status.fetcher.data?.error && (
              <p role="alert" className="text-[12px] text-rose-ink">
                {status.fetcher.data.error}
              </p>
            )}
          </form>
          <form
            className="flex flex-col gap-2"
            onSubmit={e => {
              e.preventDefault();
              if (
                duplicateOf.trim() &&
                window.confirm(
                  'Merge this post into the original? Its votes, follows and comments move there, and this link will redirect.'
                )
              ) {
                merge.submit({
                  intent: 'mark-duplicate',
                  postId: post.id,
                  originalId: duplicateOf.trim(),
                });
              }
            }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="duplicate-of" className="sr-only">
                Duplicate of (link or id)
              </label>
              <input
                id="duplicate-of"
                value={duplicateOf}
                onChange={e => setDuplicateOf(e.target.value)}
                placeholder="Duplicate of: link or id of the original post"
                className={`${fieldClass} flex-1`}
              />
              <button
                type="submit"
                disabled={!duplicateOf.trim() || merge.pending}
                className="h-[34px] cursor-pointer rounded-lg border border-line-2 bg-panel px-3 text-[13px] font-semibold text-ink-1 hover:border-line-strong disabled:cursor-default disabled:opacity-50"
              >
                Merge
              </button>
            </div>
            {merge.fetcher.data?.error && (
              <p role="alert" className="text-[12px] text-rose-ink">
                {merge.fetcher.data.error}
              </p>
            )}
          </form>
          <DeletePost onDelete={() => remove.submit({ intent: 'delete-post', postId: post.id })} />
        </section>
      ) : (
        canDelete && (
          <div className="mt-10">
            <DeletePost
              onDelete={() => remove.submit({ intent: 'delete-post', postId: post.id })}
            />
          </div>
        )
      )}
    </div>
  );
}

function DeletePost({ onDelete }: { onDelete: () => void }) {
  return (
    <button
      type="button"
      onClick={() => {
        if (window.confirm('Delete this post and all its comments?')) onDelete();
      }}
      className="inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-md text-[13px] text-ink-3 transition-colors duration-150 hover:text-rose-ink"
    >
      <Trash2Icon className="h-4 w-4" aria-hidden />
      Delete post
    </button>
  );
}
