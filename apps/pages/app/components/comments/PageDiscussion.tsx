import { useMemo } from 'react';

import { Avatar, RoleBadge } from './CommentItem.tsx';
import { fullTime, relativeTime } from './relativeTime.ts';
import type { PageCommentsController } from './usePageCommentsController.ts';
import type { CommentThread } from './types.ts';

/**
 * The page's own discussion, under the title (Notion's page discussion line):
 * one quiet row per OPEN page-level thread (`blockId` null), which otherwise
 * appears nowhere on the page. A row opens the panel on that thread.
 *
 * Reads the controller's threads only: no fetch of its own (the arrival load
 * runs whenever anything is open, and page-level threads are counted in it).
 * Before the list is in, a skeleton of the loader's `pageLevel` rows keeps
 * the page from jumping; it goes when the list arrives with none, or fails.
 */
const MAX_ROWS = 3;

/** The open page-level threads, in the server's order. */
export function openPageLevelThreads(threads: CommentThread[]): CommentThread[] {
  return threads.filter(thread => thread.blockId === null && thread.resolvedAt === null);
}

export function PageDiscussion({
  controller,
  pageLevelOnLoad,
}: {
  controller: PageCommentsController;
  /** The loader's open page-level count (`readerComments.pageLevel`). */
  pageLevelOnLoad: number;
}) {
  const { threads, data, focusThread, openPanel, setTab, setFocusBlockId } = controller;
  const shown = useMemo(() => (threads ? openPageLevelThreads(threads) : null), [threads]);

  if (shown === null) {
    if (pageLevelOnLoad <= 0 || data.failed) return null;
    return (
      // Same box model as the rows below (a name line, two body lines, the
      // "+N more" line), so nothing moves when the list arrives.
      <div aria-hidden="true" data-testid="page-discussion-skeleton" className="mb-4 -mx-2">
        <div className="space-y-0.5">
          {Array.from({ length: Math.min(pageLevelOnLoad, MAX_ROWS) }, (_, index) => (
            <div key={index} className="flex gap-2.5 px-2 py-1.5">
              <span className="pt-0.5">
                <span className="block h-5 w-5 animate-pulse rounded-full bg-stone-200 dark:bg-neutral-800" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex h-4 items-center">
                  <span className="h-2.5 w-40 max-w-full animate-pulse rounded bg-stone-200 dark:bg-neutral-800" />
                </span>
                <span className="mt-0.5 block">
                  <span className="flex h-5 items-center">
                    <span className="h-3 w-full max-w-md animate-pulse rounded bg-stone-100 dark:bg-neutral-800/60" />
                  </span>
                  <span className="flex h-5 items-center">
                    <span className="h-3 w-2/3 max-w-xs animate-pulse rounded bg-stone-100 dark:bg-neutral-800/60" />
                  </span>
                </span>
              </span>
            </div>
          ))}
        </div>
        {pageLevelOnLoad > MAX_ROWS && (
          <div className="ml-2 mt-0.5 flex h-4 items-center px-1">
            <span className="h-2.5 w-14 animate-pulse rounded bg-stone-100 dark:bg-neutral-800/60" />
          </div>
        )}
      </div>
    );
  }
  if (shown.length === 0) return null;

  const rows = shown.slice(0, MAX_ROWS);
  const more = shown.length - rows.length;

  return (
    <section aria-label="Page discussion" data-testid="page-discussion" className="mb-4 -mx-2">
      <ul className="space-y-0.5">
        {rows.map(thread => {
          const first = thread.comments[0];
          if (!first) return null;
          const author = first.author;
          const name = author?.name ?? 'Deleted user';
          const replies = thread.comments.length - 1;
          return (
            <li key={thread.id}>
              <button
                type="button"
                onClick={() => focusThread(thread.id)}
                aria-label={`Comment on the page by ${name}, ${relativeTime(first.createdAt)}: ${first.body.slice(0, 80)}${
                  replies > 0 ? `, ${replies} ${replies === 1 ? 'reply' : 'replies'}` : ''
                }`}
                className="flex w-full gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-stone-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-neutral-800/70"
              >
                <span className="pt-0.5">
                  <Avatar author={author} size={20} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex h-4 min-w-0 items-center gap-1.5 text-xs">
                    <span
                      className={`truncate font-semibold ${author ? 'text-gray-700 dark:text-gray-200' : 'italic text-gray-500 dark:text-gray-400'}`}
                    >
                      {name}
                    </span>
                    <RoleBadge badge={author?.badge ?? null} />
                    <time
                      dateTime={first.createdAt}
                      title={fullTime(first.createdAt)}
                      className="shrink-0 text-gray-500 dark:text-gray-400"
                    >
                      {relativeTime(first.createdAt)}
                    </time>
                    {replies > 0 && (
                      <span className="shrink-0 text-gray-500 dark:text-gray-400">
                        · {replies} {replies === 1 ? 'reply' : 'replies'}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 line-clamp-2 break-words text-sm text-gray-600 dark:text-gray-300">
                    {first.body}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {more > 0 && (
        <button
          type="button"
          onClick={() => {
            setTab('open');
            setFocusBlockId(null);
            openPanel();
          }}
          className="ml-2 mt-0.5 block rounded px-1 text-xs leading-4 font-medium text-gray-500 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:text-gray-200"
        >
          +{more} more
        </button>
      )}
    </section>
  );
}
