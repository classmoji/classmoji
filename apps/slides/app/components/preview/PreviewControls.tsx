import { useEffect, useState, type ReactNode } from 'react';
import { Link, useFetcher } from 'react-router';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { IconExternalLink, IconGitBranch } from '@tabler/icons-react';
import {
  META_CONFLICT_ID,
  ORDER_CONFLICT_ID,
  allResolved,
  buildResolutions,
  buildSlideSrcdoc,
  isChildOrderId,
  metaFieldRows,
  reasonLabel,
  slideSideHtml,
  type ConflictUnit,
  type MergeChoice,
  type MergeResolution,
  type SlideSide,
} from './conflictChooser.ts';

dayjs.extend(relativeTime);

/**
 * Preview-branch UI for slide decks (plan §3b, mirroring apps/pages'
 * PreviewControls): the persistent bar shown while rendering the pending
 * `preview/<content_path>` branch, the slim staff-only banner shown on the
 * live deck when a preview exists, and the side-by-side conflict chooser
 * rendered when an accept hits a genuine merge conflict (Phase 7).
 *
 * All accept/discard submissions post the same form intents the route action
 * handles (`preview-accept` / `preview-discard`) — staff-gated server-side
 * (assertSlideAccess edit tier, same gate as every edit intent). The chooser
 * re-posts `preview-accept` with a `resolutions` payload covering every
 * listed conflict.
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

export type { ConflictUnit };

export interface OrderConflict {
  base: string[];
  ours: string[];
  theirs: string[];
}

interface PreviewActionData {
  conflict?: boolean;
  units?: ConflictUnit[];
  orderConflict?: OrderConflict | null;
  autoMerged?: number;
  oursSha?: string | null;
  theirsSha?: string | null;
  error?: string;
  code?: string;
  ids?: string[];
}

function usePreviewActions() {
  const fetcher = useFetcher<PreviewActionData>();
  const [pending, setPending] = useState<'accept' | 'discard' | null>(null);
  const busy = fetcher.state !== 'idle';

  const accept = () => {
    setPending('accept');
    fetcher.submit({ intent: 'preview-accept' }, { method: 'POST' });
  };

  // Chooser submit: same intent, plus one {id, choose} per listed conflict.
  // The report's shas ride along so the server can refuse (CONTENT_CONFLICT)
  // if the deck moved after the reviewed report (F3 pinning).
  const applyResolutions = (resolutions: MergeResolution[]) => {
    setPending('accept');
    fetcher.submit(
      {
        intent: 'preview-accept',
        resolutions: JSON.stringify(resolutions),
        ...(fetcher.data?.oursSha ? { ours_sha: fetcher.data.oursSha } : {}),
        ...(fetcher.data?.theirsSha ? { theirs_sha: fetcher.data.theirsSha } : {}),
      },
      { method: 'POST' }
    );
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
  const autoMerged = fetcher.data?.conflict ? (fetcher.data.autoMerged ?? 0) : 0;
  const conflictOursSha = fetcher.data?.conflict ? (fetcher.data.oursSha ?? null) : null;
  const error = fetcher.data?.error ?? null;

  return {
    busy,
    pending,
    accept,
    applyResolutions,
    discard,
    conflictUnits,
    orderConflict,
    autoMerged,
    conflictOursSha,
    error,
  };
}

// ─── Conflict chooser (Phase 7) ──────────────────────────────────────────────

const SIDE_TITLE: Record<MergeChoice, string> = {
  ours: 'Live version (yours)',
  theirs: "Preview version (agent's)",
};
const SIDE_ACTION: Record<MergeChoice, string> = {
  ours: 'Keep live',
  theirs: 'Take preview',
};

/** One selectable side of a conflict card (radio + bounded preview). */
const ChoiceSide = ({
  unitId,
  side,
  selected,
  onChoose,
  children,
}: {
  unitId: string;
  side: MergeChoice;
  selected: boolean;
  onChoose: (side: MergeChoice) => void;
  children: ReactNode;
}) => (
  <label
    data-testid={`conflict-choose-${side}-${unitId}`}
    className={`flex flex-col gap-1.5 rounded-lg border p-2 cursor-pointer transition-colors ${
      selected
        ? 'border-amber-500 dark:border-amber-400 ring-1 ring-amber-500 dark:ring-amber-400 bg-amber-50/60 dark:bg-amber-950/40'
        : 'border-stone-200 dark:border-neutral-700 hover:border-amber-300 dark:hover:border-amber-700'
    }`}
  >
    <span className="flex items-center gap-2 text-xs font-medium text-gray-700 dark:text-gray-200">
      <input
        type="radio"
        name={`conflict-${unitId}`}
        checked={selected}
        onChange={() => onChoose(side)}
        className="accent-amber-600"
      />
      {SIDE_TITLE[side]}
      <span className="ml-auto text-[11px] font-normal text-gray-500 dark:text-gray-400">
        {SIDE_ACTION[side]}
      </span>
    </span>
    {children}
  </label>
);

