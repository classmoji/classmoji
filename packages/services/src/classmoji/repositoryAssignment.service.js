/**
 * RepositoryAssignment Service (formerly RepositoryIssue)
 *
 * A RepositoryAssignment represents a student's instance of an Assignment.
 * It tracks their progress, grades, and submission status.
 */
import prisma from '@classmoji/database';

/**
 * Find a RepositoryAssignment by ID
 * @param {string} id - UUID of the RepositoryAssignment
 * @returns {Promise<Object|null>}
 */
export const findById = async id => {
  return prisma.repositoryAssignment.findUnique({
    where: { id },
    include: {
      assignment: true,
      repository: true,
      grades: {
        include: {
          grader: true,
        },
      },
      graders: {
        include: {
          grader: true,
        },
      },
    },
  });
};

/**
 * Find a RepositoryAssignment by provider and provider_id
 * Used for webhook lookups
 * @param {string} provider - Git provider (GITHUB, GITLAB, etc.)
 * @param {string} providerId - Provider-specific issue ID
 * @returns {Promise<Object|null>}
 */
export const findByProviderId = async (provider, providerId) => {
  return prisma.repositoryAssignment.findUnique({
    where: {
      provider_provider_id: {
        provider,
        provider_id: providerId,
      },
    },
    include: {
      assignment: {
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
      },
      repository: {
        include: {
          student: true,
          team: true,
        },
      },
      grades: {
        include: {
          grader: true,
        },
      },
    },
  });
};

/**
 * Find RepositoryAssignments by query
 * @param {Object} query - Prisma where clause
 * @returns {Promise<Object|null>}
 */
export const findFirst = async query => {
  return prisma.repositoryAssignment.findFirst({
    where: query,
    include: {
      assignment: true,
      repository: true,
    },
  });
};

/**
 * Find all RepositoryAssignments for a classroom
 * @param {string} classroomId - UUID of the Classroom
 * @returns {Promise<Object[]>}
 */
export const findByClassroomId = async classroomId => {
  return prisma.repositoryAssignment.findMany({
    where: {
      repository: {
        classroom_id: classroomId,
      },
    },
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
  });
};

/**
 * Find all RepositoryAssignments for an Assignment
 * @param {string} assignmentId - UUID of the Assignment
 * @param {string} [classroomSlug] - Optional classroom slug filter
 * @returns {Promise<Object[]>}
 */
export const findByAssignmentId = async (assignmentId, classroomSlug = null) => {
  const where = { assignment_id: assignmentId };

  if (classroomSlug) {
    where.repository = {
      classroom: { slug: classroomSlug },
    };
  }

  return prisma.repositoryAssignment.findMany({
    where,
    include: {
      repository: true,
      graders: {
        include: {
          grader: true,
        },
      },
    },
  });
};

/**
 * Find RepositoryAssignments for a user
 * @param {Object} query - Prisma where clause
 * @returns {Promise<Object[]>}
 */
export const findForUser = async query => {
  return prisma.repositoryAssignment.findMany({
    where: query,
    include: {
      token_transactions: true,
      repository: {
        include: {
          student: true,
          module: true,
          classroom: {
            include: {
              git_organization: true,
            },
          },
        },
      },
      assignment: true,
      graders: {
        include: {
          grader: true,
        },
      },
      grades: {
        include: {
          grader: true,
          token_transaction: true,
        },
      },
    },
    orderBy: {
      assignment: {
        student_deadline: 'desc',
      },
    },
  });
};

/**
 * Create a RepositoryAssignment
 * @param {Object} data - RepositoryAssignment data
 * @returns {Promise<Object>}
 */
export const create = async data => {
  return prisma.repositoryAssignment.create({
    data,
    include: {
      assignment: true,
      repository: true,
    },
  });
};

/**
 * Update a RepositoryAssignment
 * @param {string} id - UUID of the RepositoryAssignment
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>}
 */
export const update = async (id, updates) => {
  return prisma.repositoryAssignment.update({
    where: { id },
    data: updates,
    include: {
      assignment: true,
      repository: true,
    },
  });
};

/**
 * Delete a RepositoryAssignment
 * @param {string} id - UUID of the RepositoryAssignment
 * @returns {Promise<Object>}
 */
export const deleteById = async id => {
  return prisma.repositoryAssignment.delete({
    where: { id },
  });
};

/**
 * Get grading progress for a classroom
 * @param {string} classroomSlug - Classroom slug
 * @returns {Promise<number>} - Percentage graded
 */
