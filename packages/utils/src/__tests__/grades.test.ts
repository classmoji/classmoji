import { describe, it, expect } from 'vitest';
import {
  calculateLetterGrade,
  calculateNumericGrade,
  applyLatePenalty,
  gradeToEmoji,
  calculateRepositoryGrade,
  calculateStudentFinalGrade,
  getDroppedRepositoryAssignments,
  isRepositoryAssignmentDropped,
  calculateGrades,
  type RepositoryAssignment,
  type Module,
  type Repository,
  type OrganizationSettings,
} from '../grades.ts';
import type { LetterGradeMappingEntry } from '../emojis.ts';

const LETTER_GRADES: LetterGradeMappingEntry[] = [
  { letter_grade: 'A', min_grade: 90 },
  { letter_grade: 'B', min_grade: 80 },
  { letter_grade: 'C', min_grade: 70 },
  { letter_grade: 'D', min_grade: 60 },
];

const EMOJI_MAP: Record<string, number> = { heart: 100, '+1': 90, eyes: 80, '-1': 60, sob: 0 };

const NO_PENALTY: OrganizationSettings = { late_penalty_points_per_hour: 0 };
const PENALTY_5: OrganizationSettings = { late_penalty_points_per_hour: 5 };

const ra = (
  overrides: Partial<RepositoryAssignment> & { id?: string } = {}
): RepositoryAssignment => ({
  id: overrides.id ?? 'ra-1',
  assignment: { weight: 100 },
  ...overrides,
});

const mod = (overrides: Partial<Module> = {}): Module => ({
  weight: 100,
  is_extra_credit: false,
  ...overrides,
});

describe('calculateLetterGrade', () => {
  it('maps numeric to highest matching letter', () => {
    expect(calculateLetterGrade(95, LETTER_GRADES)).toBe('A');
    expect(calculateLetterGrade(90, LETTER_GRADES)).toBe('A');
    expect(calculateLetterGrade(85, LETTER_GRADES)).toBe('B');
    expect(calculateLetterGrade(60, LETTER_GRADES)).toBe('D');
  });

  it('falls back to F when below all thresholds', () => {
    expect(calculateLetterGrade(50, LETTER_GRADES)).toBe('F');
  });

  it('falls back to F on empty mapping', () => {
    expect(calculateLetterGrade(100, [])).toBe('F');
  });
});

describe('calculateNumericGrade', () => {
  it('returns 0 for empty emoji list', () => {
    expect(calculateNumericGrade([], EMOJI_MAP)).toBe(0);
  });

  it('averages emoji grades', () => {
    expect(calculateNumericGrade(['heart', 'eyes'], EMOJI_MAP)).toBe(90);
  });
});

describe('applyLatePenalty', () => {
  it('subtracts hours * penalty when not overridden', () => {
    expect(
      applyLatePenalty(100, ra({ num_late_hours: 4, is_late_override: false }), PENALTY_5)
    ).toBe(80);
  });

  it('does not penalize when is_late_override is true', () => {
    expect(
      applyLatePenalty(100, ra({ num_late_hours: 4, is_late_override: true }), PENALTY_5)
    ).toBe(100);
  });

  it('clamps at zero', () => {
    expect(
      applyLatePenalty(10, ra({ num_late_hours: 100, is_late_override: false }), PENALTY_5)
    ).toBe(0);
  });

  it('treats undefined num_late_hours as zero', () => {
    expect(applyLatePenalty(100, ra({ is_late_override: false }), PENALTY_5)).toBe(100);
  });
});

describe('gradeToEmoji', () => {
  it('picks the closest emoji by grade', () => {
    const map = { heart: 100, '+1': 90, eyes: 80 };
    expect(gradeToEmoji(89, map)).toBe('+1');
    expect(gradeToEmoji(100, map)).toBe('heart');
    expect(gradeToEmoji(82, map)).toBe('eyes');
  });
});

describe('calculateRepositoryGrade', () => {
  it('returns -1 when no assignments', () => {
    expect(calculateRepositoryGrade([], EMOJI_MAP, NO_PENALTY, mod())).toBe(-1);
  });

  it('returns -1 when no graded assignments contributed', () => {
    expect(calculateRepositoryGrade([ra({ grades: [] })], EMOJI_MAP, NO_PENALTY, mod())).toBe(-1);
  });

  it('treats should_be_zero as 0', () => {
    expect(
      calculateRepositoryGrade([ra({ should_be_zero: true })], EMOJI_MAP, NO_PENALTY, mod())
    ).toBe(0);
  });

  it('weights assignments correctly (no drops)', () => {
    const assignments = [
      ra({ id: 'a', grades: [{ emoji: 'heart' }], assignment: { weight: 50 } }), // 100
      ra({ id: 'b', grades: [{ emoji: 'eyes' }], assignment: { weight: 50 } }), // 80
    ];
    expect(calculateRepositoryGrade(assignments, EMOJI_MAP, NO_PENALTY, mod())).toBe(90);
  });

  it('drops the lowest scoring assignment when drop_lowest_count=1', () => {
    const assignments = [
      ra({ id: 'a', grades: [{ emoji: 'heart' }], assignment: { weight: 50 } }), // 100
      ra({ id: 'b', grades: [{ emoji: 'eyes' }], assignment: { weight: 50 } }), // 80
      ra({ id: 'c', grades: [{ emoji: '-1' }], assignment: { weight: 50 } }), // 60 (dropped)
    ];
    expect(
      calculateRepositoryGrade(assignments, EMOJI_MAP, NO_PENALTY, mod({ drop_lowest_count: 1 }))
    ).toBe(90);
  });

  it('extra_credit modules sum without dividing by total weight', () => {
    const assignments = [ra({ id: 'a', grades: [{ emoji: 'heart' }], assignment: { weight: 50 } })];
    expect(
      calculateRepositoryGrade(
        assignments,
        EMOJI_MAP,
        NO_PENALTY,
        mod({ is_extra_credit: true, weight: 50 })
      )
    ).toBe(50); // 100 * (50/100)
  });
});

