export const calculateLetterGrade = (numericGrade, letterGradeMapping) => {
  for (const grade of letterGradeMapping) {
    if (numericGrade >= grade.min_grade) {
      return grade.letter_grade;
    }
  }

  return 'F'; // Default case if the grade is too low
};

export const calculateStudentFinalGrade = (
  repositories,
  emojiToNumberMap,
  settings,
  includeLatePenalty = true,
  includeGroupAssignment = true
) => {
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

    // Only add the weight to the total weight if the module is not extra credit
    if (repo.module.is_extra_credit == false) {
      totalWeight += repo.module.weight;
      finalGrade += repositoryGrade * (repo.module.weight / 100);
    } else {
      extraCredit += repositoryGrade * (repo.module.weight / 100);
    }
  }

  if (totalWeight == 0) return -1;

  // Extra credit is added to the final grade after the total weight is calculated
  return (
    Math.round((finalGrade / totalWeight) * 100 * 10) / 10 + (includeLatePenalty ? extraCredit : 0)
  );
};

/**
 * Find the optimal set of repository assignments to keep when dropping N lowest.
 * Tries all possible combinations and returns the set that maximizes the weighted grade.
 *
 * @param {Array} repositoryAssignmentGrades - Array of {numericGrade, weight, repoAssignment, repositoryAssignmentId}
 * @param {number} dropCount - Number of repository assignments to drop
 * @returns {Array} - The optimal subset of repository assignments to include in grade calculation
 */
const findOptimalRepositoryAssignmentsToKeep = (repositoryAssignmentGrades, dropCount) => {
  const n = repositoryAssignmentGrades.length;
  const keepCount = n - dropCount;

  // Helper to calculate weighted grade for a subset
  const calculateWeightedGrade = subset => {
    let grade = 0;
    let totalWeight = 0;

    for (const { numericGrade, weight } of subset) {
      grade += numericGrade * (weight / 100);
      totalWeight += weight;
    }

    return totalWeight === 0 ? 0 : (grade / totalWeight) * 100;
  };

  // Generate all combinations of keepCount repository assignments from repositoryAssignmentGrades
  const getCombinations = (arr, k) => {
    if (k === 0) return [[]];
    if (arr.length === 0) return [];

    const [first, ...rest] = arr;
    const withFirst = getCombinations(rest, k - 1).map(combo => [first, ...combo]);
    const withoutFirst = getCombinations(rest, k);

    return [...withFirst, ...withoutFirst];
  };

  const allCombinations = getCombinations(repositoryAssignmentGrades, keepCount);

  // Find the combination with the highest weighted grade
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
  repositoryAssignments,
  emojiToNumberMap,
  settings,
  module,
  includeLatePenalty = true
) => {
  let grade = 0;
  let totalWeight = 0;

  if (!repositoryAssignments || repositoryAssignments.length === 0) return -1;

  // Calculate grades for all assignments first
  const assignmentGrades = [];

  for (const repoAssignment of repositoryAssignments) {
    let numericGrade = 0;
    let weight = repoAssignment.assignment.weight;

    if (repoAssignment.should_be_zero) {
      numericGrade = 0;
    } else if (repoAssignment.grades && repoAssignment.grades.length > 0) {
      const emojis = repoAssignment.grades.map(({ emoji }) => emoji);
      numericGrade = calculateNumericGrade(emojis, emojiToNumberMap);

      // Deduct points for late submissions unless late override is used
      if (includeLatePenalty && repoAssignment.num_late_hours > 0 && repoAssignment.is_late_override == false) {
        const latePenalty =
          (repoAssignment.num_late_hours + repoAssignment.extension_hours) * settings.late_penalty_points_per_hour;

        numericGrade = numericGrade - latePenalty;
      }

      // When grade is negative, set to 0
      if (numericGrade < 0) numericGrade = 0;
    } else {
      // No grades yet, skip this assignment
      continue;
    }

    assignmentGrades.push({
      repoAssignment,
      numericGrade,
      weight,
      repositoryAssignmentId: repoAssignment.id,
    });
  }

  // Handle extra credit separately (no dropping)
  if (module.is_extra_credit) {
    for (const { numericGrade, weight } of assignmentGrades) {
      grade = grade + numericGrade * (weight / 100);
    }
    return grade;
  }

  // Apply drop lowest logic if configured
  const dropCount = module.drop_lowest_count || 0;
  let assignmentsToInclude = assignmentGrades;

  if (dropCount > 0 && assignmentGrades.length > dropCount) {
    // Find the optimal set of assignments to drop by trying all combinations
    assignmentsToInclude = findOptimalRepositoryAssignmentsToKeep(assignmentGrades, dropCount);
  }

  // Calculate final grade from remaining assignments
  for (const { numericGrade, weight } of assignmentsToInclude) {
    grade = grade + numericGrade * (weight / 100);
    totalWeight = totalWeight + weight;
  }

  // if no weight, return 0.
  if (totalWeight === 0) return -1;

  return Math.round((grade / totalWeight) * 100 * 10) / 10;
};

