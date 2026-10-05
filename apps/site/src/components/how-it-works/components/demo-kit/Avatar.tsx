import React from 'react';

type AvatarProps = {
  initials: string;
  size?: 'sm' | 'md';
};

/** Classmoji avatar fallback: round, stone-100 fill, stone-600 initials, 1px ring. */
export function Avatar({ initials, size = 'md' }: AvatarProps) {
  const sizing = size === 'sm' ? 'h-6 w-6 text-[9.5px]' : 'h-8 w-8 text-[11px]';
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-stone-100 font-semibold text-stone-600 ring-1 ring-edge dark:bg-neutral-800 dark:text-stone-300 dark:ring-neutral-700 ${sizing}`}
    >
      {initials}
    </span>
  );
}
