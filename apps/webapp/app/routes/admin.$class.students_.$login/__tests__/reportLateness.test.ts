/**
 * The student report's lateness copy: the points the late penalty actually
 * took from repo submissions, never hours × rate, never "−0 pts", and never
 * quiz points (E1: quiz grades show as emoji).
 */
import { describe, expect, it } from 'vitest';
import type { GitRepoAssignment, GradedItem } from '@classmoji/utils';
import { lateTileSummary, latePillText, quizScoreNote, repoPointsLost } from '../reportLateness';

const item = (over: Partial<GradedItem> = {}): GradedItem => ({
  assignment_id: 'a-quiz',
  module_id: 'mod-1',
  weight: 10,
  is_extra_credit: false,
  grade: 78,
  raw_grade: 90,
  counts_as_zero: false,
  late_hours: 6,
  counting_raw_percentage: 90,
  ...over,
});

describe('lateTileSummary (the report header)', () => {
  it('counts late quizzes and their hours but takes no quiz points (E1)', () => {
    const repo = [
      { id: 'r1', is_late: true, is_late_override: false, num_late_hours: 2 },
      { id: 'r2', is_late: true, is_late_override: true, num_late_hours: 9 },
      { id: 'r3', is_late: false, is_late_override: false, num_late_hours: 0 },
    ];
    // A late quiz that lost 12 points.
    const quizzes = [item(), item({ late_hours: 0 })];
    expect(lateTileSummary(repo, quizzes, row => (row.id === 'r1' ? 5.04 : 99))).toEqual({
      count: 2,
      hours: 8,
      pointsLost: 5,
    });
  });
});

describe('latePillText', () => {
  it('shows the points lost when there are some', () => {
    expect(latePillText(6, 12)).toBe('Late 6h · −12 pts');
  });

  it('never says −0 pts', () => {
    expect(latePillText(3, 0)).toBe('Late 3h');
  });
});

describe('quizScoreNote', () => {
  it("quotes the counting attempt's own score before the penalty", () => {
    expect(quizScoreNote(item(), 78)).toBe('90 before the late penalty');
  });

  it('says nothing for an on-time attempt, even when the raw pick differs', () => {
    expect(
      quizScoreNote(
        item({ grade: 80, raw_grade: 95, counting_raw_percentage: 80, late_hours: 0 }),
        80
      )
    ).toBeUndefined();
  });

  it('says nothing when the penalty took nothing, or for a counted zero', () => {
    expect(quizScoreNote(item({ grade: 90 }), 90)).toBeUndefined();
    expect(
      quizScoreNote(
        item({ counts_as_zero: true, grade: 0, raw_grade: 0, counting_raw_percentage: null }),
        0
      )
    ).toBeUndefined();
  });
});

describe('repoPointsLost', () => {
  const settings = { late_penalty_points_per_hour: 20 };
  const mappings = { '+1': 50, heart: 100 };
  const submission = (over: Record<string, unknown> = {}) =>
    ({
      num_late_hours: 2,
      is_late_override: false,
      should_be_zero: false,
      grades: [{ emoji: '+1' }],
      assignment: { weight: 10, is_extra_credit: false, type: 'REPO' },
      ...over,
    }) as unknown as GitRepoAssignment;

  it('is what the penalty took from the grade, floored at 0', () => {
    // 2 h × 20 = 40 off a 50.
    expect(repoPointsLost(submission(), mappings, settings)).toBe(40);
    // 4 h × 20 = 80, but a 50 can only lose 50.
    expect(repoPointsLost(submission({ num_late_hours: 4 }), mappings, settings)).toBe(50);
  });

  it('is 0 before grading and when the lateness was waived', () => {
    expect(repoPointsLost(submission({ grades: [] }), mappings, settings)).toBe(0);
    expect(repoPointsLost(submission({ is_late_override: true }), mappings, settings)).toBe(0);
  });
});
