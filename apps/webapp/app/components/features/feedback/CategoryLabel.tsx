import type { FeedbackCategory } from '@prisma/client';
import { CATEGORY_EMOJI, CATEGORY_LABELS } from './feedback';

export function CategoryLabel({
  category,
  className = '',
}: {
  category: FeedbackCategory;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-3 ${className}`}
    >
      <span aria-hidden>{CATEGORY_EMOJI[category]}</span>
      {CATEGORY_LABELS[category]}
    </span>
  );
}
