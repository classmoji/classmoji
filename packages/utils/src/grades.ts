import type { LetterGradeMappingEntry } from './emojis.ts';

export interface GradeEntry {
  emoji: string;
}

/**
 * The Assignment fields the engine reads. `weight` is the only grading
 * weight in the system: the course grade is a weighted mean over graded,
 * non-extra-credit assignments, plus extra credit on top. Weights need not
 * sum to 100.
 */
export interface AssignmentWeighting {
  weight: number;
  is_extra_credit?: boolean;
  /** REPO | QUIZ | FORM. Only REPO submissions carry grades today. */
  type?: string;
}

export interface GitRepoAssignment {
  id: string;
  should_be_zero?: boolean;
  grades?: GradeEntry[];
  num_late_hours?: number;
  is_late_override?: boolean;
  assignment: AssignmentWeighting;
}

/** Only what the engine still needs from a Repository. */
export interface Repository {
  type?: string;
}

export interface GitRepo {
  assignments: GitRepoAssignment[];
  repository: Repository;
}

export interface OrganizationSettings {
  late_penalty_points_per_hour: number;
}

export interface GradeResult {
  finalNumericGrade: number;
  finalLetterGrade: string;
  rawNumericGrade: number;
  rawLetterGrade: string;
}

export const calculateLetterGrade = (
  numericGrade: number,
  letterGradeMapping: LetterGradeMappingEntry[]
): string => {
  for (const grade of letterGradeMapping) {
    if (numericGrade >= grade.min_grade) {
      return grade.letter_grade;
    }
  }

  return 'F';
};

/** Quiz and form assignments produce no grade yet; only REPO submissions count. */
const isGradable = (repoAssignment: GitRepoAssignment): boolean =>
  !repoAssignment.assignment.type || repoAssignment.assignment.type === 'REPO';

/**
 * Numeric grade for one student submission, or null when it has no grade yet.
 * `should_be_zero` (deadline passed, never submitted) is a real 0, not null.
 */
export const calculateAssignmentGrade = (
  repoAssignment: GitRepoAssignment,
  emojiToNumberMap: Record<string, number>,
  settings: OrganizationSettings,
  includeLatePenalty = true
): number | null => {
  if (repoAssignment.should_be_zero) return 0;
  if (!repoAssignment.grades || repoAssignment.grades.length === 0) return null;

  const emojis = repoAssignment.grades.map(({ emoji }) => emoji);
  const numericGrade = calculateNumericGrade(emojis, emojiToNumberMap);

  return includeLatePenalty
    ? applyLatePenalty(numericGrade, repoAssignment, settings)
    : numericGrade;
};

/**
 * Course grade: Σ g·w / Σ w over graded non-extra-credit submissions
 * (rounded to 0.1), plus Σ g·w/100 over graded extra-credit submissions.
 * Ungraded submissions are left out of the denominator entirely.
 * -1 when nothing is gradable.
 */
export const calculateStudentFinalGrade = (
  gitRepos: GitRepo[],
  emojiToNumberMap: Record<string, number>,
  settings: OrganizationSettings,
  includeLatePenalty = true,
  includeGroupAssignment = true
): number => {
  let weighted = 0;
  let totalWeight = 0;
  let extraCredit = 0;

  for (const repo of gitRepos) {
    if (includeGroupAssignment == false && repo.repository?.type === 'GROUP') continue;

    for (const repoAssignment of repo.assignments ?? []) {
      if (!isGradable(repoAssignment)) continue;

      const grade = calculateAssignmentGrade(
        repoAssignment,
        emojiToNumberMap,
        settings,
        includeLatePenalty
      );
      if (grade === null) continue;

      const weight = repoAssignment.assignment.weight ?? 0;
      if (repoAssignment.assignment.is_extra_credit) {
        extraCredit += (grade * weight) / 100;
      } else {
        weighted += grade * weight;
        totalWeight += weight;
      }
    }
  }

  if (totalWeight == 0) return -1;

  // The raw (no-penalty) grade has always excluded extra credit; keep that.
  const result =
    Math.round((weighted / totalWeight) * 10) / 10 + (includeLatePenalty ? extraCredit : 0);

  // Never hand back a non-finite grade: it serializes to `null` over JSON and
  // renders as a false `F` (NaN >= min_grade is false for every band). Fall
  // back to the same "no computable grade" sentinel used above so callers'
  // existing `< 0` / `>= 0` guards handle it uniformly.
  return Number.isFinite(result) ? result : -1;
};

