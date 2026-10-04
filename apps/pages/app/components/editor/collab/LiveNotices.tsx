import type { CollabRejectReason } from '@classmoji/collab';

import { rejectionNotice } from '~/utils/collab.ts';

const reload = () => window.location.reload();

const buttonClass =
  'rounded px-3 py-1 text-sm font-medium transition-colors bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-500 dark:text-amber-950 dark:hover:bg-amber-400';

/**
 * The banner for a live session the server refused. A stale room reloads on
 * its own (the route does that); this is shown when it cannot (the reload
 * already happened once) or when the person has to act.
 */
export function LiveRejectedBanner({
  reason,
  isEmbedded,
  reloadAttempted,
}: {
  reason: CollabRejectReason;
  isEmbedded: boolean;
  reloadAttempted: boolean;
}) {
  const notice = rejectionNotice(reason);
  const message =
    notice.action === 'reload'
      ? reloadAttempted
        ? 'This page was updated. Reload to keep editing.'
        : null
      : notice.message;
  if (!message) return null;
  const offerReload = notice.action !== 'readonly';

  return (
    <div
      data-testid="live-rejected-banner"
      data-reason={reason}
      className={`sticky ${isEmbedded ? 'top-0' : 'top-12'} z-30`}
    >
      <div className="border-y border-amber-300 dark:border-amber-700/70 bg-amber-50/95 dark:bg-amber-950/90 backdrop-blur px-4 sm:px-6 lg:px-8 py-2">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <span className="text-sm font-semibold text-amber-900 dark:text-amber-100">
            {message}
          </span>
          {offerReload && (
            <button type="button" onClick={reload} className={buttonClass}>
              Reload
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The editor's place while the live document is not there yet: connecting,
 * or unreachable before it ever arrived.
 */
export function LiveEditorPlaceholder({ unreachable }: { unreachable: boolean }) {
  if (!unreachable) {
    return (
      <div className="flex items-center justify-center py-12" data-testid="live-connecting">
        <div className="text-gray-500 dark:text-gray-400">Loading editor...</div>
      </div>
    );
  }
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 py-12"
      data-testid="live-unreachable"
    >
      <div className="text-gray-600 dark:text-gray-300">
        This page can&rsquo;t be opened for editing right now.
      </div>
      <button
        type="button"
        onClick={reload}
        className="rounded px-3 py-1 text-sm font-medium transition-colors text-gray-700 ring-1 ring-gray-300 hover:bg-gray-100 dark:text-gray-200 dark:ring-neutral-600 dark:hover:bg-neutral-800"
      >
        Reload
      </button>
    </div>
  );
}
