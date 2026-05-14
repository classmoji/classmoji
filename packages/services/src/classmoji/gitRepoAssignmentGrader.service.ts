/**
 * GitRepoAssignmentGrader Service (formerly RepositoryIssueGrader)
 *
 * Manages grader assignments to GitRepoAssignments
 */
import getPrisma from '@classmoji/database';
import * as notificationService from './notification.service.ts';

const notifyGraderAssigned = async (repositoryAssignmentId: string, graderIds: string[]) => {
  if (graderIds.length === 0) return;
  await notificationService.runSafely('grader assignment notification', async () => {
    const repoAssignment = await getPrisma().gitRepoAssignment.findUnique({
      where: { id: repositoryAssignmentId },
      select: {
        assignment: { select: { title: true } },
        git_repo: { select: { classroom_id: true, name: true } },
      },
    });
    if (!repoAssignment) return;
    await notificationService.createNotifications({
      type: 'TA_GRADING_ASSIGNED',
      classroomId: repoAssignment.git_repo.classroom_id,
      recipientUserIds: graderIds,
      resourceType: 'git_repo_assignment',
      resourceId: repositoryAssignmentId,
      title: `New grading: ${repoAssignment.assignment.title} - ${repoAssignment.git_repo.name}`,
    });
  });
};

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
  const assignmentGraders = await getPrisma().gitRepoAssignmentGrader.findMany({
    where: {
      git_repo_assignment: {
        git_repo: {
          classroom_id: classroomId,
        },
      },
    },
    include: {
      grader: true,
      git_repo_assignment: {
        include: {
          grades: true,
        },
      },
    },
  });

  const progress: Record<string, GraderProgress> = {};

  assignmentGraders.forEach(graderAssignment => {
    const login = graderAssignment.grader.login;
    if (!login) return;
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

    if (graderAssignment.git_repo_assignment.grades.length > 0) {
      progress[login].completed += 1;
    }

    progress[login].progress = (progress[login].completed / progress[login].total) * 100;
  });

  const sortedProgress = Object.values(progress).sort((a, b) => b.progress - a.progress);

  return sortedProgress;
};

/**
 * Add a grader to a GitRepoAssignment
 * @param {string} repositoryAssignmentId - UUID of the GitRepoAssignment
 * @param {string} graderId - UUID of the grader User
 * @returns {Promise<Object>}
 */
export const addGraderToAssignment = async (repositoryAssignmentId: string, graderId: string) => {
  const created = await getPrisma().gitRepoAssignmentGrader.create({
    data: {
      git_repo_assignment_id: repositoryAssignmentId,
      grader_id: graderId,
    },
  });
  await notifyGraderAssigned(repositoryAssignmentId, [graderId]);
  return created;
};

/**
 * Remove a grader from a GitRepoAssignment
 * @param {string} repositoryAssignmentId - UUID of the GitRepoAssignment
 * @param {string} graderId - UUID of the grader User
 * @returns {Promise<Object>}
 */
export const removeGraderFromAssignment = async (
  repositoryAssignmentId: string,
  graderId: string
) => {
  return getPrisma().gitRepoAssignmentGrader.delete({
    where: {
      git_repo_assignment_id_grader_id: {
        git_repo_assignment_id: repositoryAssignmentId,
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
  return getPrisma().gitRepoAssignmentGrader.findMany({
    where: {
      grader_id: graderId,
      git_repo_assignment: {
        git_repo: {
          classroom_id: classroomId,
        },
      },
    },
    include: {
      git_repo_assignment: {
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
          git_repo: {
            include: {
              repository: true,
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
 * Find all graders for a GitRepoAssignment
 * @param {string} repositoryAssignmentId - UUID of the GitRepoAssignment
 * @returns {Promise<Object[]>}
 */
export const findByAssignmentId = async (repositoryAssignmentId: string) => {
  return getPrisma().gitRepoAssignmentGrader.findMany({
    where: {
      git_repo_assignment_id: repositoryAssignmentId,
    },
    include: {
      grader: true,
    },
  });
};

/**
 * Bulk assign graders to a GitRepoAssignment
 * @param {string} repositoryAssignmentId - UUID of the GitRepoAssignment
 * @param {string[]} graderIds - Array of grader User UUIDs
 * @returns {Promise<{count: number}>}
 */
export const bulkAssignGraders = async (repositoryAssignmentId: string, graderIds: string[]) => {
  const existing = await getPrisma().gitRepoAssignmentGrader.findMany({
    where: { git_repo_assignment_id: repositoryAssignmentId, grader_id: { in: graderIds } },
    select: { grader_id: true },
  });
  const existingIds = new Set(existing.map(g => g.grader_id));
  const newGraderIds = graderIds.filter(id => !existingIds.has(id));

  const result = await getPrisma().gitRepoAssignmentGrader.createMany({
    data: graderIds.map(graderId => ({
      git_repo_assignment_id: repositoryAssignmentId,
      grader_id: graderId,
    })),
    skipDuplicates: true,
  });
  await notifyGraderAssigned(repositoryAssignmentId, newGraderIds);
  return result;
};

/**
 * Remove all graders from a GitRepoAssignment
 * @param {string} repositoryAssignmentId - UUID of the GitRepoAssignment
 * @returns {Promise<{count: number}>}
 */
export const removeAllGraders = async (repositoryAssignmentId: string) => {
  return getPrisma().gitRepoAssignmentGrader.deleteMany({
    where: {
      git_repo_assignment_id: repositoryAssignmentId,
    },
  });
};
