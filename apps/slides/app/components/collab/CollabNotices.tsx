import type { CollabRejectReason } from '@classmoji/collab';

import { rejectionNotice } from '~/utils/collab/collab';

const reload = () => window.location.reload();

/**
 * The banner for a live deck the server refused. A stale room reloads on its
 * own (the route does that once); this shows when it cannot, or when the
 * person has to act.
 */
export function CollabRejectedBanner({
  reason,
  reloadAttempted,
}: {
  reason: CollabRejectReason;
  reloadAttempted: boolean;
}) {
  const notice = rejectionNotice(reason);
  const message =
    notice.action === 'reload'
      ? reloadAttempted
        ? 'This deck was updated. Reload to keep editing.'
        : null
      : notice.message;
  if (!message) return null;

  return (
    <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[1100] w-[calc(100%-2rem)] max-w-xl">
      <div
        role="alert"
        data-testid="live-rejected-banner"
        data-reason={reason}
        className="flex items-center gap-3 rounded-lg border border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-950 px-4 py-3 shadow-lg"
      >
        <div className="flex-1 text-sm font-semibold text-amber-900 dark:text-amber-100">
          {message}
        </div>
        {notice.action !== 'readonly' && (
          <button
            type="button"
            onClick={reload}
            className="px-3 py-1.5 text-sm font-medium rounded-md bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-500 dark:text-amber-950 dark:hover:bg-amber-400"
          >
            Reload
          </button>
        )}
      </div>
    </div>
  );
}
