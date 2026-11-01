import type { FeedbackStatus } from '@prisma/client';
import { STATUS_META } from './feedback';

/** A status as a coloured badge with its emoji: ◌ Planned, ✓ Fixed… */
export function StatusLabel({
  status,
  size = 'sm',
}: {
  status: FeedbackStatus;
  size?: 'sm' | 'md';
}) {
  const meta = STATUS_META[status];
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border font-semibold leading-none ${meta.badge} ${
        size === 'md' ? 'px-3 py-1.5 text-sm' : 'px-2.5 py-1 text-[12px]'
      }`}
    >
      <span aria-hidden>{meta.glyph}</span>
      {meta.label}
    </span>
  );
}
