/**
 * RepositoryAssignment Service (formerly RepositoryIssue)
 *
 * A RepositoryAssignment represents a student's instance of an Assignment.
 * It tracks their progress, grades, and submission status.
 */
import getPrisma from '@classmoji/database';
import type { GitProvider, IssueStatus, Prisma } from '@prisma/client';

interface RepositoryAssignmentCreateData extends Omit<
  Prisma.RepositoryAssignmentUncheckedCreateInput,
  'provider'
> {
  provider: GitProvider | string;
}

interface RepositoryAssignmentUpdateData extends Omit<
  Prisma.RepositoryAssignmentUpdateInput,
  'status'
> {
  status?: IssueStatus | string;
}

/**
 * Find a RepositoryAssignment by ID
 * @param {string} id - UUID of the RepositoryAssignment
 * @returns {Promise<Object|null>}
 */
export const findById = async (id: string) => {
  return getPrisma().repositoryAssignment.findUnique({
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
export const findByProviderId = async (provider: GitProvider, providerId: string) => {
  return getPrisma().repositoryAssignment.findUnique({
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
export const findFirst = async (query: Prisma.RepositoryAssignmentWhereInput) => {
  return getPrisma().repositoryAssignment.findFirst({
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
export const findByClassroomId = async (classroomId: string) => {
  return getPrisma().repositoryAssignment.findMany({
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
export const findByAssignmentId = async (
  assignmentId: string,
  classroomSlug: string | null = null
) => {
  const where: Prisma.RepositoryAssignmentWhereInput = { assignment_id: assignmentId };

  if (classroomSlug) {
    where.repository = {
      classroom: { slug: classroomSlug },
    };
  }

  return getPrisma().repositoryAssignment.findMany({
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
export const findForUser = async (query: Prisma.RepositoryAssignmentWhereInput) => {
  return getPrisma().repositoryAssignment.findMany({
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
export const create = async (data: RepositoryAssignmentCreateData) => {
  return getPrisma().repositoryAssignment.create({
    data: {
      ...data,
      provider: data.provider as GitProvider,
    },
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
export const update = async (id: string, updates: RepositoryAssignmentUpdateData) => {
  const repositoryAssignmentData = {
    ...updates,
    ...(updates.status && { status: updates.status as IssueStatus }),
  } as Prisma.RepositoryAssignmentUncheckedUpdateInput;

  return getPrisma().repositoryAssignment.update({
    where: { id },
    data: repositoryAssignmentData,
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
export const deleteById = async (id: string) => {
  return getPrisma().repositoryAssignment.delete({
    where: { id },
  });
};

/**
 * Get grading progress for a classroom
 * @param {string} classroomSlug - Classroom slug
 * @returns {Promise<number>} - Percentage graded
 */
export const getGradingProgress = async (classroomSlug: string) => {
  let totalNum = await getPrisma().repositoryAssignment.count({
    where: {
      repository: { classroom: { slug: classroomSlug } },
      assignment: { module: { is_extra_credit: false } },
    },
  });

  // Count submitted extra credit
  const numExtraCredit = await getPrisma().repositoryAssignment.count({
    where: {
      status: 'CLOSED',
      repository: { classroom: { slug: classroomSlug } },
      assignment: { module: { is_extra_credit: true } },
    },
  });

  totalNum += numExtraCredit;

  let numUngraded = await getPrisma().repositoryAssignment.count({
    where: {
      repository: { classroom: { slug: classroomSlug } },
      assignment: { module: { is_extra_credit: false } },
      grades: { none: {} },
    },
  });

  // Count ungraded extra credit
  const numExtraCreditUngraded = await getPrisma().repositoryAssignment.count({
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
export const getCompletionProgress = async (classroomSlug: string) => {
  const totalNum = await getPrisma().repositoryAssignment.count({
    where: {
      repository: { classroom: { slug: classroomSlug } },
      assignment: { module: { is_extra_credit: false } },
    },
  });

  const numCompleted = await getPrisma().repositoryAssignment.count({
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
export const getLatePercentage = async (classroomSlug: string) => {
  const totalNum = await getPrisma().repositoryAssignment.count({
    where: {
      repository: { classroom: { slug: classroomSlug } },
    },
  });

  const repoAssignments = await getPrisma().repositoryAssignment.findMany({
    where: {
      repository: { classroom: { slug: classroomSlug } },
    },
    select: {
      closed_at: true,
      is_late_override: true,
      assignment: { select: { student_deadline: true } },
    },
  });

  const numLate = repoAssignments.filter(
    ra =>
      ra.is_late_override ||
      Boolean(
        ra.closed_at &&
        ra.assignment.student_deadline &&
        ra.closed_at > ra.assignment.student_deadline
      )
  ).length;

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
export const findRecentlyClosed = async (classroomSlug: string, startDate: Date, endDate: Date) => {
  return getPrisma().repositoryAssignment.findMany({
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
export const close = async (id: string) => {
  return getPrisma().repositoryAssignment.update({
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
export const reopen = async (id: string) => {
  return getPrisma().repositoryAssignment.update({
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
export const setLateOverride = async (id: string, override: boolean) => {
  return getPrisma().repositoryAssignment.update({
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
export const findAllForStudent = async (studentId: string, classroomSlug: string) => {
  return getPrisma().repositoryAssignment.findMany({
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
