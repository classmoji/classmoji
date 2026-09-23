/**
 * GitRepoAssignment Service (formerly RepositoryIssue)
 *
 * A GitRepoAssignment represents a student's instance of an Assignment.
 * It tracks their progress, grades, and submission status.
 */
import getPrisma from '@classmoji/database';
import type { GitProvider, IssueStatus, Prisma } from '@prisma/client';

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

  return getPrisma().gitRepoAssignment.upsert({
    where: {
      provider_provider_id: {
        provider,
        provider_id: data.provider_id,
      },
    },
    create: {
      ...data,
      provider,
    },
    update: {
      assignment_id: data.assignment_id,
      git_repo_id: data.git_repo_id,
      provider_issue_number: data.provider_issue_number,
      provider: data.provider as GitProvider,
    },
    include: {
      assignment: true,
      git_repo: true,
    },
  });
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

interface LateOverrideRow {
  closed_at: Date | null;
  assignment: { student_deadline: Date | null } | null;
  token_transactions: { hours_purchased: number | null }[];
}

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Whether a submission is past its deadline IGNORING `is_late_override`.
 *
 * Mirrors the `is_late` computed field in packages/database/index.ts minus its
 * first line (`if (is_late_override) return false`): that field reads false
 * for every exempted row, so it cannot say whether an exempted — or
 * about-to-be-cleared — submission was actually late. Same rules otherwise:
 * no valid deadline → not late; not yet closed → late once the deadline has
 * passed (purchased extension hours are NOT subtracted, as in `is_late`);
 * closed → whole hours late (dayjs `diff(..., 'hours')` truncation, floored at
 * zero) minus purchased extension hours, late when positive.
 */
export function isPastDeadlineIgnoringOverride(row: LateOverrideRow, now: Date = new Date()) {
  const deadline = row.assignment?.student_deadline;
  if (!deadline) return false;
  const deadlineMs = new Date(deadline).getTime();
  if (Number.isNaN(deadlineMs)) return false;
  if (!row.closed_at) return now.getTime() > deadlineMs;

  const hoursLate = Math.max(
    Math.trunc((new Date(row.closed_at).getTime() - deadlineMs) / MS_PER_HOUR),
    0
  );
  const extensionHours = (row.token_transactions ?? []).reduce(
    (acc, t) => acc + (t.hours_purchased || 0),
    0
  );
  return hoursLate - extensionHours > 0;
}

export type LateOverrideSelector = { ids: string[] } | { assignmentId: string };

export interface LateOverrideResult {
  /** Ids this call actually flipped (returned by the scoped write itself). */
  updatedIds: string[];
  /** Matched ids already at the requested value — not written. */
  unchangedIds: string[];
  /** Requested ids (ids mode only) that are missing or in another classroom. */
  notFoundIds: string[];
  /** Setting only: matched rows skipped because they are not past the deadline. */
  notLateIds: string[];
  /** Setting by assignment only: matched rows skipped because nothing was turned in. */
  notSubmittedIds: string[];
  /** Matched rows past their deadline, ignoring any exemption. */
  lateIds: string[];
}

const EMPTY_LATE_OVERRIDE_RESULT: LateOverrideResult = {
  updatedIds: [],
  unchangedIds: [],
  notFoundIds: [],
  notLateIds: [],
  notSubmittedIds: [],
  lateIds: [],
};

/**
 * Set or clear the late-penalty exemption on submissions of ONE classroom.
 *
 * Which rows may be written (mirrors when the web offers its waive button —
 * SubmissionsTable / LateOverrideButton show it only on `is_late ||
 * is_late_override` rows):
 *   - SETTING (true) writes only rows past their deadline ignoring any
 *     exemption; the rest come back in `notLateIds`. Exempting an on-time row
 *     would count it as late in getLatePercentage and the dashboard, and label
 *     it "Late waived".
 *   - SETTING by assignment also skips rows with nothing turned in (no
 *     `closed_at`, the field `is_late` uses) → `notSubmittedIds`: an exemption
 *     on an unsubmitted row switches off its `should_be_zero` missing-work zero,
 *     and "waive the late penalty for the class" must not mean "waive missing
 *     work". A row NAMED by id that is unsubmitted but past the deadline is
 *     still written — the web offers waive on exactly that row.
 *   - CLEARING (false) writes any row that currently carries the exemption.
 *
 * Both the read and the write carry `git_repo.classroom_id` in their WHERE
 * clause, so an id from another classroom is never matched, never written, and
 * comes back in `notFoundIds` exactly like an id that does not exist. The
 * eligibility rules run in JS over the scoped read; only the vetted ids reach
 * the write, which also filters on the current value, so `updatedIds` is what
 * the database reports it wrote.
 */
