import type { LetterGradeMappingEntry } from './emojis.ts';

export interface GradeEntry {
  emoji: string;
}

export interface GitRepoAssignment {
  id: string;
  should_be_zero?: boolean;
  grades?: GradeEntry[];
  num_late_hours?: number;
  is_late_override?: boolean;
  assignment: {
    weight: number;
  };
}

export interface Repository {
  type?: string;
  weight: number;
  is_extra_credit?: boolean;
  drop_lowest_count?: number;
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

interface AssignmentGradeEntry {
  repoAssignment: GitRepoAssignment;
  numericGrade: number;
  weight: number;
  repositoryAssignmentId: string;
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

export const calculateStudentFinalGrade = (
  gitRepos: GitRepo[],
  emojiToNumberMap: Record<string, number>,
  settings: OrganizationSettings,
  includeLatePenalty = true,
  includeGroupAssignment = true
): number => {
  let finalGrade = 0;
  let totalWeight = 0;
  let extraCredit = 0;

  for (const repo of gitRepos) {
    if (includeGroupAssignment == false && repo.repository.type === 'GROUP') continue;

    const repositoryGrade = calculateRepositoryGrade(
      repo.assignments,
      emojiToNumberMap,
      settings,
      repo.repository,
      includeLatePenalty
    );

    if (repositoryGrade === -1) continue;

    if (repo.repository.is_extra_credit == false) {
      totalWeight += repo.repository.weight;
      finalGrade += repositoryGrade * (repo.repository.weight / 100);
    } else {
      extraCredit += repositoryGrade * (repo.repository.weight / 100);
    }
  }

  if (totalWeight == 0) return -1;

  const result =
    Math.round((finalGrade / totalWeight) * 100 * 10) / 10 + (includeLatePenalty ? extraCredit : 0);

  // Never hand back a non-finite grade: it serializes to `null` over JSON and
  // renders as a false `F` (NaN >= min_grade is false for every band). Fall
  // back to the same "no computable grade" sentinel used above so callers'
  // existing `< 0` / `>= 0` guards handle it uniformly.
  return Number.isFinite(result) ? result : -1;
};

/**
 * Find the optimal set of gitRepo assignments to keep when dropping N lowest.
 * Tries all possible combinations and returns the set that maximizes the weighted grade.
 */
const findOptimalRepositoryAssignmentsToKeep = (
  repositoryAssignmentGrades: AssignmentGradeEntry[],
  dropCount: number
): AssignmentGradeEntry[] => {
  const n = repositoryAssignmentGrades.length;
  const keepCount = n - dropCount;

  const calculateWeightedGrade = (subset: AssignmentGradeEntry[]): number => {
    let grade = 0;
    let totalWeight = 0;

    for (const { numericGrade, weight } of subset) {
      grade += numericGrade * (weight / 100);
      totalWeight += weight;
    }

    return totalWeight === 0 ? 0 : (grade / totalWeight) * 100;
  };

  const getCombinations = (arr: AssignmentGradeEntry[], k: number): AssignmentGradeEntry[][] => {
    if (k === 0) return [[]];
    if (arr.length === 0) return [];

    const [first, ...rest] = arr;
    const withFirst = getCombinations(rest, k - 1).map(combo => [first, ...combo]);
    const withoutFirst = getCombinations(rest, k);

    return [...withFirst, ...withoutFirst];
  };

  const allCombinations = getCombinations(repositoryAssignmentGrades, keepCount);

  let bestCombination = allCombinations[0];
  let bestGrade = calculateWeightedGrade(bestCombination);

  for (const combination of allCombinations) {
    const grade = calculateWeightedGrade(combination);
    if (grade > bestGrade) {
      bestGrade = grade;
      bestCombination = combination;
    }
  }

  return bestCombination;
};

export const calculateRepositoryGrade = (
  repositoryAssignments: GitRepoAssignment[],
  emojiToNumberMap: Record<string, number>,
  settings: OrganizationSettings,
  repository: Repository,
  includeLatePenalty = true
): number => {
  let grade = 0;
  let totalWeight = 0;

  if (!repositoryAssignments || repositoryAssignments.length === 0) return -1;

  const assignmentGrades: AssignmentGradeEntry[] = [];

  for (const repoAssignment of repositoryAssignments) {
    let numericGrade = 0;
    const weight = repoAssignment.assignment.weight;

    if (repoAssignment.should_be_zero) {
      numericGrade = 0;
    } else if (repoAssignment.grades && repoAssignment.grades.length > 0) {
      const emojis = repoAssignment.grades.map(({ emoji }) => emoji);
      numericGrade = calculateNumericGrade(emojis, emojiToNumberMap);

      if (includeLatePenalty) {
        numericGrade = applyLatePenalty(numericGrade, repoAssignment, settings);
      }
    } else {
      continue;
    }

    assignmentGrades.push({
      repoAssignment,
      numericGrade,
      weight,
      repositoryAssignmentId: repoAssignment.id,
    });
  }

  if (repository.is_extra_credit) {
    for (const { numericGrade, weight } of assignmentGrades) {
      grade = grade + numericGrade * (weight / 100);
    }
    return grade;
  }

  const dropCount = repository.drop_lowest_count || 0;
  let assignmentsToInclude: AssignmentGradeEntry[] = assignmentGrades;

  if (dropCount > 0 && assignmentGrades.length > dropCount) {
    assignmentsToInclude = findOptimalRepositoryAssignmentsToKeep(assignmentGrades, dropCount);
  }

  for (const { numericGrade, weight } of assignmentsToInclude) {
    grade = grade + numericGrade * (weight / 100);
    totalWeight = totalWeight + weight;
  }

  if (totalWeight === 0) return -1;

  return Math.round((grade / totalWeight) * 100 * 10) / 10;
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

/**
 * Get the list of dropped gitRepo assignment IDs for a gitRepo based on drop_lowest_count
 */
export const getDroppedRepositoryAssignments = (
  repositoryAssignments: GitRepoAssignment[],
  emojiToNumberMap: Record<string, number>,
  settings: OrganizationSettings,
  repository: Repository
): string[] => {
  if (!repositoryAssignments || repositoryAssignments.length === 0) return [];
  if (!repository.drop_lowest_count || repository.drop_lowest_count === 0) return [];
  if (repository.is_extra_credit) return [];

  const assignmentGrades: AssignmentGradeEntry[] = [];

  for (const repoAssignment of repositoryAssignments) {
    let numericGrade = 0;

    if (repoAssignment.should_be_zero) {
      numericGrade = 0;
    } else if (repoAssignment.grades && repoAssignment.grades.length > 0) {
      const emojis = repoAssignment.grades.map(({ emoji }) => emoji);
      numericGrade = calculateNumericGrade(emojis, emojiToNumberMap);

      numericGrade = applyLatePenalty(numericGrade, repoAssignment, settings);
    } else {
      continue;
    }

    assignmentGrades.push({
      repoAssignment,
      numericGrade,
      weight: repoAssignment.assignment.weight,
      repositoryAssignmentId: repoAssignment.id,
    });
  }

  if (assignmentGrades.length <= repository.drop_lowest_count) return [];

  const assignmentsToKeep = findOptimalRepositoryAssignmentsToKeep(
    assignmentGrades,
    repository.drop_lowest_count
  );
  const keptAssignmentIds = new Set(
    assignmentsToKeep.map(({ repositoryAssignmentId }) => repositoryAssignmentId)
  );

  return assignmentGrades
    .filter(({ repositoryAssignmentId }) => !keptAssignmentIds.has(repositoryAssignmentId))
    .map(({ repositoryAssignmentId }) => repositoryAssignmentId);
};

/**
 * Check if a specific gitRepo assignment is dropped for a gitRepo
 */
export const isRepositoryAssignmentDropped = (
  repositoryAssignmentId: string,
  allRepositoryAssignments: GitRepoAssignment[],
  emojiToNumberMap: Record<string, number>,
  settings: OrganizationSettings,
  repository: Repository
): boolean => {
  const droppedRepositoryAssignmentIds = getDroppedRepositoryAssignments(
    allRepositoryAssignments,
    emojiToNumberMap,
    settings,
    repository
  );
  return droppedRepositoryAssignmentIds.includes(repositoryAssignmentId);
};
