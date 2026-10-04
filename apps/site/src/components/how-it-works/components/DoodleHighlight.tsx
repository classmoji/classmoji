import React from 'react';
import type { ReactNode } from 'react';

type DoodleHighlightProps = {
  children: ReactNode;
  tone: 'github' | 'gitlab';
};

/** A restrained, imperfect marker swash for the two supported Git providers. */
export function DoodleHighlight({ children, tone }: DoodleHighlightProps) {
  const fill =
    tone === 'github'
      ? 'fill-[#D1D5DB] dark:fill-[#3F4654]'
      : 'fill-[#FDD3BD] dark:fill-[#7A3A1C]';

  return (
    <span className="relative inline-block whitespace-nowrap px-[0.06em]">
      <svg
        aria-hidden
        viewBox="0 0 180 38"
        preserveAspectRatio="none"
        className={`absolute -inset-x-1 bottom-0 z-0 h-[0.82em] w-[calc(100%+0.5rem)] overflow-visible ${fill}`}
      >
        <path d="M4 12C38 7 72 9 107 5c27-3 51 1 69 7-7 8-4 13-1 19-41-4-83 1-126 2-17 0-31-3-45-7 4-5 5-9 0-14Z" />
      </svg>
      <span className="relative z-10">{children}</span>
    </span>
  );
}
