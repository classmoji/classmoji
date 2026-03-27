/**
 * RepositoryAssignmentGrader Service (formerly RepositoryIssueGrader)
 *
 * Manages grader assignments to RepositoryAssignments
 */
import getPrisma from '@classmoji/database';

interface GraderProgress {
  name: string | null;
  login: string | null;
  id: string;
  total: number;
  completed: number;
  progress: number;
}

/**
 * Find grader progress for a classroom
 * Returns progress stats for each grader (total assigned, completed, percentage)
 * @param {string} classroomId - UUID of the Classroom
 * @returns {Promise<Object[]>}
 */
export const findGradersProgress = async (classroomId: string) => {
  const assignmentGraders = await getPrisma().repositoryAssignmentGrader.findMany({
    where: {
      repository_assignment: {
        repository: {
          classroom_id: classroomId,
        },
      },
    },
    include: {
      grader: true,
      repository_assignment: {
        include: {
          grades: true,
        },
      },
    },
  });

  const progress: Record<string, GraderProgress> = {};

  assignmentGraders.forEach(graderAssignment => {
    const login = graderAssignment.grader.login!;
    if (!progress[login]) {
      progress[login] = {
        name: graderAssignment.grader.name,
        login: graderAssignment.grader.login,
        id: graderAssignment.grader.id,
        total: 0,
        completed: 0,
        progress: 0,
      };
    }

    progress[login].total += 1;

    if (graderAssignment.repository_assignment.grades.length > 0) {
      progress[login].completed += 1;
    }

    progress[login].progress =
      (progress[login].completed /
        progress[login].total) *
      100;
  });

  const sortedProgress = Object.values(progress).sort((a, b) => b.progress - a.progress);

  return sortedProgress;
};

/**
 * Add a grader to a RepositoryAssignment
 * @param {string} repositoryAssignmentId - UUID of the RepositoryAssignment
 * @param {string} graderId - UUID of the grader User
 * @returns {Promise<Object>}
 */
export const addGraderToAssignment = async (repositoryAssignmentId: string, graderId: string) => {
  return getPrisma().repositoryAssignmentGrader.create({
    data: {
      repository_assignment_id: repositoryAssignmentId,
      grader_id: graderId,
    },
  });
};

/**
 * Remove a grader from a RepositoryAssignment
 * @param {string} repositoryAssignmentId - UUID of the RepositoryAssignment
 * @param {string} graderId - UUID of the grader User
 * @returns {Promise<Object>}
 */
export const removeGraderFromAssignment = async (repositoryAssignmentId: string, graderId: string) => {
  return getPrisma().repositoryAssignmentGrader.delete({
    where: {
      repository_assignment_id_grader_id: {
        repository_assignment_id: repositoryAssignmentId,
        grader_id: graderId,
      },
    },
  });
};

/**
 * Find all assignments for a grader in a classroom
 * @param {string} graderId - UUID of the grader User
 * @param {string} classroomId - UUID of the Classroom
 * @returns {Promise<Object[]>}
 */
export const findAssignedByGrader = async (graderId: string, classroomId: string) => {
  return getPrisma().repositoryAssignmentGrader.findMany({
    where: {
      grader_id: graderId,
      repository_assignment: {
        repository: {
          classroom_id: classroomId,
        },
      },
    },
    include: {
      repository_assignment: {
        include: {
          assignment: true,
          grades: {
            include: {
              token_transaction: true,
              grader: true,
            },
          },
          graders: {
            include: {
              grader: true,
            },
          },
          repository: {
            include: {
              module: true,
              student: true,
              team: true,
            },
          },
        },
      },
    },
  });
};

/**
 * Find all graders for a RepositoryAssignment
 * @param {string} repositoryAssignmentId - UUID of the RepositoryAssignment
 * @returns {Promise<Object[]>}
 */
export const findByAssignmentId = async (repositoryAssignmentId: string) => {
  return getPrisma().repositoryAssignmentGrader.findMany({
    where: {
      repository_assignment_id: repositoryAssignmentId,
    },
    include: {
      grader: true,
    },
  });
};

/**
 * Bulk assign graders to a RepositoryAssignment
 * @param {string} repositoryAssignmentId - UUID of the RepositoryAssignment
 * @param {string[]} graderIds - Array of grader User UUIDs
 * @returns {Promise<{count: number}>}
 */
export const bulkAssignGraders = async (repositoryAssignmentId: string, graderIds: string[]) => {
  return getPrisma().repositoryAssignmentGrader.createMany({
    data: graderIds.map(graderId => ({
      repository_assignment_id: repositoryAssignmentId,
      grader_id: graderId,
    })),
    skipDuplicates: true,
  });
};

/**
 * Remove all graders from a RepositoryAssignment
 * @param {string} repositoryAssignmentId - UUID of the RepositoryAssignment
 * @returns {Promise<{count: number}>}
 */
export const removeAllGraders = async (repositoryAssignmentId: string) => {
  return getPrisma().repositoryAssignmentGrader.deleteMany({
    where: {
      repository_assignment_id: repositoryAssignmentId,
    },
  });
};
