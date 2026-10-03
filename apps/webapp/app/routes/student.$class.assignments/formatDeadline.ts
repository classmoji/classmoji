import dayjs from 'dayjs';
import type { AssignmentStatus } from './AssignmentsTabsCard';

/**
 * The Deadline column's text. Only a row the student still owes work on can be
 * overdue or due soon; a completed (submitted) row, the same status its green
 * pill shows, gets the plain date, or it would read "Submitted" and
 * "overdue" side by side.
 */
export const formatDeadline = (deadline: string, status: AssignmentStatus, now = dayjs()) => {
  const target = dayjs(deadline);
  if (status === 'completed') return target.format('MMM D');
  const today = now.startOf('day');
  const days = target.startOf('day').diff(today, 'day');
  if (days < 0) return `overdue · ${target.format('MMM D')}`;
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  return target.format('MMM D');
};
