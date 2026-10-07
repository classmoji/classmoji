import React from 'react';
import { IconCheck, IconChevronDown, IconX } from '@tabler/icons-react';

/**
 * The webapp's background-work panel (apps/webapp/app/components/features/
 * operations/OperationPanel.tsx), docked top right: progress while a batch
 * runs, then the outcome. The demo only ever shows a clean run.
 */
export function AppOperationPanel({
  title,
  done,
  total,
  noun,
  running,
  current,
}: {
  title: string;
  done: number;
  total: number;
  noun: string;
  running: boolean;
  current?: string;
}) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <section
      aria-label="Background work"
      className="flex w-[300px] flex-col overflow-hidden rounded-xl bg-panel shadow-float ring-1 ring-line dark:bg-panel-dark dark:ring-line-dark"
    >
      <header className="flex items-center gap-2 border-b border-line py-2.5 pl-3.5 pr-2 dark:border-line-dark">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink-0 dark:text-inkd-0">
          {title}
        </span>
        <span className="grid h-6 w-6 place-items-center text-ink-3">
          <IconChevronDown size={15} />
        </span>
        <span className="grid h-6 w-6 place-items-center text-ink-3">
          <IconX size={15} />
        </span>
      </header>
      <div className="flex flex-col gap-1.5 px-3.5 py-3">
        <div className="flex items-center gap-2.5 text-[12.5px]">
          {running ? (
            <span className="h-3.5 w-3.5 flex-none animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
          ) : (
            <IconCheck size={15} className="flex-none text-accent" />
          )}
          <span className="font-medium tabular-nums text-ink-1 dark:text-inkd-1">
            {done} of {total} {noun}
          </span>
        </div>
        {running && (
          <>
            <div className="h-[5px] w-full overflow-hidden rounded-full bg-[#e4e8f1] dark:bg-[#252a3b]">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-200 ease-linear"
                style={{ width: `${pct}%` }}
              />
            </div>
            {current && <p className="m-0 truncate text-[12px] text-ink-3">{current}</p>}
          </>
        )}
      </div>
    </section>
  );
}