/** Placeholder for a side where the slide was deleted. */
const Tombstone = ({ label }: { label: string }) => (
  <div className="flex h-full min-h-24 items-center justify-center rounded border border-dashed border-gray-300 dark:border-neutral-600 bg-gray-50 dark:bg-neutral-800/60 px-3 py-4 text-xs italic text-gray-500 dark:text-gray-400">
    {label}
  </div>
);

/**
 * Bounded render of one slide side. The deck's html is already trusted by the
 * real viewer; here it renders scaled-down inside a fully sandboxed iframe
 * (empty sandbox allowlist = no scripts, no same-origin access).
 */
const SlideFrame = ({ side }: { side: SlideSide }) => {
  const html = slideSideHtml(side);
  return (
    <div className="rounded border border-stone-200 dark:border-neutral-700 bg-white overflow-hidden">
      <iframe
        sandbox=""
        srcDoc={buildSlideSrcdoc(html)}
        title="Slide preview"
        loading="lazy"
        className="h-36 w-full pointer-events-none"
      />
      {side.notes ? (
        <div className="border-t border-stone-200 dark:border-neutral-700 bg-stone-50 dark:bg-neutral-800 px-2 py-1 text-[11px] text-gray-500 dark:text-gray-400 truncate">
          Notes: {side.notes}
        </div>
      ) : null}
    </div>
  );
};

/** Numbered id list for an ordering conflict side. */
const OrderList = ({ ids }: { ids: string[] }) => (
  <ol className="space-y-0.5 text-xs text-gray-700 dark:text-gray-300 max-h-36 overflow-y-auto">
    {ids.map((id, position) => (
      <li key={`${id}-${position}`} className="flex gap-1.5">
        <span className="w-5 shrink-0 text-right tabular-nums text-gray-400 dark:text-gray-500">
          {position + 1}.
        </span>
        <span className="truncate font-mono text-[11px]">{id}</span>
      </li>
    ))}
  </ol>
);

/** Field diff list for one side of the `__meta__` deck-settings conflict. */
const MetaFieldList = ({
  rows,
  side,
}: {
  rows: ReturnType<typeof metaFieldRows>;
  side: MergeChoice;
}) => (
  <dl className="space-y-1 text-xs max-h-36 overflow-y-auto">
    {rows.map(row => (
      <div key={row.field} className="flex gap-2">
        <dt className="w-24 shrink-0 font-mono text-[11px] text-gray-500 dark:text-gray-400">
          {row.field}
        </dt>
        <dd className="break-all text-gray-800 dark:text-gray-200">
          {side === 'ours' ? row.ours : row.theirs}
        </dd>
      </div>
    ))}
  </dl>
);

const cardShell =
  'rounded-lg border border-rose-200 dark:border-rose-800/70 bg-white dark:bg-neutral-900 p-3';
