import React from 'react';
import { IconCheck, IconX } from '@tabler/icons-react';

/**
 * The webapp's callout (packages/ui-components/src/Callout/CalloutCard.tsx and
 * `.cm-callout*` in styles/components.css): progress shows the count under the
 * title and a bar across the body; success reads as one line.
 */
export function AppCallout({
  variant,
  title,
  message,
  progress,
}: {
  variant: 'progress' | 'success';
  title: string;
  message?: string;
  progress?: number;
}) {
  const isProgress = variant === 'progress';
  return (
    <div
      role="status"
      className="mx-auto flex w-[372px] items-center gap-[11px] rounded-[10px] border border-line bg-panel px-[13px] py-[11px] text-ink-1 shadow-float dark:border-line-dark dark:bg-panel-dark"
    >
      <span className="flex h-[18px] w-[18px] flex-none items-center justify-center text-accent">
        {isProgress ? (
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
        ) : (
          <IconCheck size={15} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        {isProgress ? (
          <>
            <div className="text-[13.5px] font-semibold leading-[1.35] text-ink-1">{title}</div>
            {message && (
              <div className="text-[12px] leading-[1.4] tabular-nums text-ink-3">{message}</div>
            )}
            {progress !== undefined && (
              <div className="mt-[7px] h-[5px] w-full overflow-hidden rounded-full bg-[#e4e8f1] dark:bg-[#252a3b]">
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-200 ease-linear"
                  style={{ width: `${Math.max(0, Math.min(1, progress)) * 100}%` }}
                />
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-wrap items-baseline gap-1.5">
            <span className="text-[13.5px] font-semibold leading-[1.35] text-ink-1">{title}</span>
            {message && <span className="text-[13px] tabular-nums text-ink-2">{message}</span>}
          </div>
        )}
      </div>
      <span className="mt-px flex h-5 w-5 flex-none items-center justify-center self-start rounded-md text-ink-3">
        <IconX size={13} />
      </span>
    </div>
  );
}
