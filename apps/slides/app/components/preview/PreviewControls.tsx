import { useState } from 'react';
import { Link, useFetcher } from 'react-router';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { IconExternalLink, IconGitBranch } from '@tabler/icons-react';

dayjs.extend(relativeTime);

/**
 * Preview-branch UI for slide decks (plan §3b, mirroring apps/pages'
 * PreviewControls): the persistent bar shown while rendering the pending
 * `preview/<content_path>` branch, the slim staff-only banner shown on the
 * live deck when a preview exists, and the conflict panel rendered when an
 * accept hits a git merge conflict.
 *
 * All accept/discard submissions post the same form intents the route action
 * handles (`preview-accept` / `preview-discard`) — staff-gated server-side
 * (assertSlideAccess edit tier, same gate as every edit intent).
 *
 * The slides navbar is `fixed top-0` and the reveal container fills the
 * viewport below it (`fixed inset-0 pt-14`), so preview chrome overlays as
 * fixed bars under the navbar instead of using sticky flow positioning.
 */

export interface PreviewInfo {
  active: boolean;
  missing: boolean;
  exists: boolean;
  commitsAhead: number;
  oldestCommitAt: string | null;
  diffUrl: string | null;
}

/** A conflicted deck unit (diffDeckUnits shape): index is '4' or '4.2'. */
export interface ConflictUnit {
  id: string;
  index: string;
  ours?: unknown;
  theirs?: unknown;
  base?: unknown;
}

interface PreviewActionData {
  conflict?: boolean;
  units?: ConflictUnit[];
  orderConflict?: { base: string[]; ours: string[]; theirs: string[] } | null;
  error?: string;
}

function usePreviewActions() {
  const fetcher = useFetcher<PreviewActionData>();
  const [pending, setPending] = useState<'accept' | 'discard' | null>(null);
  const busy = fetcher.state !== 'idle';

  const accept = () => {
    setPending('accept');
    fetcher.submit({ intent: 'preview-accept' }, { method: 'POST' });
  };

  const discard = () => {
    if (!window.confirm('Discard the pending preview? Its changes will be permanently deleted.')) {
      return;
    }
    setPending('discard');
    fetcher.submit({ intent: 'preview-discard' }, { method: 'POST' });
  };

  const conflictUnits = fetcher.data?.conflict ? (fetcher.data.units ?? []) : null;
  const orderConflict = fetcher.data?.conflict ? (fetcher.data.orderConflict ?? null) : null;
  const error = fetcher.data?.error ?? null;

  return { busy, pending, accept, discard, conflictUnits, orderConflict, error };
}

function unitLabel(unit: ConflictUnit): string {
  return `slide ${unit.index || '?'} (${unit.id})`;
}

/**
 * Conflict panel: lists the slides that genuinely need a decision. The
 * per-slide chooser is Phase 7 — for now we name the conflicted units readably.
 */
const ConflictPanel = ({
  units,
  orderConflict,
}: {
  units: ConflictUnit[];
  orderConflict: { base: string[]; ours: string[]; theirs: string[] } | null;
}) => (
  <div
    data-testid="preview-conflict-panel"
    className="border-b border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/90 px-4 sm:px-6 lg:px-8 py-3"
  >
    <div className="text-sm font-medium text-rose-900 dark:text-rose-100">
      Changes conflict with edits made on the live deck
    </div>
    <div className="mt-1 text-sm text-rose-800 dark:text-rose-200">
      Conflicting slides:{' '}
      {units.length > 0 ? units.map(unit => unitLabel(unit)).join(', ') : 'none reported'}
      {orderConflict ? `${units.length > 0 ? '; ' : ''}slide ordering also conflicts` : ''}
    </div>
    <div className="mt-1 text-sm text-rose-700 dark:text-rose-300">
      Re-apply from the current version (via your agent) or discard the preview.
    </div>
  </div>
);

const actionButtonBase =
  'rounded px-3 py-1 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * Persistent top bar shown while previewing the pending branch.
 * Amber identity in both light and dark modes; fixed under the slides navbar.
 */