const cardBadge =
  'rounded-full bg-rose-100 dark:bg-rose-900/60 px-2 py-0.5 text-[11px] text-rose-800 dark:text-rose-200';

/** One conflict card: side-by-side live vs preview with a choice per side. */
const ConflictCard = ({
  unit,
  choice,
  onChoose,
}: {
  unit: ConflictUnit;
  choice: MergeChoice | undefined;
  onChoose: (id: string, choice: MergeChoice) => void;
}) => {
  const isOrder = unit.id === ORDER_CONFLICT_ID || isChildOrderId(unit.id);
  const isMeta = unit.id === META_CONFLICT_ID;
  const title =
    unit.id === ORDER_CONFLICT_ID
      ? 'Slide order'
      : isChildOrderId(unit.id)
        ? `Stack ${unit.index || '?'} order`
        : isMeta
          ? 'Deck settings'
          : `Slide ${unit.index || '?'}`;
  const metaRows = isMeta
    ? metaFieldRows(
        unit.ours as Record<string, unknown> | undefined,
        unit.theirs as Record<string, unknown> | undefined
      )
    : [];

  const renderSide = (side: MergeChoice) => {
    const value = side === 'ours' ? unit.ours : unit.theirs;
    if (isOrder) {
      return <OrderList ids={Array.isArray(value) ? (value as string[]) : []} />;
    }
    if (isMeta) {
      return <MetaFieldList rows={metaRows} side={side} />;
    }
    if (value === undefined || value === null) {
      return (
        <Tombstone
          label={side === 'ours' ? 'Deleted in the live version' : 'Deleted in the preview'}
        />
      );
    }
    return <SlideFrame side={value as SlideSide} />;
  };

  return (
    <div data-testid={`conflict-card-${unit.id}`} className={cardShell}>
      <div className="flex items-center gap-2 text-xs">
        <span className="font-semibold text-gray-700 dark:text-gray-200">{title}</span>
        <span className={cardBadge}>{reasonLabel(unit.reason)}</span>
      </div>
      <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
        {(['ours', 'theirs'] as const).map(side => (
          <ChoiceSide
            key={side}
            unitId={unit.id}
            side={side}
            selected={choice === side}
            onChoose={chosen => onChoose(unit.id, chosen)}
          >
            {renderSide(side)}
          </ChoiceSide>
        ))}
      </div>
    </div>
  );
};

/**
 * Conflict chooser panel (Phase 7): a side-by-side card per conflicted slide
 * (plus stack-order / slide-order / deck-settings cards), an Apply footer that
 * submits a resolution for EVERY listed conflict, and a Discard escape.
 * Auto-merged counts from the accept report are surfaced so staff know only
 * the true collisions are listed.
 */
