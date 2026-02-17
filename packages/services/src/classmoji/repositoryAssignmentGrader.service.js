/**
 * RepositoryAssignmentGrader Service (formerly RepositoryIssueGrader)
 *
 * Manages grader assignments to RepositoryAssignments
 */
import prisma from '@classmoji/database';

/**
 * Find grader progress for a classroom
 * Returns progress stats for each grader (total assigned, completed, percentage)
 * @param {string} classroomId - UUID of the Classroom
 * @returns {Promise<Object[]>}
 */
export const findGradersProgress = async classroomId => {
  const assignmentGraders = await prisma.repositoryAssignmentGrader.findMany({
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

  const progress = {};

  assignmentGraders.forEach(graderAssignment => {
    if (!progress[graderAssignment.grader.login]) {
      progress[graderAssignment.grader.login] = {
        name: graderAssignment.grader.name,
        login: graderAssignment.grader.login,
        id: graderAssignment.grader.id,
        total: 0,
        completed: 0,
        progress: 0,
      };
    }

    progress[graderAssignment.grader.login].total += 1;

    if (graderAssignment.repository_assignment.grades.length > 0) {
      progress[graderAssignment.grader.login].completed += 1;
    }

    progress[graderAssignment.grader.login].progress =
      (progress[graderAssignment.grader.login].completed /
        progress[graderAssignment.grader.login].total) *
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
export const addGraderToAssignment = async (repositoryAssignmentId, graderId) => {
  return prisma.repositoryAssignmentGrader.create({
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
export const removeGraderFromAssignment = async (repositoryAssignmentId, graderId) => {
  return prisma.repositoryAssignmentGrader.delete({
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
export const findAssignedByGrader = async (graderId, classroomId) => {
  return prisma.repositoryAssignmentGrader.findMany({
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
export const findByAssignmentId = async repositoryAssignmentId => {
  return prisma.repositoryAssignmentGrader.findMany({
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
export const bulkAssignGraders = async (repositoryAssignmentId, graderIds) => {
  return prisma.repositoryAssignmentGrader.createMany({
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
export const removeAllGraders = async repositoryAssignmentId => {
  return prisma.repositoryAssignmentGrader.deleteMany({
    where: {
      repository_assignment_id: repositoryAssignmentId,
    },
  });
};
