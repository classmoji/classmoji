import { rejectionNotice, type LiveRejectReason } from '~/utils/collab/collab';

const reload = () => window.location.reload();

/**
 * The banner for a live deck the server refused. A stale room reloads on its
 * own (the route does that once); this shows when it cannot, or when the
 * person has to act. Every refusal but `legacy-html` (which a reload cannot
 * change) offers Reload — access taken away may have been given back.
 * Pinned under the navbar and the pending-preview banner, at their measured
 * heights.
 */
export function CollabRejectedBanner({
  reason,
  reloadAttempted,
}: {
  reason: LiveRejectReason;
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
    <div
      className="fixed left-1/2 -translate-x-1/2 z-[1100] w-[calc(100%-2rem)] max-w-xl"
      style={{
        top: 'calc(var(--slides-nav-h, 3.5rem) + var(--slides-banner-h, 0px) + 0.5rem)',
      }}
    >
      <div
        role="alert"
        data-testid="live-rejected-banner"
        data-reason={reason}
        className="flex items-center gap-3 rounded-lg border border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-950 px-4 py-3 shadow-lg"
      >
        <div className="flex-1 text-sm font-semibold text-amber-900 dark:text-amber-100">
          {message}
        </div>
        {reason !== 'legacy-html' && (
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