const ConflictPanel = ({
  units,
  orderConflict,
  autoMerged,
  oursSha,
  busy,
  onApply,
  onDiscard,
}: {
  units: ConflictUnit[];
  orderConflict: OrderConflict | null;
  autoMerged: number;
  oursSha: string | null;
  busy: boolean;
  onApply: (resolutions: MergeResolution[]) => void;
  onDiscard: () => void;
}) => {
  // The top-level order conflict arrives separately in the accept payload;
  // fold it into the card list under its sentinel id so one chooser covers
  // the full conflict set the resolve service validates against.
  const allUnits: ConflictUnit[] = orderConflict
    ? [
        ...units,
        {
          id: ORDER_CONFLICT_ID,
          index: '',
          reason: 'order',
          base: orderConflict.base,
          ours: orderConflict.ours,
          theirs: orderConflict.theirs,
        },
      ]
    : units;
  const ids = allUnits.map(unit => unit.id);
  // Keyed on the report's ours_sha too: a re-accept after main moved can
  // yield the SAME conflict ids over different content — stale choices must
  // not survive into the new report (F3).
  const signature = `${oursSha ?? ''}::${ids.join('|')}`;
  const [choices, setChoices] = useState<Record<string, MergeChoice>>({});
  // Drop stale choices when the conflict set changes (a re-accept can shrink it).
  useEffect(() => setChoices({}), [signature]);

  const choose = (id: string, choice: MergeChoice) =>
    setChoices(prev => ({ ...prev, [id]: choice }));
  const ready = allResolved(ids, choices);

  return (
    <div
      data-testid="preview-conflict-panel"
      className="border-b border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/95 px-4 sm:px-6 lg:px-8 py-3 max-h-[calc(100vh-8rem)] overflow-y-auto"
    >
      <div className="text-sm font-medium text-rose-900 dark:text-rose-100">
        Changes conflict with edits made on the live deck
      </div>
      <div
        data-testid="conflict-auto-merged"
        className="mt-0.5 text-sm text-rose-800 dark:text-rose-200"
      >
        {autoMerged > 0
          ? `${autoMerged} change${autoMerged === 1 ? '' : 's'} merged automatically; these need you:`
          : 'Choose which version to keep for each conflict:'}
      </div>

      <div className="mt-3 space-y-3">
        {allUnits.map(unit => (
          <ConflictCard key={unit.id} unit={unit} choice={choices[unit.id]} onChoose={choose} />
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="conflict-apply"
          disabled={!ready || busy}
          onClick={() => onApply(buildResolutions(ids, choices))}
          className={`${actionButtonBase} bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-500 dark:text-amber-950 dark:hover:bg-amber-400`}
        >
          {busy ? 'Applying…' : 'Apply choices'}
        </button>
        <button
          type="button"
          data-testid="conflict-discard"
          disabled={busy}
          onClick={onDiscard}
          className={`${actionButtonBase} text-rose-800 dark:text-rose-200 ring-1 ring-rose-300 dark:ring-rose-700 hover:bg-rose-100 dark:hover:bg-rose-900/40`}
        >
          Discard preview
        </button>
        <span className="text-xs text-rose-700 dark:text-rose-300">
          {ready
            ? 'Applies your choice for every conflict and publishes the merge.'
            : 'Pick a version for every conflict to enable Apply.'}{' '}
          Or re-apply from the current version (via your agent).
        </span>
      </div>
    </div>
  );
};

const actionButtonBase =
  'rounded px-3 py-1 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * Persistent top bar shown while previewing the pending branch.
 * Amber identity in both light and dark modes; fixed under the slides navbar.
 */
export const PreviewBar = ({ preview }: { preview: PreviewInfo }) => {
  const {
    busy,
    pending,
    accept,
    applyResolutions,
    discard,
    conflictUnits,
    orderConflict,
    autoMerged,
    conflictOursSha,
    error,
  } = usePreviewActions();
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
                GitHub diff
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
              {busy && pending === 'accept' ? 'Merging…' : 'Merge'}
            </button>
          </div>
        </div>
        {error && <div className="mt-2 text-sm text-rose-700 dark:text-rose-300">{error}</div>}
      </div>
      {conflictUnits && (
        <ConflictPanel
          units={conflictUnits}
          orderConflict={orderConflict}
          autoMerged={autoMerged}
          oursSha={conflictOursSha}
          busy={busy}
          onApply={applyResolutions}
          onDiscard={discard}
        />
      )}
    </div>
  );
};

/**
 * Slim staff-only banner on the normal (live) view when a preview branch exists.
 */
export const PendingPreviewBanner = ({ preview }: { preview: PreviewInfo }) => {
  const {
    busy,
    pending,
    accept,
    applyResolutions,
    discard,
    conflictUnits,
    orderConflict,
    autoMerged,
    conflictOursSha,
    error,
  } = usePreviewActions();
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
            {busy && pending === 'accept' ? 'Merging…' : 'Merge'}
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
      {conflictUnits && (
        <ConflictPanel
          units={conflictUnits}
          orderConflict={orderConflict}
          autoMerged={autoMerged}
          oursSha={conflictOursSha}
          busy={busy}
          onApply={applyResolutions}
          onDiscard={discard}
        />
      )}
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
