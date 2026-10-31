import { useState } from 'react';
import { IconCheck, IconArrowBackUp } from '@tabler/icons-react';

import { CommentItem } from './CommentItem.tsx';
import { Composer } from './Composer.tsx';
import { relativeTime } from './relativeTime.ts';
import type { AnchorResolution } from './commentsPlugin.ts';
import type { CommentIntent, CommentThread, PageComment } from './types.ts';

/** What a thread is about: the page, a block, or a quote (and whether it is still there). */
export function ThreadAnchor({
  blockId,
  quote,
  resolution,
}: {
  blockId: string | null;
  quote: string | null;
  resolution: AnchorResolution | undefined;
}) {
  const chip = (label: string, tone: 'plain' | 'warn' = 'plain') => (
    <span
      className={
        tone === 'warn'
          ? 'shrink-0 rounded-full bg-amber-100 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
          : 'shrink-0 rounded-full bg-stone-100 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-stone-600 dark:bg-neutral-800 dark:text-neutral-300'
      }
    >
      {label}
    </span>
  );

  if (!blockId) return <span className="flex items-center gap-1.5">{chip('Page')}</span>;

  const status = resolution?.status;
  const gone = status === 'missing' || status === 'text-changed';
  if (quote) {
    return (
      <span className="flex items-start gap-1.5">
        <span
          className={`block min-w-0 flex-1 border-l-2 pl-2 text-xs leading-5 ${
            gone
              ? 'border-stone-300 text-gray-400 line-through decoration-gray-400/60 dark:border-neutral-600 dark:text-gray-500'
              : 'border-yellow-500 text-gray-600 dark:border-yellow-400/70 dark:text-gray-300'
          }`}
        >
          <span className="line-clamp-3 break-words">{quote}</span>
        </span>
        {status === 'text-changed' && chip('Text changed', 'warn')}
        {status === 'missing' && chip('Section removed', 'warn')}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {status === 'missing' ? chip('Section removed', 'warn') : chip('Block')}
      {resolution?.excerpt && status !== 'missing' && (
        <span className="truncate text-xs text-gray-500 dark:text-gray-400">
          {resolution.excerpt}
        </span>
      )}
    </span>
  );
}

interface ThreadCardProps {
  thread: CommentThread;
  resolution: AnchorResolution | undefined;
  active: boolean;
  canWrite: boolean;
  canResolve: boolean;
  frozen: boolean;
  act: (payload: CommentIntent) => Promise<boolean>;
  onSelect: (thread: CommentThread) => void;
  onRequestDelete: (comment: PageComment, thread: CommentThread) => void;
}

export function ThreadCard({
  thread,
  resolution,
  active,
  canWrite,
  canResolve,
  frozen,
  act,
  onSelect,
  onRequestDelete,
}: ThreadCardProps) {
  const [resolving, setResolving] = useState(false);
  const resolved = thread.resolvedAt !== null;

  const setResolved = async (value: boolean) => {
    setResolving(true);
    await act({ intent: 'resolve', threadId: thread.id, resolved: value });
    setResolving(false);
  };

  return (
    <article
      aria-label={thread.quote ? `Thread on “${thread.quote.slice(0, 60)}”` : 'Comment thread'}
      onClick={event => {
        // The card is the target, not one of its controls.
        if ((event.target as Element).closest('button, a, textarea, input, [role="menu"]')) return;
        // The end of a drag that selected text in the card is not a click.
        const selection = window.getSelection();
        if (
          selection &&
          !selection.isCollapsed &&
          selection.anchorNode &&
          event.currentTarget.contains(selection.anchorNode)
        ) {
          return;
        }
        onSelect(thread);
      }}
      className={`rounded-xl p-3 ring-1 transition-colors ${
        active
          ? 'bg-yellow-50/70 ring-yellow-300 dark:bg-yellow-950/20 dark:ring-yellow-700/60'
          : 'bg-white ring-stone-200 hover:ring-stone-300 dark:bg-neutral-900 dark:ring-neutral-800 dark:hover:ring-neutral-700'
      } ${thread.blockId ? 'cursor-pointer' : ''}`}
    >
      <div className="mb-2 flex items-start gap-2">
        {thread.blockId && resolution?.status !== 'missing' ? (
          <button
            type="button"
            onClick={() => onSelect(thread)}
            title="Show on the page"
            className="min-w-0 flex-1 rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <span className="sr-only">Show on the page: </span>
            <ThreadAnchor blockId={thread.blockId} quote={thread.quote} resolution={resolution} />
          </button>
        ) : (
          <div className="min-w-0 flex-1">
            <ThreadAnchor blockId={thread.blockId} quote={thread.quote} resolution={resolution} />
          </div>
        )}
        {canResolve && (
          <button
            type="button"
            disabled={resolving}
            onClick={() => void setResolved(!resolved)}
            aria-label={resolved ? 'Reopen thread' : 'Resolve thread'}
            title={resolved ? 'Reopen' : 'Resolve'}
            className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-neutral-800 dark:hover:text-white"
          >
            {resolved ? <IconArrowBackUp size={14} /> : <IconCheck size={14} />}
            {resolved ? 'Reopen' : 'Resolve'}
          </button>
        )}
      </div>

      {resolved && (
        <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
          Resolved{thread.resolvedBy ? ` by ${thread.resolvedBy.name}` : ''}
          {thread.resolvedAt ? ` · ${relativeTime(thread.resolvedAt)}` : ''}
        </p>
      )}

      <div className="space-y-3">
        {thread.comments.map(comment => (
          <CommentItem
            key={comment.id}
            comment={comment}
            canReact={canWrite && !frozen}
            frozen={frozen}
            act={act}
            onRequestDelete={target => onRequestDelete(target, thread)}
          />
        ))}
      </div>

      {canWrite && !frozen && !resolved && (
        <div className="mt-3">
          <Composer
            label="Reply"
            placeholder="Reply…"
            submitLabel="Send reply"
            onSubmit={body => act({ intent: 'reply', threadId: thread.id, body })}
          />
        </div>
      )}
    </article>
  );
}
