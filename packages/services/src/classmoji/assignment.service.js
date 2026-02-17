/**
 * Assignment Service (formerly Issue)
 *
 * An Assignment represents a specific deadline/branch configuration within a Module.
 * Students work on RepositoryAssignments which track their progress on these Assignments.
 */
import prisma from '@classmoji/database';
import { titleToIdentifier } from '@classmoji/utils';

/**
 * Find an Assignment by ID
 * @param {string} id - UUID of the Assignment
 * @returns {Promise<Object|null>}
 */
export const findById = async id => {
  return prisma.assignment.findUnique({
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
export const findByModuleAndTitle = async (moduleId, title) => {
  return prisma.assignment.findUnique({
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
export const findByModuleId = async moduleId => {
  return prisma.assignment.findMany({
    where: { module_id: moduleId },
    orderBy: { created_at: 'asc' },
  });
};

/**
 * Find all published Assignments for a module
 * @param {string} moduleId - UUID of the Module
 * @returns {Promise<Object[]>}
 */
export const findPublishedByModuleId = async moduleId => {
  return prisma.assignment.findMany({
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
export const findByClassroomId = async (classroomId, query = {}) => {
  return prisma.assignment.findMany({
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
export const findUpcoming = async (classroomId, afterDate = new Date()) => {
  return prisma.assignment.findMany({
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
export const findReadyForRelease = async (beforeDate = new Date()) => {
  return prisma.assignment.findMany({
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
export const create = async data => {
  return prisma.assignment.create({
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
export const createMany = async assignments => {
  return prisma.assignment.createMany({
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
export const update = async (id, updates) => {
  return prisma.assignment.update({
    where: { id },
    data: updates,
    include: {
      module: true,
    },
  });
};

/**
 * Delete an Assignment
 * @param {string} id - UUID of the Assignment
 * @returns {Promise<Object>}
 */
export const deleteById = async id => {
  return prisma.assignment.delete({
    where: { id },
  });
};

/**
 * Delete multiple Assignments
 * @param {string[]} ids - Array of UUIDs
 * @returns {Promise<{count: number}>}
 */
export const deleteMany = async ids => {
  return prisma.assignment.deleteMany({
    where: { id: { in: ids } },
  });
};

/**
 * Publish an Assignment
 * @param {string} id - UUID of the Assignment
 * @returns {Promise<Object>}
 */
export const publish = async id => {
  return prisma.assignment.update({
    where: { id },
    data: { is_published: true },
  });
};

/**
 * Release grades for an Assignment
 * @param {string} id - UUID of the Assignment
 * @returns {Promise<Object>}
 */
export const releaseGrades = async id => {
  return prisma.assignment.update({
    where: { id },
    data: { grades_released: true },
  });
};

/**
 * Get Assignment with grading summary
 * @param {string} id - UUID of the Assignment
 * @returns {Promise<Object>}
 */
export const findWithGradingSummary = async id => {
  const assignment = await prisma.assignment.findUnique({
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
