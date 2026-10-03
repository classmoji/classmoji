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
 * Points a quiz item lost to the late penalty: the counting attempt's raw
 * score minus what it counts for. 0 for a counted zero or an on-time attempt.
 */
export const quizPointsLost = (item: GradedItem): number => {
  if (item.counts_as_zero || item.late_hours <= 0) return 0;
  if (item.counting_raw_percentage == null || item.grade == null) return 0;
  return tenth(Math.max(0, item.counting_raw_percentage - item.grade));
};

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
