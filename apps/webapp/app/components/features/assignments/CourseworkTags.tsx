import { IconCheck } from '@tabler/icons-react';
import type { CourseworkStatus, CourseworkType } from '@classmoji/services';

/**
 * The type tag and status pill a student's coursework rows share, on the
 * Assignments page and the dashboard's Up next card. Colours come from the
 * design tokens, which carry their own dark-mode values.
 */

const TYPE_TAG_STYLE: Record<CourseworkType, string> = {
  REPO: 'bg-peach-bg text-peach-ink border-peach-bord',
  QUIZ: 'bg-mint-bg text-mint-ink border-mint-bord',
  FORM: 'bg-lilac-bg text-lilac-ink border-lilac-bord',
};

export const CourseworkTypeTag = ({ type }: { type: CourseworkType }) => (
  <span
    className={`inline-flex justify-center min-w-[3.25rem] px-1.5 py-0.5 rounded-md border text-[11px] font-bold tracking-[0.06em] ${TYPE_TAG_STYLE[type]}`}
  >
    {type}
  </span>
);

export const COURSEWORK_STATUS_LABEL: Record<CourseworkStatus, string> = {
  NOT_SUBMITTED: 'Not submitted',
  SUBMITTED: 'Submitted',
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  CLOSED: 'Closed',
};

const STATUS_PILL_STYLE: Record<CourseworkStatus, string> = {
  NOT_SUBMITTED: 'bg-[#D4A289]/15 text-[#8a5b3a] dark:bg-[#D4A289]/20 dark:text-[#E8C4AC]',
  NOT_STARTED: 'bg-[#D4A289]/15 text-[#8a5b3a] dark:bg-[#D4A289]/20 dark:text-[#E8C4AC]',
  IN_PROGRESS: 'bg-sky-500/15 text-sky-700 dark:bg-sky-400/20 dark:text-sky-300',
  SUBMITTED: 'bg-[#619462]/15 text-[#3f6a40] dark:bg-[#619462]/20 dark:text-[#9BC39C]',
  COMPLETED: 'bg-[#619462]/15 text-[#3f6a40] dark:bg-[#619462]/20 dark:text-[#9BC39C]',
  CLOSED: 'bg-stone-500/15 text-stone-600 dark:bg-stone-400/15 dark:text-stone-300',
};

export const CourseworkStatusPill = ({ status }: { status: CourseworkStatus }) => (
  <span
    className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${STATUS_PILL_STYLE[status]}`}
  >
    {(status === 'SUBMITTED' || status === 'COMPLETED') && <IconCheck size={12} stroke={3} />}
    {COURSEWORK_STATUS_LABEL[status]}
  </span>
);
