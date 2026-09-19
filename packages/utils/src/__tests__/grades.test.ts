import { describe, it, expect } from 'vitest';
import {
  calculateLetterGrade,
  calculateNumericGrade,
  applyLatePenalty,
  gradeToEmoji,
  calculateAssignmentGrade,
  calculateRepositoryGrade,
  calculateStudentFinalGrade,
  calculateGrades,
  type GitRepoAssignment,
  type GitRepo,
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

let raCounter = 0;

/** One student submission. `weight` / `ec` / `type` land on the assignment. */
const ra = (
  overrides: Partial<Omit<GitRepoAssignment, 'assignment'>> & {
    weight?: number;
    ec?: boolean;
    type?: string;
  } = {}
): GitRepoAssignment => {
  const { weight = 100, ec = false, type, ...rest } = overrides;
  raCounter += 1;
  return {
    id: rest.id ?? `ra-${raCounter}`,
    assignment: { weight, is_extra_credit: ec, ...(type ? { type } : {}) },
    ...rest,
  };
};

const graded = (emoji: string, extra: Parameters<typeof ra>[0] = {}) =>
  ra({ grades: [{ emoji }], ...extra });

const repo = (assignments: GitRepoAssignment[], type = 'INDIVIDUAL'): GitRepo => ({
  repository: { type },
  assignments,
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

  it('ignores emojis not in the scale instead of producing NaN', () => {
    expect(calculateNumericGrade(['heart', 'unknown'], EMOJI_MAP)).toBe(100);
    expect(calculateNumericGrade(['unknown'], EMOJI_MAP)).toBe(0);
  });
});

describe('applyLatePenalty', () => {
  it('subtracts hours * penalty when not overridden', () => {
    const r = ra({ num_late_hours: 2, is_late_override: false });
    expect(applyLatePenalty(100, r, PENALTY_5)).toBe(90);
  });

  it('does not penalize when is_late_override is true', () => {
    const r = ra({ num_late_hours: 2, is_late_override: true });
    expect(applyLatePenalty(100, r, PENALTY_5)).toBe(100);
  });

  it('clamps at zero', () => {
    const r = ra({ num_late_hours: 100, is_late_override: false });
    expect(applyLatePenalty(50, r, PENALTY_5)).toBe(0);
  });

  it('treats undefined num_late_hours as zero', () => {
    expect(applyLatePenalty(80, ra(), PENALTY_5)).toBe(80);
  });
});

describe('gradeToEmoji', () => {
  it('picks the closest emoji by grade', () => {
    expect(gradeToEmoji(95, EMOJI_MAP)).toBe('heart');
    expect(gradeToEmoji(85, EMOJI_MAP)).toBe('+1');
    expect(gradeToEmoji(10, EMOJI_MAP)).toBe('sob');
  });
});

describe('calculateAssignmentGrade', () => {
  it('returns null when the submission has no grade yet', () => {
    expect(calculateAssignmentGrade(ra(), EMOJI_MAP, NO_PENALTY)).toBeNull();
    expect(calculateAssignmentGrade(ra({ grades: [] }), EMOJI_MAP, NO_PENALTY)).toBeNull();
  });

  it('returns a real 0 for should_be_zero', () => {
    expect(calculateAssignmentGrade(ra({ should_be_zero: true }), EMOJI_MAP, NO_PENALTY)).toBe(0);
  });

  it('averages the emoji grades', () => {
    const r = ra({ grades: [{ emoji: 'heart' }, { emoji: 'eyes' }] });
    expect(calculateAssignmentGrade(r, EMOJI_MAP, NO_PENALTY)).toBe(90);
  });

  it('applies the late penalty only when asked', () => {
    const r = graded('heart', { num_late_hours: 2, is_late_override: false });
    expect(calculateAssignmentGrade(r, EMOJI_MAP, PENALTY_5)).toBe(90);
    expect(calculateAssignmentGrade(r, EMOJI_MAP, PENALTY_5, false)).toBe(100);
  });

  it('ignores emojis outside the scale', () => {
    const r = ra({ grades: [{ emoji: 'heart' }, { emoji: 'nope' }] });
    expect(calculateAssignmentGrade(r, EMOJI_MAP, NO_PENALTY)).toBe(100);
  });
});

describe('calculateRepositoryGrade', () => {
  it('returns -1 when no assignments', () => {
    expect(calculateRepositoryGrade([], EMOJI_MAP, NO_PENALTY)).toBe(-1);
  });

  it('returns -1 when nothing is graded', () => {
    expect(calculateRepositoryGrade([ra(), ra()], EMOJI_MAP, NO_PENALTY)).toBe(-1);
  });

  it('treats should_be_zero as 0', () => {
    const grade = calculateRepositoryGrade(
      [graded('heart', { weight: 50 }), ra({ should_be_zero: true, weight: 50 })],
      EMOJI_MAP,
      NO_PENALTY
    );
    expect(grade).toBe(50);
  });

  it('is the weighted mean of the graded submissions', () => {
    const grade = calculateRepositoryGrade(
      [graded('heart', { weight: 50 }), graded('eyes', { weight: 50 }), ra({ weight: 200 })],
      EMOJI_MAP,
      NO_PENALTY
    );
    expect(grade).toBe(90);
  });

  it('returns -1 when the graded weights sum to zero', () => {
    expect(
      calculateRepositoryGrade([graded('heart', { weight: 0 })], EMOJI_MAP, NO_PENALTY)
    ).toBe(-1);
  });

  it('ignores the extra-credit flag for the display grade', () => {
    const grade = calculateRepositoryGrade(
      [graded('heart', { weight: 50 }), graded('eyes', { weight: 50, ec: true })],
      EMOJI_MAP,
      NO_PENALTY
    );
    expect(grade).toBe(90);
  });
});

describe('calculateStudentFinalGrade', () => {
  it('returns -1 when nothing is graded', () => {
    expect(calculateStudentFinalGrade([repo([ra()])], EMOJI_MAP, NO_PENALTY)).toBe(-1);
    expect(calculateStudentFinalGrade([], EMOJI_MAP, NO_PENALTY)).toBe(-1);
  });

  it('weights assignments flat across repositories', () => {
    const grade = calculateStudentFinalGrade(
      [
        repo([graded('heart', { weight: 18 }), graded('eyes', { weight: 42 })]),
        repo([graded('+1', { weight: 40 })]),
      ],
      EMOJI_MAP,
      NO_PENALTY
    );
    // (100*18 + 80*42 + 90*40) / 100
    expect(grade).toBe(87.6);
  });

  it('leaves ungraded assignments out of the denominator', () => {
    const grade = calculateStudentFinalGrade(
      [repo([graded('eyes', { weight: 30 }), ra({ weight: 70 })])],
      EMOJI_MAP,
      NO_PENALTY
    );
    expect(grade).toBe(80);
  });

  it('adds extra credit on top, and drops it from the raw grade', () => {
    const repos = [
      repo([graded('eyes', { weight: 100 })]),
      repo([graded('heart', { weight: 5, ec: true })]),
    ];
    expect(calculateStudentFinalGrade(repos, EMOJI_MAP, NO_PENALTY)).toBe(85);
    expect(calculateStudentFinalGrade(repos, EMOJI_MAP, NO_PENALTY, false)).toBe(80);
  });

  it('skips GROUP repositories when includeGroupAssignment=false', () => {
    const repos = [
      repo([graded('heart', { weight: 50 })]),
      repo([graded('sob', { weight: 50 })], 'GROUP'),
    ];
    expect(calculateStudentFinalGrade(repos, EMOJI_MAP, NO_PENALTY, true, false)).toBe(100);
    expect(calculateStudentFinalGrade(repos, EMOJI_MAP, NO_PENALTY, true, true)).toBe(50);
  });

  it('skips quiz and form assignments (structural only)', () => {
    const repos = [
      repo([
        graded('heart', { weight: 50, type: 'REPO' }),
        graded('sob', { weight: 50, type: 'QUIZ' }),
        graded('sob', { weight: 50, type: 'FORM' }),
      ]),
    ];
    expect(calculateStudentFinalGrade(repos, EMOJI_MAP, NO_PENALTY)).toBe(100);
  });

  it('returns -1 when every graded weight is zero', () => {
    expect(
      calculateStudentFinalGrade([repo([graded('heart', { weight: 0 })])], EMOJI_MAP, NO_PENALTY)
    ).toBe(-1);
  });

  it('does not let an unrecognized emoji NaN-poison the whole final grade', () => {
    const grade = calculateStudentFinalGrade(
      [repo([ra({ grades: [{ emoji: 'nope' }], weight: 50 }), graded('heart', { weight: 50 })])],
      EMOJI_MAP,
      NO_PENALTY
    );
    expect(Number.isFinite(grade)).toBe(true);
    expect(grade).toBe(50);
  });

  it('is scale invariant: weights need not sum to 100', () => {
    const small = [repo([graded('heart', { weight: 1 }), graded('eyes', { weight: 2 })])];
    const large = [repo([graded('heart', { weight: 50 }), graded('eyes', { weight: 100 })])];
    expect(calculateStudentFinalGrade(small, EMOJI_MAP, NO_PENALTY)).toBe(
      calculateStudentFinalGrade(large, EMOJI_MAP, NO_PENALTY)
    );
  });
});

describe('calculateGrades', () => {
  it('returns numeric and letter grades for raw and final', () => {
    const repos = [
      repo([graded('heart', { weight: 50, num_late_hours: 4, is_late_override: false })]),
      repo([graded('eyes', { weight: 50 })]),
    ];
    const result = calculateGrades(repos, EMOJI_MAP, PENALTY_5, LETTER_GRADES);
    expect(result.rawNumericGrade).toBe(90);
    expect(result.rawLetterGrade).toBe('A');
    expect(result.finalNumericGrade).toBe(80);
    expect(result.finalLetterGrade).toBe('B');
  });
});

// ---------------------------------------------------------------------------
// Golden tests: the phase-1 migration flattens the old two-level weighting
// (repository weight across containers, assignment weight within one) into
// per-assignment weights. These prove the SQL arithmetic reproduces the old
// engine's result. `legacy*` below is a verbatim copy of the pre-refactor
// engine minus drop-lowest; `flattenWeights` mirrors the migration's CASE.
// ---------------------------------------------------------------------------

interface LegacyRepository {
  type?: string;
  weight: number;
  is_extra_credit?: boolean;
}

interface LegacyGitRepo {
  assignments: GitRepoAssignment[];
  repository: LegacyRepository;
}

const legacyRepositoryGrade = (
  ras: GitRepoAssignment[],
  map: Record<string, number>,
  settings: OrganizationSettings,
  repository: LegacyRepository,
  includeLatePenalty: boolean
): number => {
  let grade = 0;
  let totalWeight = 0;
  if (!ras || ras.length === 0) return -1;

  const entries: { numericGrade: number; weight: number }[] = [];
  for (const r of ras) {
    let numericGrade = 0;
    if (r.should_be_zero) {
      numericGrade = 0;
    } else if (r.grades && r.grades.length > 0) {
      numericGrade = calculateNumericGrade(
        r.grades.map(({ emoji }) => emoji),
        map
      );
      if (includeLatePenalty) numericGrade = applyLatePenalty(numericGrade, r, settings);
    } else {
      continue;
    }
    entries.push({ numericGrade, weight: r.assignment.weight });
  }

  if (repository.is_extra_credit) {
    for (const { numericGrade, weight } of entries) grade += numericGrade * (weight / 100);
    return grade;
  }

  for (const { numericGrade, weight } of entries) {
    grade += numericGrade * (weight / 100);
    totalWeight += weight;
  }
  if (totalWeight === 0) return -1;
  return Math.round((grade / totalWeight) * 100 * 10) / 10;
};

const legacyStudentFinalGrade = (
  gitRepos: LegacyGitRepo[],
  map: Record<string, number>,
  settings: OrganizationSettings,
  includeLatePenalty = true,
  includeGroupAssignment = true
): number => {
  let finalGrade = 0;
  let totalWeight = 0;
  let extraCredit = 0;

  for (const r of gitRepos) {
    if (includeGroupAssignment == false && r.repository.type === 'GROUP') continue;
    const repositoryGrade = legacyRepositoryGrade(
      r.assignments,
      map,
      settings,
      r.repository,
      includeLatePenalty
    );
    if (repositoryGrade === -1) continue;
    if (r.repository.is_extra_credit == false || r.repository.is_extra_credit === undefined) {
      totalWeight += r.repository.weight;
      finalGrade += repositoryGrade * (r.repository.weight / 100);
    } else {
      extraCredit += repositoryGrade * (r.repository.weight / 100);
    }
  }

  if (totalWeight == 0) return -1;
  const result =
    Math.round((finalGrade / totalWeight) * 100 * 10) / 10 + (includeLatePenalty ? extraCredit : 0);
  return Number.isFinite(result) ? result : -1;
};

/** Mirrors the migration: EC divisor 100; Σ=0 -> 0; else W_r·w/Σw. */
const flattenWeights = (legacy: LegacyGitRepo): GitRepo => {
  const sum = legacy.assignments.reduce((s, a) => s + a.assignment.weight, 0);
  const W = legacy.repository.weight;
  return {
    repository: { type: legacy.repository.type },
    assignments: legacy.assignments.map(a => ({
      ...a,
      assignment: {
        weight: legacy.repository.is_extra_credit
          ? (W * a.assignment.weight) / 100
          : sum === 0
            ? 0
            : (W * a.assignment.weight) / sum,
        is_extra_credit: !!legacy.repository.is_extra_credit,
        type: 'REPO',
      },
    })),
  };
};

const legacyRepo = (
  weight: number,
  assignments: GitRepoAssignment[],
  extra: Partial<LegacyRepository> = {}
): LegacyGitRepo => ({ repository: { type: 'INDIVIDUAL', weight, ...extra }, assignments });

describe('golden: flattened weights reproduce the legacy two-level grade', () => {
  // Three graded repositories (60/25/15) with nested weights, one late
  // submission, plus an extra-credit repository whose assignment weights sum
  // to 200 (exercises the divisor-100 rule).
  const fixture = (): LegacyGitRepo[] => [
    legacyRepo(60, [graded('heart', { weight: 30 }), graded('+1', { weight: 70 })]),
    legacyRepo(25, [graded('heart', { weight: 50 }), graded('eyes', { weight: 50 })]),
    legacyRepo(15, [graded('+1', { weight: 100, num_late_hours: 2, is_late_override: false })]),
    legacyRepo(5, [graded('heart', { weight: 100 }), graded('+1', { weight: 100 })], {
      is_extra_credit: true,
    }),
  ];

  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])('matches with includeLatePenalty=%s includeGroupAssignment=%s', (penalty, group) => {
    const legacy = fixture();
    const expected = legacyStudentFinalGrade(legacy, EMOJI_MAP, PENALTY_5, penalty, group);
    const actual = calculateStudentFinalGrade(
      legacy.map(flattenWeights),
      EMOJI_MAP,
      PENALTY_5,
      penalty,
      group
    );
    expect(actual).toBeCloseTo(expected, 6);
  });

  it('pins the concrete values', () => {
    const legacy = fixture();
    // repos: 93, 90, 80 (late) -> 55.8 + 22.5 + 12 = 90.3; EC: (100+90)*5/100 = 9.5
    expect(calculateStudentFinalGrade(legacy.map(flattenWeights), EMOJI_MAP, PENALTY_5)).toBe(
      99.8
    );
    // raw: late penalty off and extra credit excluded -> 55.8 + 22.5 + 13.5
    expect(
      calculateStudentFinalGrade(legacy.map(flattenWeights), EMOJI_MAP, PENALTY_5, false)
    ).toBe(91.8);
  });

  it('matches when a GROUP repository is skipped', () => {
    const legacy = [
      legacyRepo(70, [graded('heart', { weight: 100 })]),
      legacyRepo(30, [graded('sob', { weight: 100 })], { type: 'GROUP' }),
    ];
    expect(
      calculateStudentFinalGrade(legacy.map(flattenWeights), EMOJI_MAP, NO_PENALTY, true, false)
    ).toBe(legacyStudentFinalGrade(legacy, EMOJI_MAP, NO_PENALTY, true, false));
  });

  it('ignores a repository whose assignment weights sum to zero, like the old engine', () => {
    const legacy = [
      legacyRepo(50, [graded('sob', { weight: 0 }), graded('sob', { weight: 0 })]),
      legacyRepo(50, [graded('heart', { weight: 100 })]),
    ];
    expect(legacyStudentFinalGrade(legacy, EMOJI_MAP, NO_PENALTY)).toBe(100);
    expect(calculateStudentFinalGrade(legacy.map(flattenWeights), EMOJI_MAP, NO_PENALTY)).toBe(
      100
    );
  });

  it('documents the accepted divergence for a partially graded repository', () => {
    // Old engine re-normalised INSIDE the repository, so the one graded
    // assignment stood for the whole 60%. The flat engine only counts the
    // weight that is actually graded. The two converge as grading completes.
    const legacy = [
      legacyRepo(60, [graded('eyes', { weight: 50 }), ra({ weight: 50 })]),
      legacyRepo(40, [graded('heart', { weight: 100 })]),
    ];
    expect(legacyStudentFinalGrade(legacy, EMOJI_MAP, NO_PENALTY)).toBe(88);
    // (80*30 + 100*40) / 70
    expect(calculateStudentFinalGrade(legacy.map(flattenWeights), EMOJI_MAP, NO_PENALTY)).toBe(
      91.4
    );
  });
});
