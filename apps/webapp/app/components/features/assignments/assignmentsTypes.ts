export type AssignmentKind = 'QUIZ' | 'ASGN' | 'PROJ';
export type AssignmentState = 'open' | 'graded' | 'upcoming' | 'closed' | 'draft';

export interface AssignmentRow {
  /** Stable identifier (quiz id or assignment id). */
  id: string;
  /** Slug used in the URL path — often same as id. */
  slug: string;
  /** Full link to the detail view (role-aware). */
  href: string;
  kind: AssignmentKind;
  title: string;
  /** Module label e.g. "2" or "Unlinked". */
  mod: string;
  /** Formatted due date e.g. "Apr 8" — empty string when none. */
  due: string;
  state: AssignmentState;
  emoji?: string | null;
  pct?: number | null;
}

export type AssignmentFilter = 'all' | 'open' | 'upcoming' | 'graded';

export const ASSIGNMENT_FILTERS: { id: AssignmentFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'open', label: 'Open' },
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'graded', label: 'Graded' },
];
