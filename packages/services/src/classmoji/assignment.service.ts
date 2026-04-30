/**
 * Assignment Service (formerly Issue)
 *
 * An Assignment represents a specific deadline/branch configuration within a Module.
 * Students work on RepositoryAssignments which track their progress on these Assignments.
 */
import getPrisma from '@classmoji/database';
import { titleToIdentifier } from '@classmoji/utils';
import type { Prisma } from '@prisma/client';
import * as notificationService from './notification.service.ts';

/**
 * Find an Assignment by ID
 * @param {string} id - UUID of the Assignment
 * @returns {Promise<Object|null>}
 */
export const findById = async (id: string) => {
  return getPrisma().assignment.findUnique({
    where: { id },
    include: {
      module: {
        include: {
          classroom: true,
        },
      },
      repository_assignments: true,
    },
  });
};

/**
 * Find an Assignment by module and title
 * @param {string} moduleId - UUID of the Module
 * @param {string} title - Assignment title
 * @returns {Promise<Object|null>}
 */
export const findByModuleAndTitle = async (moduleId: string, title: string) => {
  return getPrisma().assignment.findUnique({
    where: {
      module_id_title: {
        module_id: moduleId,
        title,
      },
    },
    include: {
      module: true,
    },
  });
};

/**
 * Find all Assignments for a module
 * @param {string} moduleId - UUID of the Module
 * @returns {Promise<Object[]>}
 */
export const findByModuleId = async (moduleId: string) => {
  return getPrisma().assignment.findMany({
    where: { module_id: moduleId },
    orderBy: { created_at: 'asc' },
  });
};

/**
 * Find all published Assignments for a module
 * @param {string} moduleId - UUID of the Module
 * @returns {Promise<Object[]>}
 */
export const findPublishedByModuleId = async (moduleId: string) => {
  return getPrisma().assignment.findMany({
    where: {
      module_id: moduleId,
      is_published: true,
    },
    orderBy: { created_at: 'asc' },
  });
};

/**
 * Find all Assignments for a classroom
 * @param {string} classroomId - UUID of the Classroom
 * @param {Object} [query] - Additional query filters
 * @returns {Promise<Object[]>}
 */
export const findByClassroomId = async (
  classroomId: string,
  query: Prisma.AssignmentWhereInput = {}
) => {
  return getPrisma().assignment.findMany({
    where: {
      module: {
        classroom_id: classroomId,
      },
      ...query,
    },
    include: {
      module: true,
    },
    orderBy: { created_at: 'asc' },
  });
};

/**
 * Find Assignments with upcoming deadlines
 * @param {string} classroomId - UUID of the Classroom
 * @param {Date} [afterDate] - Only include assignments after this date
 * @returns {Promise<Object[]>}
 */
export const findUpcoming = async (classroomId: string, afterDate: Date = new Date()) => {
  return getPrisma().assignment.findMany({
    where: {
      module: {
        classroom_id: classroomId,
      },
      is_published: true,
      student_deadline: {
        gte: afterDate,
      },
    },
    include: {
      module: true,
    },
    orderBy: { student_deadline: 'asc' },
  });
};

/**
 * Find Assignments ready for release
 * @param {Date} [beforeDate] - Only include assignments to release before this date
 * @returns {Promise<Object[]>}
 */
export const findReadyForRelease = async (beforeDate: Date = new Date()) => {
  return getPrisma().assignment.findMany({
    where: {
      is_published: false,
      release_at: {
        lte: beforeDate,
      },
    },
    include: {
      module: {
        include: {
          classroom: {
            include: {
              git_organization: true,
            },
          },
        },
      },
    },
  });
};

/**
 * Create an Assignment
 * @param {Object} data - Assignment data
 * @param {string} data.module_id - UUID of the Module
 * @param {string} data.title - Assignment title
 * @param {number} [data.weight] - Weight for grading
 * @param {string} [data.description] - Description
 * @param {Date} [data.student_deadline] - Student deadline
 * @param {Date} [data.grader_deadline] - Grader deadline
 * @param {number} [data.tokens_per_hour] - Tokens per hour for extensions
 * @param {string} [data.branch] - Branch name
 * @param {string} [data.workflow_file] - GitHub Actions workflow file
 * @param {Date} [data.release_at] - Auto-release date
 * @returns {Promise<Object>}
 */
export const create = async (data: Prisma.AssignmentUncheckedCreateInput) => {
  return getPrisma().assignment.create({
    data: {
      ...data,
      slug: titleToIdentifier(data.title),
      weight: Number(data.weight || 100),
    },
    include: {
      module: true,
    },
  });
};

/**
 * Create multiple Assignments
 * @param {Object[]} assignments - Array of assignment data
 * @returns {Promise<{count: number}>}
 */
export const createMany = async (assignments: Prisma.AssignmentUncheckedCreateInput[]) => {
  return getPrisma().assignment.createMany({
    data: assignments.map(a => ({
      ...a,
      slug: titleToIdentifier(a.title),
      weight: Number(a.weight || 100),
    })),
  });
};

