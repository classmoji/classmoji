import type { LetterGradeMappingEntry } from './emojis.ts';

export interface GradeEntry {
  emoji: string;
}

export interface RepositoryAssignment {
  id: string;
  should_be_zero?: boolean;
  grades?: GradeEntry[];
  num_late_hours?: number;
  is_late_override?: boolean;
  assignment: {
    weight: number;
  };
}

export interface Module {
  type?: string;
  weight: number;
  is_extra_credit?: boolean;
  drop_lowest_count?: number;
}

export interface Repository {
  assignments: RepositoryAssignment[];
  module: Module;
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
  repoAssignment: RepositoryAssignment;
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
  repositories: Repository[],
  emojiToNumberMap: Record<string, number>,
  settings: OrganizationSettings,
  includeLatePenalty = true,
  includeGroupAssignment = true
): number => {
  let finalGrade = 0;
  let totalWeight = 0;
  let extraCredit = 0;

  for (const repo of repositories) {
    if (includeGroupAssignment == false && repo.module.type === 'GROUP') continue;

    const repositoryGrade = calculateRepositoryGrade(
      repo.assignments,
      emojiToNumberMap,
      settings,
      repo.module,
      includeLatePenalty
    );

    if (repositoryGrade === -1) continue;

    if (repo.module.is_extra_credit == false) {
      totalWeight += repo.module.weight;
      finalGrade += repositoryGrade * (repo.module.weight / 100);
    } else {
      extraCredit += repositoryGrade * (repo.module.weight / 100);
    }
  }

  if (totalWeight == 0) return -1;

  return (
    Math.round((finalGrade / totalWeight) * 100 * 10) / 10 + (includeLatePenalty ? extraCredit : 0)
  );
};

/**
 * Find the optimal set of repository assignments to keep when dropping N lowest.
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
  repositoryAssignments: RepositoryAssignment[],
  emojiToNumberMap: Record<string, number>,
  settings: OrganizationSettings,
  module: Module,
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

  if (module.is_extra_credit) {
    for (const { numericGrade, weight } of assignmentGrades) {
      grade = grade + numericGrade * (weight / 100);
    }
    return grade;
  }

  const dropCount = module.drop_lowest_count || 0;
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
  if (emojis.length === 0) {
    return 0;
  }

  return (
    emojis.reduce((acc, emoji) => acc + convertEmojiToNumber(emoji, emojiToNumberMap), 0) /
    emojis.length
  );
};

/**
 * Apply late penalty to a numeric grade for a repository assignment.
 * num_late_hours already accounts for extension hours, so no additional
 * adjustment is needed here.
 */
export const applyLatePenalty = (
  numericGrade: number,
  repoAssignment: RepositoryAssignment,
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
  repositories: Repository[],
  emojiMappings: Record<string, number>,
  settings: OrganizationSettings,
  letterGradeMappings: LetterGradeMappingEntry[]
): GradeResult => {
  const finalNumericGrade = calculateStudentFinalGrade(repositories, emojiMappings, settings, true);
  const finalLetterGrade = calculateLetterGrade(finalNumericGrade, letterGradeMappings);
  const rawNumericGrade = calculateStudentFinalGrade(repositories, emojiMappings, settings, false);
  const rawLetterGrade = calculateLetterGrade(rawNumericGrade, letterGradeMappings);

  return {
    finalNumericGrade,
    finalLetterGrade,
    rawNumericGrade,
    rawLetterGrade,
  };
};

/**
 * Get the list of dropped repository assignment IDs for a repository based on drop_lowest_count
 */
export const getDroppedRepositoryAssignments = (
  repositoryAssignments: RepositoryAssignment[],
  emojiToNumberMap: Record<string, number>,
  settings: OrganizationSettings,
  module: Module
): string[] => {
  if (!repositoryAssignments || repositoryAssignments.length === 0) return [];
  if (!module.drop_lowest_count || module.drop_lowest_count === 0) return [];
  if (module.is_extra_credit) return [];

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

  if (assignmentGrades.length <= module.drop_lowest_count) return [];

  const assignmentsToKeep = findOptimalRepositoryAssignmentsToKeep(
    assignmentGrades,
    module.drop_lowest_count
  );
  const keptAssignmentIds = new Set(
    assignmentsToKeep.map(({ repositoryAssignmentId }) => repositoryAssignmentId)
  );

  return assignmentGrades
    .filter(({ repositoryAssignmentId }) => !keptAssignmentIds.has(repositoryAssignmentId))
    .map(({ repositoryAssignmentId }) => repositoryAssignmentId);
};

/**
 * Check if a specific repository assignment is dropped for a repository
 */
export const isRepositoryAssignmentDropped = (
  repositoryAssignmentId: string,
  allRepositoryAssignments: RepositoryAssignment[],
  emojiToNumberMap: Record<string, number>,
  settings: OrganizationSettings,
  module: Module
): boolean => {
  const droppedRepositoryAssignmentIds = getDroppedRepositoryAssignments(
    allRepositoryAssignments,
    emojiToNumberMap,
    settings,
    module
  );
  return droppedRepositoryAssignmentIds.includes(repositoryAssignmentId);
};