/**
 * Display-only weighted mean of the graded submissions in one git repo. The
 * extra-credit flag is ignored here; it only matters for the course grade.
 * -1 when nothing in the repo is graded or the graded weights sum to 0.
 */
export const calculateRepositoryGrade = (
  repositoryAssignments: GitRepoAssignment[],
  emojiToNumberMap: Record<string, number>,
  settings: OrganizationSettings,
  includeLatePenalty = true
): number => {
  if (!repositoryAssignments || repositoryAssignments.length === 0) return -1;

  let weighted = 0;
  let totalWeight = 0;

  for (const repoAssignment of repositoryAssignments) {
    if (!isGradable(repoAssignment)) continue;

    const grade = calculateAssignmentGrade(
      repoAssignment,
      emojiToNumberMap,
      settings,
      includeLatePenalty
    );
    if (grade === null) continue;

    const weight = repoAssignment.assignment.weight ?? 0;
    weighted += grade * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return -1;

  const result = Math.round((weighted / totalWeight) * 10) / 10;
  return Number.isFinite(result) ? result : -1;
};

export const calculateNumericGrade = (
  emojis: string[],
  emojiToNumberMap: Record<string, number>
): number => {
  // Ignore emojis that don't resolve to a finite value in this classroom's
  // scale rather than letting a single unrecognized emoji turn the whole
  // average (and, downstream, the student's entire final grade) into NaN.
  const values = emojis
    .map(emoji => convertEmojiToNumber(emoji, emojiToNumberMap))
    .filter((value): value is number => Number.isFinite(value));

  if (values.length === 0) {
    return 0;
  }

  return values.reduce((acc, value) => acc + value, 0) / values.length;
};

/**
 * Apply late penalty to a numeric grade for a gitRepo assignment.
 * num_late_hours already accounts for extension hours, so no additional
 * adjustment is needed here.
 */
export const applyLatePenalty = (
  numericGrade: number,
  repoAssignment: GitRepoAssignment,
  settings: OrganizationSettings
): number => {
  if ((repoAssignment.num_late_hours ?? 0) > 0 && repoAssignment.is_late_override == false) {
    const latePenalty =
      (repoAssignment.num_late_hours ?? 0) * settings.late_penalty_points_per_hour;
    return Math.max(0, numericGrade - latePenalty);
  }
  return numericGrade;
};

// convert a numeric grade to an emoji
export const gradeToEmoji = (score: number, emojiGrades: Record<string, number>): string => {
  return Object.entries(emojiGrades).reduce((closest, [emoji, value]) => {
    const currentDiff = Math.abs(score - value);
    const closestDiff = Math.abs(score - emojiGrades[closest]);
    return currentDiff < closestDiff ? emoji : closest;
  }, Object.keys(emojiGrades)[0]);
};

export const convertEmojiToNumber = (
  emoji: string,
  emojiToNumberMap: Record<string, number>
): number => {
  return emojiToNumberMap[emoji];
};

export const calculateGrades = (
  gitRepos: GitRepo[],
  emojiMappings: Record<string, number>,
  settings: OrganizationSettings,
  letterGradeMappings: LetterGradeMappingEntry[]
): GradeResult => {
  const finalNumericGrade = calculateStudentFinalGrade(gitRepos, emojiMappings, settings, true);
  const finalLetterGrade = calculateLetterGrade(finalNumericGrade, letterGradeMappings);
  const rawNumericGrade = calculateStudentFinalGrade(gitRepos, emojiMappings, settings, false);
  const rawLetterGrade = calculateLetterGrade(rawNumericGrade, letterGradeMappings);

  return {
    finalNumericGrade,
    finalLetterGrade,
    rawNumericGrade,
    rawLetterGrade,
  };
};