export const PreviewBar = ({ preview }: { preview: PreviewInfo }) => {
  const { busy, pending, accept, discard, conflictUnits, orderConflict, error } =
    usePreviewActions();
  const age = preview.oldestCommitAt ? dayjs(preview.oldestCommitAt).fromNow() : null;

  return (
    <div data-testid="preview-bar" className="fixed top-14 left-0 right-0 z-40">
      <div className="border-y border-amber-300 dark:border-amber-700/70 bg-amber-50/95 dark:bg-amber-950/90 backdrop-blur px-4 sm:px-6 lg:px-8 py-2">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex items-center gap-2 text-sm text-amber-900 dark:text-amber-100">
            <span className="relative flex h-2 w-2" aria-hidden>
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500 opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
            </span>
            <span className="font-semibold">Previewing pending changes</span>
            <span className="text-amber-700 dark:text-amber-300">
              · {preview.commitsAhead} commit{preview.commitsAhead === 1 ? '' : 's'}
              {age ? ` · ${age}` : ''}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {preview.diffUrl && (
              <a
                href={preview.diffUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={`${actionButtonBase} inline-flex items-center gap-1 text-amber-900 dark:text-amber-200 ring-1 ring-amber-300 dark:ring-amber-700 hover:bg-amber-100 dark:hover:bg-amber-900/40`}
              >
                Diff
                <IconExternalLink size={14} />
              </a>
            )}
            <button
              type="button"
              onClick={discard}
              disabled={busy}
              className={`${actionButtonBase} text-amber-900 dark:text-amber-200 ring-1 ring-amber-300 dark:ring-amber-700 hover:bg-amber-100 dark:hover:bg-amber-900/40`}
            >
              {busy && pending === 'discard' ? 'Discarding…' : 'Discard'}
            </button>
            <button
              type="button"
              onClick={accept}
              disabled={busy}
              className={`${actionButtonBase} bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-500 dark:text-amber-950 dark:hover:bg-amber-400`}
            >
              {busy && pending === 'accept' ? 'Accepting…' : 'Accept'}
            </button>
          </div>
        </div>
        {error && <div className="mt-2 text-sm text-rose-700 dark:text-rose-300">{error}</div>}
      </div>
      {conflictUnits && <ConflictPanel units={conflictUnits} orderConflict={orderConflict} />}
    </div>
  );
};

/**
 * Slim staff-only banner on the normal (live) view when a preview branch exists.
 */
export const PendingPreviewBanner = ({ preview }: { preview: PreviewInfo }) => {
  const { busy, pending, accept, discard, conflictUnits, orderConflict, error } =
    usePreviewActions();
  const age = preview.oldestCommitAt ? dayjs(preview.oldestCommitAt).fromNow() : null;

  return (
    <div data-testid="pending-preview-banner" className="fixed top-14 left-0 right-0 z-40">
      <div className="border-b border-amber-200 dark:border-amber-800/70 bg-amber-50/90 dark:bg-amber-950/80 backdrop-blur px-4 sm:px-6 lg:px-8 py-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-amber-900 dark:text-amber-100">
          <span className="inline-flex items-center gap-1.5">
            <IconGitBranch size={14} className="text-amber-600 dark:text-amber-400" aria-hidden />A
            preview with pending changes exists
            {age ? (
              <span className="text-amber-700 dark:text-amber-300">
                ({preview.commitsAhead} commit{preview.commitsAhead === 1 ? '' : 's'}, {age})
              </span>
            ) : null}
          </span>
          <span className="text-amber-400 dark:text-amber-600" aria-hidden>
            ·
          </span>
          <Link
            to="?preview=1"
            className="font-medium underline decoration-amber-400 underline-offset-2 hover:text-amber-700 dark:hover:text-amber-300"
          >
            View preview
          </Link>
          <button
            type="button"
            onClick={accept}
            disabled={busy}
            className="font-medium underline decoration-amber-400 underline-offset-2 hover:text-amber-700 dark:hover:text-amber-300 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy && pending === 'accept' ? 'Accepting…' : 'Accept'}
          </button>
          <button
            type="button"
            onClick={discard}
            disabled={busy}
            className="font-medium underline decoration-amber-400 underline-offset-2 hover:text-amber-700 dark:hover:text-amber-300 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy && pending === 'discard' ? 'Discarding…' : 'Discard'}
          </button>
        </div>
        {error && <div className="mt-1 text-sm text-rose-700 dark:text-rose-300">{error}</div>}
      </div>
      {conflictUnits && <ConflictPanel units={conflictUnits} orderConflict={orderConflict} />}
    </div>
  );
};

/**
 * Shown when staff request `?preview=1` but no preview branch exists —
 * the live deck renders as normal underneath.
 */
export const NoPreviewNotice = () => (
  <div data-testid="no-preview-notice" className="fixed top-14 left-0 right-0 z-40">
    <div className="border-b border-stone-200 dark:border-neutral-700 bg-stone-100/90 dark:bg-neutral-800/90 backdrop-blur px-4 sm:px-6 lg:px-8 py-1.5 text-sm text-stone-600 dark:text-neutral-300">
      No preview pending — showing the live deck.
    </div>
  </div>
);