export const getGradingProgress = async classroomSlug => {
  let totalNum = await prisma.repositoryAssignment.count({
    where: {
      repository: { classroom: { slug: classroomSlug } },
      assignment: { module: { is_extra_credit: false } },
    },
  });

  // Count submitted extra credit
  const numExtraCredit = await prisma.repositoryAssignment.count({
    where: {
      status: 'CLOSED',
      repository: { classroom: { slug: classroomSlug } },
      assignment: { module: { is_extra_credit: true } },
    },
  });

  totalNum += numExtraCredit;

  let numUngraded = await prisma.repositoryAssignment.count({
    where: {
      repository: { classroom: { slug: classroomSlug } },
      assignment: { module: { is_extra_credit: false } },
      grades: { none: {} },
    },
  });

  // Count ungraded extra credit
  const numExtraCreditUngraded = await prisma.repositoryAssignment.count({
    where: {
      status: 'CLOSED',
      repository: { classroom: { slug: classroomSlug } },
      assignment: { module: { is_extra_credit: true } },
      grades: { none: {} },
    },
  });

  numUngraded += numExtraCreditUngraded;

  if (totalNum === 0) return 0;

  return parseFloat((((totalNum - numUngraded) / totalNum) * 100).toFixed(1));
};

/**
 * Get completion progress for a classroom
 * @param {string} classroomSlug - Classroom slug
 * @returns {Promise<number>} - Percentage completed
 */
export const getCompletionProgress = async classroomSlug => {
  const totalNum = await prisma.repositoryAssignment.count({
    where: {
      repository: { classroom: { slug: classroomSlug } },
      assignment: { module: { is_extra_credit: false } },
    },
  });

  const numCompleted = await prisma.repositoryAssignment.count({
    where: {
      status: 'CLOSED',
      repository: { classroom: { slug: classroomSlug } },
      assignment: { module: { is_extra_credit: false } },
    },
  });

  if (totalNum === 0) return 0;

  return parseFloat(((numCompleted / totalNum) * 100).toFixed(1));
};

/**
 * Get late submission percentage for a classroom
 * @param {string} classroomSlug - Classroom slug
 * @returns {Promise<number>} - Percentage late
 */
export const getLatePercentage = async classroomSlug => {
  const totalNum = await prisma.repositoryAssignment.count({
    where: {
      repository: { classroom: { slug: classroomSlug } },
    },
  });

  const repoAssignments = await prisma.repositoryAssignment.findMany({
    where: {
      repository: { classroom: { slug: classroomSlug } },
    },
    include: {
      assignment: true,
    },
  });

  const numLate = repoAssignments.filter(ra => ra.is_late).length;

  if (totalNum === 0) return 0;

  return parseFloat(((numLate / totalNum) * 100).toFixed(0));
};

/**
 * Find recently closed RepositoryAssignments
 * @param {string} classroomSlug - Classroom slug
 * @param {Date} startDate - Start of date range
 * @param {Date} endDate - End of date range
 * @returns {Promise<Object[]>}
 */
export const findRecentlyClosed = async (classroomSlug, startDate, endDate) => {
  return prisma.repositoryAssignment.findMany({
    where: {
      repository: { classroom: { slug: classroomSlug } },
      status: 'CLOSED',
      closed_at: {
        gte: startDate,
        lte: endDate,
      },
    },
    include: {
      grades: true,
    },
  });
};

/**
 * Close a RepositoryAssignment (mark as submitted)
 * @param {string} id - UUID of the RepositoryAssignment
 * @returns {Promise<Object>}
 */
export const close = async id => {
  return prisma.repositoryAssignment.update({
    where: { id },
    data: {
      status: 'CLOSED',
      closed_at: new Date(),
    },
  });
};

/**
 * Reopen a RepositoryAssignment
 * @param {string} id - UUID of the RepositoryAssignment
 * @returns {Promise<Object>}
 */
export const reopen = async id => {
  return prisma.repositoryAssignment.update({
    where: { id },
    data: {
      status: 'OPEN',
      closed_at: null,
    },
  });
};

/**
 * Override late status
 * @param {string} id - UUID of the RepositoryAssignment
 * @param {boolean} override - Whether to override
 * @returns {Promise<Object>}
 */
export const setLateOverride = async (id, override) => {
  return prisma.repositoryAssignment.update({
    where: { id },
    data: { is_late_override: override },
  });
};

/**
 * Find all RepositoryAssignments for a specific student in a classroom
 * @param {string} studentId - UUID of the student
 * @param {string} classroomSlug - Slug of the classroom
 * @returns {Promise<Object[]>}
 */
export const findAllForStudent = async (studentId, classroomSlug) => {
  return prisma.repositoryAssignment.findMany({
    where: {
      repository: {
        student_id: studentId,
        classroom: { slug: classroomSlug },
      },
    },
    include: {
      token_transactions: true,
      repository: {
        include: {
          student: true,
          module: true,
        },
      },
      assignment: true,
      graders: {
        include: {
          grader: true,
        },
      },
      grades: {
        include: {
          grader: true,
          token_transaction: true,
        },
      },
    },
    orderBy: {
      assignment: {
        student_deadline: 'desc',
      },
    },
  });
};
