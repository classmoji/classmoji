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
  gradedItemValue,
  estimateStudentGrade,
  finalStudentGrade,
  type GradedItem,
  type ReleasableGitRepoAssignment,
  type GitRepoAssignment,
  type GitRepo,
  type OrganizationSettings,
} from '../grades.ts';
import { SCORE_EMOJI_MAPPINGS, type LetterGradeMappingEntry } from '../emojis.ts';

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

/** One quiz item. */
const item = (over: Partial<GradedItem> = {}): GradedItem => ({
  assignment_id: 'quiz-asg',
  module_id: 'mod',
  weight: 10,
  is_extra_credit: false,
  grade: null,
  raw_grade: null,
  counts_as_zero: false,
  late_hours: 0,
  counting_raw_percentage: null,
  ...over,
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
    expect(calculateRepositoryGrade([graded('heart', { weight: 0 })], EMOJI_MAP, NO_PENALTY)).toBe(
      -1
    );
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

  it('skips quiz and form assignments in the repo walk: quizzes count only via items', () => {
    const repos = [
      repo([
        graded('heart', { weight: 50, type: 'REPO' }),
        graded('sob', { weight: 50, type: 'QUIZ' }),
        graded('sob', { weight: 50, type: 'FORM' }),
      ]),
    ];
    expect(calculateStudentFinalGrade(repos, EMOJI_MAP, NO_PENALTY)).toBe(100);
    expect(
      calculateStudentFinalGrade(repos, EMOJI_MAP, NO_PENALTY, true, true, [
        item({ weight: 50, grade: 0, raw_grade: 0 }),
      ])
    ).toBe(50);
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

describe('calculateStudentFinalGrade with items', () => {
  const repos = () => [repo([graded('eyes', { weight: 30 })])]; // 80

  it('joins items to the same weighted mean', () => {
    // (80*30 + 90*10) / 40
    expect(
      calculateStudentFinalGrade(repos(), EMOJI_MAP, NO_PENALTY, true, true, [
        item({ weight: 10, grade: 90, raw_grade: 90 }),
      ])
    ).toBe(82.5);
  });

  it('reads grade with the penalty and raw_grade without it', () => {
    const items = [item({ weight: 10, grade: 70, raw_grade: 90 })];
    expect(calculateStudentFinalGrade(repos(), EMOJI_MAP, NO_PENALTY, true, true, items)).toBe(
      77.5
    );
    expect(calculateStudentFinalGrade(repos(), EMOJI_MAP, NO_PENALTY, false, true, items)).toBe(
      82.5
    );
  });

  it('counts_as_zero is a 0 in both modes', () => {
    const items = [item({ weight: 10, grade: null, raw_grade: null, counts_as_zero: true })];
    expect(calculateStudentFinalGrade(repos(), EMOJI_MAP, NO_PENALTY, true, true, items)).toBe(60);
    expect(calculateStudentFinalGrade(repos(), EMOJI_MAP, NO_PENALTY, false, true, items)).toBe(60);
  });

  it('leaves an item with no value out of the denominator', () => {
    const items = [item({ weight: 10, grade: null, raw_grade: null })];
    expect(calculateStudentFinalGrade(repos(), EMOJI_MAP, NO_PENALTY, true, true, items)).toBe(80);
  });

  it('adds extra-credit items on top, and drops them from the raw grade', () => {
    const items = [item({ weight: 5, grade: 100, raw_grade: 100, is_extra_credit: true })];
    expect(calculateStudentFinalGrade(repos(), EMOJI_MAP, NO_PENALTY, true, true, items)).toBe(85);
    expect(calculateStudentFinalGrade(repos(), EMOJI_MAP, NO_PENALTY, false, true, items)).toBe(80);
  });

  it('keeps items when GROUP repositories are skipped', () => {
    const withGroup = [...repos(), repo([graded('sob', { weight: 30 })], 'GROUP')];
    const items = [item({ weight: 30, grade: 100, raw_grade: 100 })];
    expect(calculateStudentFinalGrade(withGroup, EMOJI_MAP, NO_PENALTY, true, false, items)).toBe(
      90
    );
  });

  it('items alone make a grade; no items and no repos is -1', () => {
    expect(
      calculateStudentFinalGrade([], EMOJI_MAP, NO_PENALTY, true, true, [
        item({ weight: 2, grade: 64, raw_grade: 64 }),
      ])
    ).toBe(64);
    expect(calculateStudentFinalGrade([], EMOJI_MAP, NO_PENALTY, true, true, [])).toBe(-1);
  });

  it('an empty items list changes nothing', () => {
    const r = [repo([graded('heart', { weight: 18 }), graded('eyes', { weight: 42 })])];
    expect(calculateStudentFinalGrade(r, EMOJI_MAP, PENALTY_5, true, true, [])).toBe(
      calculateStudentFinalGrade(r, EMOJI_MAP, PENALTY_5)
    );
  });
});

describe('gradedItemValue', () => {
  it('picks grade or raw_grade, 0 for counts_as_zero, null when empty', () => {
    expect(gradedItemValue(item({ grade: 70, raw_grade: 90 }))).toBe(70);
    expect(gradedItemValue(item({ grade: 70, raw_grade: 90 }), false)).toBe(90);
    expect(gradedItemValue(item({ grade: null, raw_grade: null, counts_as_zero: true }))).toBe(0);
    expect(gradedItemValue(item({ grade: null, raw_grade: null }))).toBeNull();
  });
});

describe('calculateGrades', () => {
  it('passes items to both the final and the raw grade', () => {
    const repos = [repo([graded('eyes', { weight: 50 })])];
    const items = [item({ weight: 50, grade: 60, raw_grade: 100 })];
    const result = calculateGrades(repos, EMOJI_MAP, NO_PENALTY, LETTER_GRADES, items);
    expect(result.finalNumericGrade).toBe(70);
    expect(result.finalLetterGrade).toBe('C');
    expect(result.rawNumericGrade).toBe(90);
    expect(result.rawLetterGrade).toBe('A');
  });

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
    expect(calculateStudentFinalGrade(legacy.map(flattenWeights), EMOJI_MAP, PENALTY_5)).toBe(99.8);
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
    expect(calculateStudentFinalGrade(legacy.map(flattenWeights), EMOJI_MAP, NO_PENALTY)).toBe(100);
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

describe('estimateStudentGrade', () => {
  /** A submission whose assignment's grades are (or are not) released. */
  const released = (sub: GitRepoAssignment, isReleased = true): ReleasableGitRepoAssignment => ({
    ...sub,
    assignment: { ...sub.assignment, grades_released: isReleased },
  });

  const base = {
    emojiMappings: EMOJI_MAP,
    settings: NO_PENALTY,
    letterGradeMappings: LETTER_GRADES,
  };

  it('counts released submissions only: unreleased grades and zeros are left out', () => {
    const estimate = estimateStudentGrade({
      ...base,
      submissions: [
        released(graded('eyes', { weight: 50 })),
        released(graded('heart', { weight: 50 }), false),
        released(ra({ weight: 50, should_be_zero: true }), false),
      ],
    });
    expect(estimate).toEqual({ kind: 'letter', letter: 'B', count: 1 });
  });

  it('treats a missing grades_released flag as unreleased', () => {
    expect(estimateStudentGrade({ ...base, submissions: [graded('heart')] })).toBeNull();
  });

  it('counts a released missing-work zero', () => {
    const estimate = estimateStudentGrade({
      ...base,
      submissions: [
        released(graded('heart', { weight: 50 })),
        released(ra({ weight: 50, should_be_zero: true })),
      ],
    });
    expect(estimate).toEqual({ kind: 'letter', letter: 'F', count: 2 });
  });

  it('counts quiz items beside released submissions, as the gradebook does', () => {
    const submissions = [released(graded('eyes', { weight: 50 }))];
    const items = [item({ weight: 50, grade: 100, raw_grade: 100 })];
    const estimate = estimateStudentGrade({ ...base, submissions, items });
    expect(estimate).toEqual({ kind: 'letter', letter: 'A', count: 2 });
    expect(
      calculateStudentFinalGrade([repo(submissions)], EMOJI_MAP, NO_PENALTY, true, true, items)
    ).toBe(90);
  });

  it('applies the late penalty, like the gradebook final', () => {
    const estimate = estimateStudentGrade({
      ...base,
      settings: PENALTY_5,
      submissions: [released(graded('heart', { num_late_hours: 2, is_late_override: false }))],
    });
    expect(estimate).toEqual({ kind: 'letter', letter: 'A', count: 1 });
  });

  it('counts extra credit, and leaves weight-0 and unscored items out of the count', () => {
    const estimate = estimateStudentGrade({
      ...base,
      submissions: [
        released(graded('eyes', { weight: 100 })),
        released(graded('heart', { weight: 5, ec: true })),
        released(graded('heart', { weight: 0 })),
      ],
      items: [
        item({ assignment_id: 'q1', weight: 0, counts_as_zero: true }),
        item({ assignment_id: 'q2', weight: 10 }),
      ],
    });
    // 80 over weight 100 (the weight-0 rows add nothing), plus 100 × 5 / 100 extra credit.
    expect(estimate).toEqual({ kind: 'letter', letter: 'B', count: 2 });
  });

  it('counts a counted-zero quiz item', () => {
    const estimate = estimateStudentGrade({
      ...base,
      submissions: [released(graded('heart', { weight: 50 }))],
      items: [item({ weight: 50, counts_as_zero: true })],
    });
    expect(estimate).toEqual({ kind: 'letter', letter: 'F', count: 2 });
  });

  it('never shows the letter override, which stays with staff until release', () => {
    // EstimateStudentGradeInput has no override: an extra key cannot reach it.
    const input = {
      ...base,
      submissions: [released(graded('sob'))],
      letterOverride: 'A-',
    } as Parameters<typeof estimateStudentGrade>[0];
    expect(estimateStudentGrade(input)).toEqual({ kind: 'letter', letter: 'F', count: 1 });
    expect(
      estimateStudentGrade({ ...base, submissions: [], letterOverride: 'A-' } as Parameters<
        typeof estimateStudentGrade
      >[0])
    ).toBeNull();
  });

  it('shows the letter only, with no percentage', () => {
    const estimate = estimateStudentGrade({
      ...base,
      submissions: [
        released(graded('eyes', { weight: 100 })),
        released(graded('heart', { weight: 1, ec: true })),
      ],
    });
    expect(estimate).toEqual({ kind: 'letter', letter: 'B', count: 2 });
    expect(estimate).not.toHaveProperty('percent');
  });

  it('reads letter bands in descending order whatever order they arrive in', () => {
    const estimate = estimateStudentGrade({
      ...base,
      letterGradeMappings: [...LETTER_GRADES].reverse(),
      submissions: [released(graded('heart'))],
    });
    expect(estimate).toMatchObject({ kind: 'letter', letter: 'A' });
  });

  it('falls back to the nearest emoji without a letter scale', () => {
    const estimate = estimateStudentGrade({
      ...base,
      letterGradeMappings: [],
      submissions: [
        released(graded('heart', { weight: 50 })),
        released(graded('eyes', { weight: 50 })),
      ],
    });
    expect(estimate).toEqual({ kind: 'emoji', emoji: '+1', count: 2 });
  });

  it('uses the score emoji of a numeric scale the same way', () => {
    const scale = Object.fromEntries(SCORE_EMOJI_MAPPINGS.map(m => [m.emoji, m.grade]));
    const estimate = estimateStudentGrade({
      ...base,
      emojiMappings: scale,
      letterGradeMappings: [],
      submissions: [
        released(graded('score-70', { weight: 50 })),
        released(graded('score-90', { weight: 50 })),
      ],
      items: [item({ weight: 100, grade: 84, raw_grade: 84 })],
    });
    // (70·50 + 90·50 + 84·100) / 200 = 82 → 80
    expect(estimate).toEqual({ kind: 'emoji', emoji: 'score-80', count: 3 });
  });

  it('is null when nothing released has a grade', () => {
    expect(estimateStudentGrade({ ...base, submissions: [] })).toBeNull();
    expect(
      estimateStudentGrade({
        ...base,
        submissions: [released(ra()), released(graded('heart'), false)],
        items: [item()],
      })
    ).toBeNull();
  });

  it('is null with no scale at all to show it on', () => {
    expect(
      estimateStudentGrade({
        ...base,
        emojiMappings: {},
        letterGradeMappings: [],
        submissions: [released(ra({ should_be_zero: true }))],
      })
    ).toBeNull();
  });
});

describe('finalStudentGrade', () => {
  /** A submission whose assignment's grades are (or are not) released. */
  const released = (sub: GitRepoAssignment, isReleased = true): ReleasableGitRepoAssignment => ({
    ...sub,
    assignment: { ...sub.assignment, grades_released: isReleased },
  });

  // Released and unreleased work, an individual and a team repo, a late
  // submission, extra credit, a missing-work zero and quiz items.
  const individual = [
    released(graded('heart', { weight: 30 })),
    released(graded('eyes', { weight: 30, num_late_hours: 3, is_late_override: false }), false),
    released(ra({ weight: 10, should_be_zero: true }), false),
    released(graded('+1', { weight: 5, ec: true })),
  ];
  const team = [released(graded('-1', { weight: 20 }), false)];
  const items = [
    item({ assignment_id: 'q1', weight: 10, grade: 72, raw_grade: 80, late_hours: 2 }),
    item({ assignment_id: 'q2', weight: 10, counts_as_zero: true }),
  ];

  // The gradebook's Letter column calls finalStudentGrade itself
  // (GradesTable.tsx), so these pin the semantics both share.
  it('is the letter of the final grade over all graded work, released or not', () => {
    for (const [settings, letter] of [
      [NO_PENALTY, 'C'],
      [PENALTY_5, 'D'],
    ] as const) {
      // The gradebook's total over the same work: team repo, late penalty,
      // missing-work zero, extra credit and quiz items all counted.
      const total = calculateStudentFinalGrade(
        [repo(individual), repo(team, 'GROUP')],
        EMOJI_MAP,
        settings,
        true,
        true,
        items
      );
      expect(calculateLetterGrade(total, LETTER_GRADES)).toBe(letter);
      expect(
        finalStudentGrade({
          submissions: [...individual, ...team],
          items,
          emojiMappings: EMOJI_MAP,
          settings,
          letterGradeMappings: LETTER_GRADES,
        })
      ).toEqual({ kind: 'final', letter });
    }
    // Unreleased work counts: the released-only estimate differs here.
    expect(
      finalStudentGrade({
        submissions: [released(graded('heart')), released(ra({ should_be_zero: true }), false)],
        emojiMappings: EMOJI_MAP,
        settings: NO_PENALTY,
        letterGradeMappings: LETTER_GRADES,
      })
    ).toEqual({ kind: 'final', letter: 'F' });
  });

  it('takes the override over the computed letter', () => {
    const input = {
      submissions: individual,
      items,
      emojiMappings: EMOJI_MAP,
      settings: NO_PENALTY,
      letterGradeMappings: LETTER_GRADES,
    };
    expect(finalStudentGrade(input)).not.toEqual({ kind: 'final', letter: 'A-' });
    expect(finalStudentGrade({ ...input, letterOverride: 'A-' })).toEqual({
      kind: 'final',
      letter: 'A-',
    });
    // Even with nothing graded or no letter scale.
    expect(
      finalStudentGrade({ ...input, submissions: [], items: [], letterOverride: 'C+' })
    ).toEqual({ kind: 'final', letter: 'C+' });
    expect(finalStudentGrade({ ...input, letterGradeMappings: [], letterOverride: 'B' })).toEqual({
      kind: 'final',
      letter: 'B',
    });
  });

  it('is null where the Letter column shows none: no letter scale, or nothing graded', () => {
    const input = { emojiMappings: EMOJI_MAP, settings: NO_PENALTY };
    expect(
      finalStudentGrade({
        ...input,
        submissions: [released(graded('heart'))],
        letterGradeMappings: [],
      })
    ).toBeNull();
    expect(
      finalStudentGrade({
        ...input,
        submissions: [released(ra())],
        items: [item()],
        letterGradeMappings: LETTER_GRADES,
        letterOverride: null,
      })
    ).toBeNull();
  });

  it('reads letter bands in descending order whatever order they arrive in', () => {
    expect(
      finalStudentGrade({
        submissions: [graded('eyes')],
        emojiMappings: EMOJI_MAP,
        settings: NO_PENALTY,
        letterGradeMappings: [...LETTER_GRADES].reverse(),
      })
    ).toEqual({ kind: 'final', letter: 'B' });
  });
});