// Example: emojis = ['ROCKET', 'HEART', 'THUMBS_UP']
export const calculateNumericGrade = (emojis, emojiToNumberMap) => {
  if (emojis.length === 0) {
    return 0;
  }

  return (
    emojis.reduce((acc, emoji) => acc + convertEmojiToNumber(emoji, emojiToNumberMap), 0) /
    emojis.length
  );
};
// convert a numeric grade to an emoji. Used CHATGPT to generate this lol .
export const gradeToEmoji = (score, emojiGrades) => {
  return Object.entries(emojiGrades).reduce((closest, [emoji, value]) => {
    const currentDiff = Math.abs(score - value);
    const closestDiff = Math.abs(score - emojiGrades[closest]);
    return currentDiff < closestDiff ? emoji : closest;
  }, Object.keys(emojiGrades)[0]);
};

// Example: emoji = 'ROCKET'
export const convertEmojiToNumber = (emoji, emojiToNumberMap) => {
  return emojiToNumberMap[emoji];
};

export const calculateGrades = (repositories, emojiMappings, settings, letterGradeMappings) => {
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
 * Returns an array of RepositoryAssignment IDs that were dropped from grade calculation
 */
export const getDroppedRepositoryAssignments = (repositoryAssignments, emojiToNumberMap, settings, module) => {
  if (!repositoryAssignments || repositoryAssignments.length === 0) return [];
  if (!module.drop_lowest_count || module.drop_lowest_count === 0) return [];
  if (module.is_extra_credit) return [];

  // Calculate grades for all repository assignments
  const assignmentGrades = [];

  for (const repoAssignment of repositoryAssignments) {
    let numericGrade = 0;

    if (repoAssignment.should_be_zero) {
      numericGrade = 0;
    } else if (repoAssignment.grades && repoAssignment.grades.length > 0) {
      const emojis = repoAssignment.grades.map(({ emoji }) => emoji);
      numericGrade = calculateNumericGrade(emojis, emojiToNumberMap);

      // Deduct points for late submissions
      if (repoAssignment.num_late_hours > 0 && repoAssignment.is_late_override == false) {
        const latePenalty =
          (repoAssignment.num_late_hours + repoAssignment.extension_hours) * settings.late_penalty_points_per_hour;
        numericGrade = numericGrade - latePenalty;
      }

      if (numericGrade < 0) numericGrade = 0;
    } else {
      // No grades yet, skip
      continue;
    }

    assignmentGrades.push({
      repositoryAssignmentId: repoAssignment.id,
      numericGrade,
      weight: repoAssignment.assignment.weight,
    });
  }

  if (assignmentGrades.length <= module.drop_lowest_count) return [];

  // Find the optimal set to keep (which maximizes the grade)
  const assignmentsToKeep = findOptimalRepositoryAssignmentsToKeep(assignmentGrades, module.drop_lowest_count);
  const keptAssignmentIds = new Set(assignmentsToKeep.map(({ repositoryAssignmentId }) => repositoryAssignmentId));

  // Return the repository assignment IDs that were NOT kept (i.e., the dropped ones)
  return assignmentGrades
    .filter(({ repositoryAssignmentId }) => !keptAssignmentIds.has(repositoryAssignmentId))
    .map(({ repositoryAssignmentId }) => repositoryAssignmentId);
};

/**
 * Check if a specific repository assignment is dropped for a repository
 * @param {string} repositoryAssignmentId - The ID of the repository assignment to check
 * @param {Array} allRepositoryAssignments - All repository assignments for the repository
 * @param {Object} emojiToNumberMap - Emoji to number mapping
 * @param {Object} settings - Organization settings
 * @param {Object} module - Module configuration
 * @returns {boolean} - True if the repository assignment is dropped, false otherwise
 */
export const isRepositoryAssignmentDropped = (repositoryAssignmentId, allRepositoryAssignments, emojiToNumberMap, settings, module) => {
  const droppedRepositoryAssignmentIds = getDroppedRepositoryAssignments(allRepositoryAssignments, emojiToNumberMap, settings, module);
  return droppedRepositoryAssignmentIds.includes(repositoryAssignmentId);
};