/**
 * Update an Assignment
 * @param {string} id - UUID of the Assignment
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>}
 */
export const update = async (id: string, updates: Prisma.AssignmentUpdateInput) => {
  const previous = await getPrisma().assignment.findUnique({
    where: { id },
    select: { student_deadline: true, grades_released: true },
  });

  const updated = await getPrisma().assignment.update({
    where: { id },
    data: updates,
    include: {
      module: true,
    },
  });

  if ('student_deadline' in updates) {
    await notificationService.runSafely('assignment due date notification', async () => {
      const newDeadline = updated.student_deadline?.toISOString() ?? null;
      const oldDeadline = previous?.student_deadline?.toISOString() ?? null;
      if (newDeadline !== oldDeadline) {
        const { studentIds, classroomId } = await notificationService.getStudentsForAssignment(id);
        if (studentIds.length > 0) {
          await notificationService.createNotifications({
            type: 'ASSIGNMENT_DUE_DATE_CHANGED',
            classroomId,
            recipientUserIds: studentIds,
            resourceType: 'assignment',
            resourceId: id,
            title: `Due date changed: ${updated.title}`,
            metadata: { previous_deadline: oldDeadline, new_deadline: newDeadline },
          });
        }
      }
    });
  }

  if (
    'grades_released' in updates &&
    previous &&
    !previous.grades_released &&
    updated.grades_released
  ) {
    await notificationService.runSafely('assignment graded notification', async () => {
      const recipientIds = await getGradedRecipientsForAssignment(id);
      if (recipientIds.length > 0) {
        await notificationService.createNotifications({
          type: 'ASSIGNMENT_GRADED',
          classroomId: updated.module.classroom_id,
          recipientUserIds: recipientIds,
          resourceType: 'assignment',
          resourceId: id,
          title: `Graded: ${updated.title}`,
        });
      }
    });
  }

  return updated;
};

/**
 * Recipients of a grade-release notification: students/team members whose
 * RepositoryAssignment under this assignment has at least one grade row.
 */
const getGradedRecipientsForAssignment = async (assignmentId: string): Promise<string[]> => {
  const repos = await getPrisma().repositoryAssignment.findMany({
    where: { assignment_id: assignmentId, grades: { some: {} } },
    select: {
      repository: {
        select: {
          student_id: true,
          team_id: true,
        },
      },
    },
  });

  const userIds = new Set<string>();
  const teamIds = new Set<string>();
  for (const r of repos) {
    if (r.repository.student_id) userIds.add(r.repository.student_id);
    if (r.repository.team_id) teamIds.add(r.repository.team_id);
  }

  if (teamIds.size > 0) {
    const members = await getPrisma().teamMembership.findMany({
      where: { team_id: { in: [...teamIds] } },
      select: { user_id: true },
    });
    for (const m of members) userIds.add(m.user_id);
  }

  return [...userIds];
};

/**
 * Delete an Assignment
 * @param {string} id - UUID of the Assignment
 * @returns {Promise<Object>}
 */
export const deleteById = async (id: string) => {
  return getPrisma().assignment.delete({
    where: { id },
  });
};

/**
 * Delete multiple Assignments
 * @param {string[]} ids - Array of UUIDs
 * @returns {Promise<{count: number}>}
 */
export const deleteMany = async (ids: string[]) => {
  return getPrisma().assignment.deleteMany({
    where: { id: { in: ids } },
  });
};

/**
 * Publish an Assignment
 * @param {string} id - UUID of the Assignment
 * @returns {Promise<Object>}
 */
export const publish = async (id: string) => {
  return getPrisma().assignment.update({
    where: { id },
    data: { is_published: true },
  });
};

/**
 * Release grades for an Assignment
 * @param {string} id - UUID of the Assignment
 * @returns {Promise<Object>}
 */
export const releaseGrades = async (id: string) => {
  return getPrisma().assignment.update({
    where: { id },
    data: { grades_released: true },
  });
};

/**
 * Get Assignment with grading summary
 * @param {string} id - UUID of the Assignment
 * @returns {Promise<Object>}
 */
export const findWithGradingSummary = async (id: string) => {
  const assignment = await getPrisma().assignment.findUnique({
    where: { id },
    include: {
      module: {
        include: {
          classroom: true,
        },
      },
      repository_assignments: {
        include: {
          grades: true,
          repository: {
            include: {
              student: true,
              team: true,
            },
          },
        },
      },
    },
  });

  if (!assignment) return null;

  const stats = {
    total: assignment.repository_assignments.length,
    graded: 0,
    ungraded: 0,
    open: 0,
    closed: 0,
  };

  for (const ra of assignment.repository_assignments) {
    if (ra.grades.length > 0) {
      stats.graded++;
    } else {
      stats.ungraded++;
    }
    if (ra.status === 'OPEN') {
      stats.open++;
    } else {
      stats.closed++;
    }
  }

  return {
    ...assignment,
    stats,
  };
};
