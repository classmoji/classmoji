import { useEffect, useRef, useState } from 'react';
import {
  IconAlertCircleFilled,
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconX,
} from '@tabler/icons-react';

/**
 * The background-work panel, docked bottom right: progress while a batch runs,
 * the outcome when it ends, and what did not finish grouped by reason. It
 * replaces the progress callout for batches, so the outcome stays on screen
 * until the instructor closes it instead of scrolling away with the page.
 *
 * Copy is kept to a few words on purpose: a title per reason, one short line on
 * how to fix it when there is something to fix, and the names behind a toggle.
 */

export interface FailureGroup {
  key: string;
  title: string;
  /** One short line, or nothing when there is nothing the instructor can do. */
  fix?: string;
  /** Who each failed unit was for (student login, team or repository name). */
  names: string[];
}

export interface PanelState {
  /** "Creating student repositories", then "Student repositories created". */
  title: string;
  status: 'running' | 'done' | 'lost';
  done: number;
  total: number;
  /** What the newest running unit says it is doing. */
  current?: string;
  /** The unit's noun, plural: "repositories". */
  noun: string;
  failures: FailureGroup[];
}

interface OperationPanelProps {
  state: PanelState;
  onClose: () => void;
  /** Absent when the operation has no retry (only publishes and syncs do). */
  onRetry?: () => void;
}

export const OperationPanel = ({ state, onClose, onRetry }: OperationPanelProps) => {
  const [minimized, setMinimized] = useState(false);
  const ref = useRef<HTMLElement>(null);

  // Quick callouts dock in the same corner (CalloutSlot placement
  // "bottom-right"): keep them stacked just above this panel, at its height.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const sync = () =>
      root.style.setProperty('--callout-bottom', `${el.getBoundingClientRect().height + 24}px`);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--callout-bottom');
    };
  }, []);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const failed = state.failures.reduce((n, g) => n + g.names.length, 0);
  const pct = state.total > 0 ? Math.round((state.done / state.total) * 100) : 0;

  return (
    <section
      ref={ref}
      aria-label="Background work"
      data-testid="operation-panel"
      className="fixed bottom-4 right-4 z-[60] flex max-h-[min(70vh,560px)] w-[calc(100vw-2rem)] max-w-[360px] flex-col overflow-hidden rounded-xl bg-panel shadow-[var(--shadow-float)] ring-1 ring-line"
    >
      <header
        className={`flex items-center gap-2 py-2.5 pl-3.5 pr-2 ${minimized ? '' : 'border-b border-line'}`}
      >
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink-0">
          {state.title}
        </span>
        <button
          type="button"
          onClick={() => setMinimized(m => !m)}
          aria-label={minimized ? 'Expand' : 'Minimize'}
          aria-expanded={!minimized}
          className="grid h-6 w-6 cursor-pointer place-items-center rounded-md border-none bg-transparent text-ink-3 hover:bg-nav-hover hover:text-ink-1"
        >
          {minimized ? <IconChevronUp size={15} /> : <IconChevronDown size={15} />}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid h-6 w-6 cursor-pointer place-items-center rounded-md border-none bg-transparent text-ink-3 hover:bg-nav-hover hover:text-ink-1"
        >
          <IconX size={15} />
        </button>
      </header>

      {!minimized && (
        <div className="flex flex-col overflow-y-auto">
          <div className="flex flex-col gap-1.5 px-3.5 py-3">
            <div className="flex items-center gap-2.5 text-[12.5px]">
              {state.status === 'running' ? (
                <span
                  aria-hidden
                  className="h-3.5 w-3.5 flex-none animate-spin rounded-full border-2 border-accent/30 border-t-accent"
                />
              ) : state.status === 'lost' ? (
                <IconAlertCircleFilled size={15} className="flex-none text-ink-3" aria-hidden />
              ) : (
                <IconCheck size={15} className="flex-none text-accent" aria-hidden />
              )}
              <span className="min-w-0 flex-1 font-medium text-ink-1">
                {state.status === 'lost'
                  ? 'Lost track. Reload to check.'
                  : `${state.done} of ${state.total} ${state.noun}`}
              </span>
            </div>
            {state.status === 'running' && (
              <>
                <div
                  aria-hidden
                  className="h-[5px] w-full overflow-hidden rounded-full bg-[var(--bar-track)]"
                >
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-200 ease-linear"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                {state.current && (
                  <p className="m-0 truncate text-[12px] text-ink-3">{state.current}</p>
                )}
              </>
            )}
          </div>

          {failed > 0 && (
            <>
              <p className="m-0 border-t border-line px-3.5 pb-1.5 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-rose-ink">
                {failed} did not finish
              </p>
              <ul className="m-0 flex list-none flex-col gap-2 p-0 px-2.5 pb-2.5">
                {state.failures.map(group => (
                  <li
                    key={group.key}
                    data-testid="operation-failure-group"
                    className="flex flex-col gap-1 rounded-[4px] border border-rose-bord bg-rose-bg px-3 py-2"
                  >
                    <div className="flex items-start gap-2">
                      <IconAlertCircleFilled
                        size={15}
                        className="mt-px flex-none text-rose-ink"
                        aria-hidden
                      />
                      <span className="text-[12.5px] font-semibold text-rose-ink">
                        {group.title}
                        {group.names.length > 1 ? ` · ${group.names.length}` : ''}
                      </span>
                    </div>
                    {group.fix && (
                      <p className="m-0 pl-[23px] text-[12px] leading-snug text-ink-1">
                        {group.fix}
                      </p>
                    )}
                    {open[group.key] && (
                      <ul className="m-0 list-none p-0 pl-[23px]">
                        {group.names.map(name => (
                          <li key={name} className="break-all text-[12px] text-ink-2">
                            {name}
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="flex gap-3.5 pl-[23px]">
                      {onRetry && (
                        <button
                          type="button"
                          onClick={onRetry}
                          className="cursor-pointer border-none bg-transparent p-0 text-[12px] font-semibold text-rose-ink underline underline-offset-2"
                        >
                          Retry
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setOpen(o => ({ ...o, [group.key]: !o[group.key] }))}
                        aria-expanded={Boolean(open[group.key])}
                        className="cursor-pointer border-none bg-transparent p-0 text-[12px] font-semibold text-rose-ink underline underline-offset-2"
                      >
                        {open[group.key] ? 'Hide' : 'Show'}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
};

export default OperationPanel;