export const setLateOverrideInClassroom = async ({
  classroomId,
  selector,
  isLateOverride,
  now = new Date(),
}: {
  classroomId: string;
  selector: LateOverrideSelector;
  isLateOverride: boolean;
  now?: Date;
}): Promise<LateOverrideResult> => {
  if (!classroomId) throw new Error('setLateOverrideInClassroom requires a classroomId');
  const requestedIds = 'ids' in selector ? [...new Set(selector.ids)] : null;
  if (requestedIds && requestedIds.length === 0) {
    return { ...EMPTY_LATE_OVERRIDE_RESULT };
  }
  const skipUnsubmitted = isLateOverride && 'assignmentId' in selector;

  const rows = await getPrisma().gitRepoAssignment.findMany({
    where: {
      git_repo: { classroom_id: classroomId },
      ...('ids' in selector
        ? { id: { in: requestedIds ?? [] } }
        : { assignment_id: selector.assignmentId }),
    },
    select: {
      id: true,
      is_late_override: true,
      closed_at: true,
      assignment: { select: { student_deadline: true } },
      token_transactions: { select: { hours_purchased: true } },
    },
  });

  const lateIds = rows.filter(r => isPastDeadlineIgnoringOverride(r, now)).map(r => r.id);
  const late = new Set(lateIds);
  const found = new Set(rows.map(r => r.id));
  const notFoundIds = requestedIds ? requestedIds.filter(id => !found.has(id)) : [];

  // Rows already at the value are left alone (reported unchanged below); of
  // the rest, a SET is vetted against the eligibility rules above.
  const notSubmittedIds: string[] = [];
  const notLateIds: string[] = [];
  const toUpdate: string[] = [];
  for (const r of rows) {
    if (r.is_late_override === isLateOverride) continue;
    if (skipUnsubmitted && !r.closed_at) notSubmittedIds.push(r.id);
    else if (isLateOverride && !late.has(r.id)) notLateIds.push(r.id);
    else toUpdate.push(r.id);
  }

  let updatedIds: string[] = [];
  if (toUpdate.length > 0) {
    const written = await getPrisma().gitRepoAssignment.updateManyAndReturn({
      where: {
        id: { in: toUpdate },
        git_repo: { classroom_id: classroomId },
        is_late_override: !isLateOverride,
      },
      data: { is_late_override: isLateOverride },
      select: { id: true },
    });
    updatedIds = written.map(r => r.id);
  }

  // Everything matched that was neither written nor skipped is already at the
  // value — including a row a concurrent writer flipped between the read and
  // the guarded write (the write's value filter drops it from updatedIds).
  const settled = new Set([...updatedIds, ...notLateIds, ...notSubmittedIds]);
  const unchangedIds = rows.filter(r => !settled.has(r.id)).map(r => r.id);

  return { updatedIds, unchangedIds, notFoundIds, notLateIds, notSubmittedIds, lateIds };
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
      assignment: { repository: { is_extra_credit: false } },
    },
  });

  // Count submitted extra credit
  const numExtraCredit = await getPrisma().gitRepoAssignment.count({
    where: {
      status: 'CLOSED',
      git_repo: { classroom: { slug: classroomSlug } },
      assignment: { repository: { is_extra_credit: true } },
    },
  });

  totalNum += numExtraCredit;

  let numUngraded = await getPrisma().gitRepoAssignment.count({
    where: {
      git_repo: { classroom: { slug: classroomSlug } },
      assignment: { repository: { is_extra_credit: false } },
      grades: { none: {} },
    },
  });

  // Count ungraded extra credit
  const numExtraCreditUngraded = await getPrisma().gitRepoAssignment.count({
    where: {
      status: 'CLOSED',
      git_repo: { classroom: { slug: classroomSlug } },
      assignment: { repository: { is_extra_credit: true } },
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
      assignment: { repository: { is_extra_credit: false } },
    },
  });

  const numCompleted = await getPrisma().gitRepoAssignment.count({
    where: {
      status: 'CLOSED',
      git_repo: { classroom: { slug: classroomSlug } },
      assignment: { repository: { is_extra_credit: false } },
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
