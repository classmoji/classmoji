import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import {
  changedSinceRunText,
  changesSinceThisRunText,
  runTitle,
  runlineText,
  staleChipText,
} from './teamsView.ts';
import type { RunViewModel } from './types.ts';
import { useViewportClamp } from './useViewportClamp.ts';

/**
 * The line above a run: its title and what the engine proved ("Run 4 ·
 * proven best", "Run 4 · within 2.4% of best", "Run 6 · not solved"), then
 * chips for what has moved since the run, then the route's actions.
 *
 * Chips (each shown only when it has something to say):
 *   - "{k} changes since this run": the current setup against the run's; the
 *     chip opens the list of changes.
 *   - the stale chip (`staleChipText`): answers or the roster changed since
 *     the run (Create refuses it); the chip opens the reasons the service
 *     gave, as given.
 *   - "Changed since run {m}: …": this run's setup against the run before it
 *     (Can't solve passes `changes_from_previous`), in full.
 *
 * Presentational: the Compare picker and Create button are the route's, passed
 * as children and laid out on the right.
 */

export type RunlineRun = Pick<
  RunViewModel,
  'number' | 'status' | 'solver' | 'changes_since_run' | 'stale' | 'stale_reasons'
> &
  Partial<Pick<RunViewModel, 'changes_from_previous'>>;

export interface RunlineProps {
  run: RunlineRun;
  /** Actions on the right: Compare with…, Create teams…. */
  children?: ReactNode;
}

/** The runline title split in two: "Run 4" and " · proven best". */
function titleParts(run: RunlineRun): [string, string] {
  const head = runTitle(run.number);
  const full = runlineText(run.number, run.status, run.solver);
  return full.startsWith(head) ? [head, full.slice(head.length)] : [full, ''];
}

const CHIP_TONES = {
  changes:
    'border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-200',
  stale:
    'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200',
  plain:
    'border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200',
} as const;

type ChipTone = keyof typeof CHIP_TONES;

/**
 * A chip that opens a short list under it. Escape or a click elsewhere closes
 * it; the list is kept inside the viewport (`useViewportClamp`).
 */
function ChipPopover({ label, items, tone }: { label: string; items: string[]; tone: ChipTone }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useViewportClamp(panelRef, open);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(value => !value)}
        className={`rounded-full border px-2.5 py-0.5 text-left text-xs font-medium ${CHIP_TONES[tone]}`}
      >
        {label}
        <span aria-hidden="true" className="ml-1 opacity-60">
          ▾
        </span>
      </button>
      <div
        ref={panelRef}
        id={panelId}
        hidden={!open}
        className="absolute left-0 top-full z-20 mt-1.5 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-gray-200 bg-white p-3 shadow-lg dark:border-gray-700 dark:bg-gray-900"
      >
        <ul className="grid gap-1.5 text-sm text-gray-800 dark:text-gray-100">
          {items.map((item, index) => (
            <li key={`${index}-${item}`}>{item}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Chip({ label, tone }: { label: string; tone: ChipTone }) {
  return (
    <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${CHIP_TONES[tone]}`}>
      {label}
    </span>
  );
}

export function Runline({ run, children }: RunlineProps) {
  const [head, rest] = titleParts(run);
  const changes = run.changes_since_run;
  // A run view carries the reasons, not a count of changed responses.
  const staleLabel = run.stale ? staleChipText() : null;
  const previous = run.changes_from_previous;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-sm font-semibold text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-white">
        {head}
        {rest ? <span className="font-normal text-gray-500 dark:text-gray-400">{rest}</span> : null}
      </h2>

      {changes.length > 0 ? (
        <ChipPopover
          label={changesSinceThisRunText(changes.length)}
          items={changes.map(change => change.text)}
          tone="changes"
        />
      ) : null}

      {staleLabel ? (
        run.stale_reasons.length > 0 ? (
          <ChipPopover label={staleLabel} items={run.stale_reasons} tone="stale" />
        ) : (
          <Chip label={staleLabel} tone="stale" />
        )
      ) : null}

      {previous && previous.since_run !== null && previous.items.length > 0 ? (
        <Chip label={changedSinceRunText(previous.since_run, previous.items)} tone="plain" />
      ) : null}

      {children ? (
        <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>
      ) : null}
    </div>
  );
}

export default Runline;
