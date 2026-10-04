import type { FeedbackStatus } from '@prisma/client';
import type { LucideIcon } from 'lucide-react';
import { CheckCircle2Icon, CircleDashedIcon, CircleDotIcon, EyeIcon } from 'lucide-react';
import { STATUS_META } from './feedback';

const ICONS: Record<FeedbackStatus, LucideIcon> = {
  IN_REVIEW: EyeIcon,
  PLANNED: CircleDashedIcon,
  IN_PROGRESS: CircleDotIcon,
  COMPLETED: CheckCircle2Icon,
};

export function StatusLabel({
  status,
  size = 'sm',
}: {
  status: FeedbackStatus;
  size?: 'sm' | 'md';
}) {
  const Icon = ICONS[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 font-semibold ${STATUS_META[status].ink} ${
        size === 'md' ? 'text-base' : 'text-xs'
      }`}
    >
      <Icon className={size === 'md' ? 'h-[18px] w-[18px]' : 'h-3.5 w-3.5'} aria-hidden />
      {STATUS_META[status].label}
    </span>
  );
}