describe('calculateStudentFinalGrade', () => {
  const repo = (assignments: RepositoryAssignment[], module: Module): Repository => ({
    assignments,
    module,
  });

  it('returns -1 if no graded modules', () => {
    expect(calculateStudentFinalGrade([], EMOJI_MAP, NO_PENALTY)).toBe(-1);
  });

  it('combines weighted module grades', () => {
    const repos: Repository[] = [
      repo([ra({ grades: [{ emoji: 'heart' }] })], mod({ weight: 50 })),
      repo([ra({ id: 'b', grades: [{ emoji: 'eyes' }] })], mod({ weight: 50 })),
    ];
    // (100*0.5 + 80*0.5) / (50+50) * 100 = 90
    expect(calculateStudentFinalGrade(repos, EMOJI_MAP, NO_PENALTY)).toBe(90);
  });

  it('skips GROUP modules when includeGroupAssignment=false', () => {
    const repos: Repository[] = [
      repo([ra({ grades: [{ emoji: 'heart' }] })], mod({ weight: 50, type: 'GROUP' })),
      repo([ra({ id: 'b', grades: [{ emoji: 'eyes' }] })], mod({ weight: 50 })),
    ];
    expect(calculateStudentFinalGrade(repos, EMOJI_MAP, NO_PENALTY, true, false)).toBe(80);
  });

  it('adds extra credit module on top when penalty included', () => {
    const repos: Repository[] = [
      repo([ra({ grades: [{ emoji: 'eyes' }] })], mod({ weight: 100 })),
      repo(
        [ra({ id: 'x', grades: [{ emoji: 'heart' }] })],
        mod({ weight: 5, is_extra_credit: true })
      ),
    ];
    // base 80 + extra (100 * 5/100) = 80 + 5 = 85
    expect(calculateStudentFinalGrade(repos, EMOJI_MAP, NO_PENALTY, true)).toBe(85);
  });
});

describe('getDroppedRepositoryAssignments', () => {
  it('returns empty when drop_lowest_count is 0', () => {
    const assignments = [ra({ grades: [{ emoji: 'heart' }] })];
    expect(getDroppedRepositoryAssignments(assignments, EMOJI_MAP, NO_PENALTY, mod())).toEqual([]);
  });

  it('returns the lowest id when dropping one', () => {
    const assignments = [
      ra({ id: 'a', grades: [{ emoji: 'heart' }] }),
      ra({ id: 'b', grades: [{ emoji: '-1' }] }),
    ];
    expect(
      getDroppedRepositoryAssignments(
        assignments,
        EMOJI_MAP,
        NO_PENALTY,
        mod({ drop_lowest_count: 1 })
      )
    ).toEqual(['b']);
  });

  it('returns empty when count >= assignments.length', () => {
    const assignments = [ra({ id: 'a', grades: [{ emoji: 'heart' }] })];
    expect(
      getDroppedRepositoryAssignments(
        assignments,
        EMOJI_MAP,
        NO_PENALTY,
        mod({ drop_lowest_count: 5 })
      )
    ).toEqual([]);
  });

  it('returns empty for extra credit modules', () => {
    const assignments = [
      ra({ id: 'a', grades: [{ emoji: 'heart' }] }),
      ra({ id: 'b', grades: [{ emoji: '-1' }] }),
    ];
    expect(
      getDroppedRepositoryAssignments(
        assignments,
        EMOJI_MAP,
        NO_PENALTY,
        mod({ is_extra_credit: true, drop_lowest_count: 1 })
      )
    ).toEqual([]);
  });
});

describe('isRepositoryAssignmentDropped', () => {
  it('detects dropped vs kept', () => {
    const assignments = [
      ra({ id: 'a', grades: [{ emoji: 'heart' }] }),
      ra({ id: 'b', grades: [{ emoji: '-1' }] }),
    ];
    const m = mod({ drop_lowest_count: 1 });
    expect(isRepositoryAssignmentDropped('b', assignments, EMOJI_MAP, NO_PENALTY, m)).toBe(true);
    expect(isRepositoryAssignmentDropped('a', assignments, EMOJI_MAP, NO_PENALTY, m)).toBe(false);
  });
});

describe('calculateGrades', () => {
  it('returns numeric and letter grades for raw and final', () => {
    const repos: Repository[] = [
      {
        module: mod({ weight: 100 }),
        assignments: [
          ra({ grades: [{ emoji: 'heart' }], num_late_hours: 2, is_late_override: false }),
        ],
      },
    ];
    const result = calculateGrades(repos, EMOJI_MAP, PENALTY_5, LETTER_GRADES);
    expect(result.rawNumericGrade).toBe(100);
    expect(result.rawLetterGrade).toBe('A');
    expect(result.finalNumericGrade).toBe(90); // 100 - 10
    expect(result.finalLetterGrade).toBe('A');
  });
});
