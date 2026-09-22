/**
 * GitRepoAssignment Service (formerly RepositoryIssue)
 *
 * A GitRepoAssignment represents a student's instance of an Assignment.
 * It tracks their progress, grades, and submission status.
 */
import getPrisma from '@classmoji/database';
import type { GitProvider, IssueStatus, Prisma } from '@prisma/client';
import { getGitProvider } from '../git/index.ts';

interface GitRepoAssignmentCreateData extends Omit<
  Prisma.GitRepoAssignmentUncheckedCreateInput,
  'provider'
> {
  provider: GitProvider | string;
}

interface GitRepoAssignmentUpdateData extends Omit<Prisma.GitRepoAssignmentUpdateInput, 'status'> {
  status?: IssueStatus | string;
}

/**
 * Find a GitRepoAssignment by ID
 * @param {string} id - UUID of the GitRepoAssignment
 * @returns {Promise<Object|null>}
 */
export const findById = async (id: string) => {
  return getPrisma().gitRepoAssignment.findUnique({
    where: { id },
    include: {
      assignment: true,
      git_repo: true,
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
 * Find a GitRepoAssignment by provider and provider_id
 * Used for webhook lookups
 * @param {string} provider - Git provider (GITHUB, GITLAB, etc.)
 * @param {string} providerId - Provider-specific issue ID
 * @returns {Promise<Object|null>}
 */
export const findByProviderId = async (provider: GitProvider, providerId: string) => {
  return getPrisma().gitRepoAssignment.findUnique({
    where: {
      provider_provider_id: {
        provider,
        provider_id: providerId,
      },
    },
    include: {
      assignment: {
        include: {
          repository: {
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
      git_repo: {
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
 * Find GitRepoAssignments by query
 * @param {Object} query - Prisma where clause
 * @returns {Promise<Object|null>}
 */
export const findFirst = async (query: Prisma.GitRepoAssignmentWhereInput) => {
  return getPrisma().gitRepoAssignment.findFirst({
    where: query,
    include: {
      assignment: true,
      git_repo: true,
    },
  });
};

/**
 * Find all GitRepoAssignments for a classroom
 * @param {string} classroomId - UUID of the Classroom
 * @returns {Promise<Object[]>}
 */
export const findByClassroomId = async (classroomId: string) => {
  return getPrisma().gitRepoAssignment.findMany({
    where: {
      git_repo: {
        classroom_id: classroomId,
      },
    },
    include: {
      assignment: true,
      // Commit count for the repository column, as of the last refresh.
      analytics_snapshot: { select: { total_commits: true, last_commit_at: true, fetched_at: true } },
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
  });
};

/**
 * Find all GitRepoAssignments for an Assignment
 * @param {string} assignmentId - UUID of the Assignment
 * @param {string} [classroomSlug] - Optional classroom slug filter
 * @param {string} [classroomId] - Optional classroom id filter. Preferred by
 *   callers that already hold the id: it scopes on the primary key rather than
 *   on a slug, and combines with the slug filter when both are supplied.
 * @returns {Promise<Object[]>}
 */
export const findByAssignmentId = async (
  assignmentId: string,
  classroomSlug: string | null = null,
  classroomId: string | null = null
) => {
  const where: Prisma.GitRepoAssignmentWhereInput = { assignment_id: assignmentId };

  if (classroomSlug || classroomId) {
    where.git_repo = {
      ...(classroomSlug ? { classroom: { slug: classroomSlug } } : {}),
      ...(classroomId ? { classroom_id: classroomId } : {}),
    };
  }

  return getPrisma().gitRepoAssignment.findMany({
    where,
    include: {
      git_repo: true,
      graders: {
        include: {
          grader: true,
        },
      },
    },
  });
};

/**
 * Find GitRepoAssignments for a user
 * @param {Object} query - Prisma where clause
 * @returns {Promise<Object[]>}
 */
export const findForUser = async (query: Prisma.GitRepoAssignmentWhereInput) => {
  return getPrisma().gitRepoAssignment.findMany({
    where: query,
    include: {
      token_transactions: true,
      // Commit count for the student's repository link.
      analytics_snapshot: { select: { total_commits: true, last_commit_at: true, fetched_at: true } },
      git_repo: {
        include: {
          student: true,
          repository: true,
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
 * Create a GitRepoAssignment
 * @param {Object} data - GitRepoAssignment data
 * @returns {Promise<Object>}
 */
export const create = async (data: GitRepoAssignmentCreateData) => {
  const provider = data.provider as GitProvider;

  // One row per (student repo, assignment) in either submission mode. A retry
  // that adopted an existing GitHub issue may fill in the issue fields; the
  // row's id is never rewritten.
  return getPrisma().gitRepoAssignment.upsert({
    where: {
      git_repo_id_assignment_id: {
        git_repo_id: data.git_repo_id,
        assignment_id: data.assignment_id,
      },
    },
    create: {
      ...data,
      provider,
    },
    update: {
      provider,
      ...(data.provider_id != null ? { provider_id: data.provider_id } : {}),
      ...(data.provider_issue_number != null
        ? { provider_issue_number: data.provider_issue_number }
        : {}),
    },
    include: {
      assignment: true,
      git_repo: true,
    },
  });
};

/**
 * A push to a student repo is the submission for every published REPO-mode
 * assignment that submits through it, the way GitHub Classroom treated repos:
 * the latest push BEFORE the deadline is the submission, and the deadline
 * freezes it. Extension hours the student bought with tokens push their
 * deadline out by that many hours. A push after that is not a submission at
 * all (the row stays as it was), a row with grades is frozen too, and a
 * late-delivered older webhook never moves the time backwards. Returns the
 * rows that changed.
 */
export const recordPush = async (gitRepoId: string, pushedAt: Date) => {
  const prisma = getPrisma();
  const candidates = await prisma.gitRepoAssignment.findMany({
    where: {
      git_repo_id: gitRepoId,
      assignment: { type: 'REPO', submission_mode: 'REPO', is_published: true },
      grades: { none: {} },
      OR: [{ closed_at: null }, { closed_at: { lt: pushedAt } }],
    },
    select: {
      id: true,
      assignment: { select: { student_deadline: true } },
      token_transactions: { where: { type: 'PURCHASE' }, select: { hours_purchased: true } },
    },
  });
  const open = candidates.filter(c => {
    const deadline = c.assignment.student_deadline;
    if (!deadline) return true;
    const extensionHours = c.token_transactions.reduce(
      (sum, t) => sum + (t.hours_purchased ?? 0),
      0
    );
    const cutoff = new Date(deadline).getTime() + extensionHours * 3_600_000;
    return pushedAt.getTime() <= cutoff;
  });
  if (open.length === 0) return [];
  await prisma.gitRepoAssignment.updateMany({
    where: { id: { in: open.map(c => c.id) } },
    data: { status: 'CLOSED', closed_at: pushedAt },
  });
  return open.map(c => ({ id: c.id }));
};

/** How long after the student repo was created a commit must land to count as the student's own push. */
const TEMPLATE_COMMIT_GRACE_MS = 2 * 60_000;

/**
 * A push-mode submission row created for a repo that already holds work: the
 * student's latest push before the deadline counts as their submission,
 * exactly as one arriving through the webhook would. Reads the repo's recent
 * commits and skips what is not the student's: bot commits (autograding
 * workflow pushes) and anything within a couple of minutes of the repo's
 * creation, which is the template being copied in. Only fills an empty
 * `closed_at`; a push after the deadline leaves the row unsubmitted, as the
 * webhook path does. Returns the time recorded, or null.
 */
export const recordExistingPush = async (gitRepoAssignmentId: string) => {
  const prisma = getPrisma();
  const row = await prisma.gitRepoAssignment.findUnique({
    where: { id: gitRepoAssignmentId },
    select: {
      id: true,
      closed_at: true,
      assignment: { select: { submission_mode: true, student_deadline: true } },
      git_repo: {
        select: {
          name: true,
          created_at: true,
          classroom: { select: { git_organization: true } },
        },
      },
    },
  });
  if (!row || row.closed_at || row.assignment.submission_mode !== 'REPO') return null;
  const gitOrg = row.git_repo.classroom.git_organization;
  if (!gitOrg?.login) return null;

  const commits = await getGitProvider(gitOrg).listCommits(gitOrg.login, row.git_repo.name, {
    maxCommits: 10,
  });
  const notBefore = new Date(row.git_repo.created_at).getTime() + TEMPLATE_COMMIT_GRACE_MS;
  const own = commits.find(c => {
    if (c.author_login?.endsWith('[bot]')) return false;
    return new Date(c.ts).getTime() > notBefore;
  });
  if (!own) return null;
  const pushedAt = new Date(own.ts);

  const deadline = row.assignment.student_deadline;
  if (deadline && pushedAt.getTime() > new Date(deadline).getTime()) return null;

  const result = await prisma.gitRepoAssignment.updateMany({
    where: { id: row.id, closed_at: null },
    data: { status: 'CLOSED', closed_at: pushedAt },
  });
  return result.count > 0 ? pushedAt : null;
};

/**
 * Update a GitRepoAssignment
 * @param {string} id - UUID of the GitRepoAssignment
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>}
 */
export const update = async (id: string, updates: GitRepoAssignmentUpdateData) => {
  const repositoryAssignmentData = {
    ...updates,
    ...(updates.status && { status: updates.status as IssueStatus }),
  } as Prisma.GitRepoAssignmentUncheckedUpdateInput;

  return getPrisma().gitRepoAssignment.update({
    where: { id },
    data: repositoryAssignmentData,
    include: {
      assignment: true,
      git_repo: true,
    },
  });
};

/**
 * Delete a GitRepoAssignment
 * @param {string} id - UUID of the GitRepoAssignment
 * @returns {Promise<Object>}
 */
export const deleteById = async (id: string) => {
  return getPrisma().gitRepoAssignment.delete({
    where: { id },
  });
};

/**
 * Get grading progress for a classroom
 * @param {string} classroomSlug - Classroom slug
 * @returns {Promise<number>} - Percentage graded
 */
export const getGradingProgress = async (classroomSlug: string) => {
  let totalNum = await getPrisma().gitRepoAssignment.count({
    where: {
      git_repo: { classroom: { slug: classroomSlug } },
      assignment: { is_extra_credit: false },
    },
  });

  // Count submitted extra credit
  const numExtraCredit = await getPrisma().gitRepoAssignment.count({
    where: {
      status: 'CLOSED',
      git_repo: { classroom: { slug: classroomSlug } },
      assignment: { is_extra_credit: true },
    },
  });

  totalNum += numExtraCredit;

  let numUngraded = await getPrisma().gitRepoAssignment.count({
    where: {
      git_repo: { classroom: { slug: classroomSlug } },
      assignment: { is_extra_credit: false },
      grades: { none: {} },
    },
  });

  // Count ungraded extra credit
  const numExtraCreditUngraded = await getPrisma().gitRepoAssignment.count({
    where: {
      status: 'CLOSED',
      git_repo: { classroom: { slug: classroomSlug } },
      assignment: { is_extra_credit: true },
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
  const totalNum = await getPrisma().gitRepoAssignment.count({
    where: {
      git_repo: { classroom: { slug: classroomSlug } },
      assignment: { is_extra_credit: false },
    },
  });

  const numCompleted = await getPrisma().gitRepoAssignment.count({
    where: {
      status: 'CLOSED',
      git_repo: { classroom: { slug: classroomSlug } },
      assignment: { is_extra_credit: false },
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
  const totalNum = await getPrisma().gitRepoAssignment.count({
    where: {
      git_repo: { classroom: { slug: classroomSlug } },
    },
  });

  const repoAssignments = await getPrisma().gitRepoAssignment.findMany({
    where: {
      git_repo: { classroom: { slug: classroomSlug } },
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
 * Find recently closed GitRepoAssignments
 * @param {string} classroomSlug - Classroom slug
 * @param {Date} startDate - Start of date range
 * @param {Date} endDate - End of date range
 * @returns {Promise<Object[]>}
 */
export const findRecentlyClosed = async (classroomSlug: string, startDate: Date, endDate: Date) => {
  return getPrisma().gitRepoAssignment.findMany({
    where: {
      git_repo: { classroom: { slug: classroomSlug } },
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
 * Close a GitRepoAssignment (mark as submitted)
 * @param {string} id - UUID of the GitRepoAssignment
 * @returns {Promise<Object>}
 */
export const close = async (id: string) => {
  return getPrisma().gitRepoAssignment.update({
    where: { id },
    data: {
      status: 'CLOSED',
      closed_at: new Date(),
    },
  });
};

/**
 * Reopen a GitRepoAssignment
 * @param {string} id - UUID of the GitRepoAssignment
 * @returns {Promise<Object>}
 */
export const reopen = async (id: string) => {
  return getPrisma().gitRepoAssignment.update({
    where: { id },
    data: {
      status: 'OPEN',
      closed_at: null,
    },
  });
};

/**
 * Override late status
 * @param {string} id - UUID of the GitRepoAssignment
 * @param {boolean} override - Whether to override
 * @returns {Promise<Object>}
 */
export const setLateOverride = async (id: string, override: boolean) => {
  return getPrisma().gitRepoAssignment.update({
    where: { id },
    data: { is_late_override: override },
  });
};

/**
 * Find all GitRepoAssignments for a specific student in a classroom
 * @param {string} studentId - UUID of the student
 * @param {string} classroomSlug - Slug of the classroom
 * @returns {Promise<Object[]>}
 */
export const findAllForStudent = async (studentId: string, classroomSlug: string) => {
  return getPrisma().gitRepoAssignment.findMany({
    where: {
      git_repo: {
        student_id: studentId,
        classroom: { slug: classroomSlug },
      },
    },
    include: {
      token_transactions: true,
      git_repo: {
        include: {
          student: true,
          repository: true,
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
