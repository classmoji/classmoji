/**
 * What the student report says about lateness: the points the late penalty
 * actually took, never hours × rate (the penalty floors at 0, and a quiz's
 * strategy may count an on-time attempt over a late one).
 */
import {
  calculateAssignmentGrade,
  type GitRepoAssignment,
  type GradedItem,
  type OrganizationSettings,
} from '@classmoji/utils';

const tenth = (value: number) => Math.round(value * 10) / 10;

/**
 * Points a graded repo submission lost to the late penalty. Nothing is lost
 * before it is graded, or when the lateness was waived.
 */
export const repoPointsLost = (
  submission: GitRepoAssignment,
  emojiMappings: Record<string, number>,
  settings: OrganizationSettings
): number => {
  if (submission.is_late_override) return 0;
  const counted = calculateAssignmentGrade(submission, emojiMappings, settings);
  const raw = calculateAssignmentGrade(submission, emojiMappings, settings, false);
  if (counted === null || raw === null) return 0;
  return tenth(Math.max(0, raw - counted));
};

/**
 * The report header's Late tile: how many repo submissions and quizzes were
 * late, their hours together, and the points the penalty took from the repo
 * submissions (`repoLost`, as their rows show it). Quiz points are left out:
 * they are a number, and quiz grades show as emoji (E1).
 */
export const lateTileSummary = <
  R extends {
    is_late?: boolean | null;
    is_late_override?: boolean | null;
    num_late_hours?: number | null;
  },
>(
  repoRows: readonly R[],
  quizItems: readonly Pick<GradedItem, 'late_hours'>[],
  repoLost: (row: R) => number
) => {
  const lateRows = repoRows.filter(ra => ra.is_late && !ra.is_late_override);
  const lateQuizItems = quizItems.filter(item => item.late_hours > 0);
  return {
    count: lateRows.length + lateQuizItems.length,
    hours:
      lateRows.reduce((sum, ra) => sum + (ra.num_late_hours ?? 0), 0) +
      lateQuizItems.reduce((sum, item) => sum + item.late_hours, 0),
    pointsLost: tenth(lateRows.reduce((sum, ra) => sum + repoLost(ra), 0)),
  };
};

/** "Late 3h", plus " · −12 pts" only when the penalty took something. */
export const latePillText = (hours: number, lost: number) =>
  `Late ${hours}h${lost > 0 ? ` · −${lost} pts` : ''}`;

/**
 * The tooltip on a quiz's score: the counting attempt's own score before the
 * penalty, only when it was late and the penalty changed it.
 */
export const quizScoreNote = (item: GradedItem, shown: number): string | undefined => {
  if (item.counts_as_zero || item.late_hours <= 0) return undefined;
  const raw = item.counting_raw_percentage;
  return raw != null && raw !== shown ? `${tenth(raw)} before the late penalty` : undefined;
};
