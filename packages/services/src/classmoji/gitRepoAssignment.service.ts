/**
 * GitRepoAssignment Service (formerly RepositoryIssue)
 *
 * A GitRepoAssignment represents a student's instance of an Assignment.
 * It tracks their progress, grades, and submission status.
 */
import getPrisma, { GIT_IDENTITY } from '@classmoji/database';
import {
  extendedDeadlineMs,
  isPastDeadlineIgnoringOverride,
  repoNamespace,
  withLogins,
} from '@classmoji/utils';
import { findClassroomGitProvider } from './classroomGitProvider.ts';
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
  return withLogins(
    await getPrisma().gitRepoAssignment.findUnique({
      where: { id },
      include: {
        assignment: true,
        git_repo: true,
        grades: {
          include: {
            grader: { include: GIT_IDENTITY },
          },
        },
        graders: {
          include: {
            grader: { include: GIT_IDENTITY },
          },
        },
      },
    })
  );
};

/** A usable id for a scoped `where`: a non-empty string, nothing else. */
const isScopedId = (value: unknown): value is string => typeof value === 'string' && value !== '';

/**
 * Find one submission (GitRepoAssignment) of a classroom, through its git
 * repo's classroom, optionally narrowed to one Repository or one Assignment.
 *
 * Returns null — without querying — when an id is not a non-empty string:
 * Prisma drops an `undefined` value from a `where`, and an id field also
 * accepts a filter object, so an unchecked value would match an arbitrary
 * submission of the classroom.
 *
 * Includes the git repo (its stored name) and the assigned graders with their
 * users (their stored logins).
 */
export const findByIdInClassroom = async (
  id: unknown,
  classroomId: string,
  options: { repositoryId?: string; assignmentId?: string } = {}
) => {
  if (!isScopedId(id) || !isScopedId(classroomId)) return null;
  const { repositoryId, assignmentId } = options;
  if (repositoryId !== undefined && !isScopedId(repositoryId)) return null;
  if (assignmentId !== undefined && !isScopedId(assignmentId)) return null;

  const row = await getPrisma().gitRepoAssignment.findFirst({
    where: {
      id,
      ...(assignmentId ? { assignment_id: assignmentId } : {}),
      git_repo: {
        classroom_id: classroomId,
        ...(repositoryId ? { repository_id: repositoryId } : {}),
      },
    },
    include: {
      git_repo: true,
      graders: { include: { grader: { include: GIT_IDENTITY } } },
    },
  });
  return withLogins(row, await findClassroomGitProvider(classroomId));
};

/**
 * Find a GitRepoAssignment by provider and provider_id
 * Used for webhook lookups
 * @param {string} provider - Git provider (GITHUB, GITLAB, etc.)
 * @param {string} providerId - Provider-specific issue ID
 * @returns {Promise<Object|null>}
 */
export const findByProviderId = async (provider: GitProvider, providerId: string) => {
  return withLogins(
    await getPrisma().gitRepoAssignment.findUnique({
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
            student: { include: GIT_IDENTITY },
            team: true,
          },
        },
        grades: {
          include: {
            grader: { include: GIT_IDENTITY },
          },
        },
      },
    })
  );
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
  return withLogins(
    await getPrisma().gitRepoAssignment.findMany({
      where: {
        git_repo: {
          classroom_id: classroomId,
        },
      },
      include: {
        assignment: true,
        // Commit count for the repository column, as of the last refresh.
        analytics_snapshot: {
          select: { total_commits: true, last_commit_at: true, fetched_at: true },
        },
        // Purchased extension hours, for lateness (is_late, num_late_hours).
        token_transactions: { select: { hours_purchased: true } },
        grades: {
          include: {
            token_transaction: true,
            grader: { include: GIT_IDENTITY },
          },
        },
        graders: {
          include: {
            grader: { include: GIT_IDENTITY },
          },
        },
        git_repo: {
          include: {
            repository: true,
            student: { include: GIT_IDENTITY },
            team: true,
          },
        },
      },
    })
  );
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

  const rows = await getPrisma().gitRepoAssignment.findMany({
    where,
    include: {
      git_repo: true,
      graders: {
        include: {
          grader: { include: GIT_IDENTITY },
        },
      },
    },
  });
  // A grader's `login` is their username on the classroom's provider: it is
  // what gets assigned on the issue.
  if (rows.length === 0) return withLogins(rows);
  return withLogins(rows, await findClassroomGitProvider(rows[0].git_repo.classroom_id));
};

/**
 * Find GitRepoAssignments for a user
 * @param {Object} query - Prisma where clause
 * @returns {Promise<Object[]>}
 */
export const findForUser = async (query: Prisma.GitRepoAssignmentWhereInput) => {
  return withLogins(
    await getPrisma().gitRepoAssignment.findMany({
      where: query,
      include: {
        token_transactions: true,
        // Commit count for the student's repository link.
        analytics_snapshot: {
          select: { total_commits: true, last_commit_at: true, fetched_at: true },
        },
        git_repo: {
          include: {
            student: { include: GIT_IDENTITY },
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
            grader: { include: GIT_IDENTITY },
          },
        },
        grades: {
          include: {
            grader: { include: GIT_IDENTITY },
            token_transaction: true,
          },
        },
      },
      orderBy: {
        assignment: {
          student_deadline: 'desc',
        },
      },
    })
  );
};

/**
 * Create a GitRepoAssignment
 * @param {Object} data - GitRepoAssignment data
 * @returns {Promise<Object>}
 */
export const create = async (data: GitRepoAssignmentCreateData) => {
  const provider = data.provider as GitProvider;

  // A submission row joins a student's repo to an assignment, and both belong
  // to a classroom. Nothing in the schema stops those classrooms differing, and
  // when they do the row leaks one classroom's grades into another's views —
  // the student dashboard reads submissions by the REPO's classroom but renders
  // the ASSIGNMENT's title and grades. Refuse rather than write it.
  const [repo, assignment] = await Promise.all([
    getPrisma().gitRepo.findUnique({
      where: { id: data.git_repo_id },
      select: { classroom_id: true },
    }),
    getPrisma().assignment.findUnique({
      where: { id: data.assignment_id },
      select: { module: { select: { classroom_id: true } } },
    }),
  ]);
  if (repo && assignment && repo.classroom_id !== assignment.module.classroom_id) {
    throw new Error(
      `Refusing to link assignment ${data.assignment_id} to a repo in another classroom ` +
        `(${assignment.module.classroom_id} vs ${repo.classroom_id})`
    );
  }

  const pair = {
    git_repo_id_assignment_id: {
      git_repo_id: data.git_repo_id,
      assignment_id: data.assignment_id,
    },
  };
  const include = { assignment: true, git_repo: true } as const;
  const issueFields = {
    provider,
    ...(data.provider_id != null ? { provider_id: data.provider_id } : {}),
    ...(data.provider_issue_number != null
      ? { provider_issue_number: data.provider_issue_number }
      : {}),
  };

  // One row per (student repo, assignment) in either submission mode. A retry
  // that adopted an existing GitHub issue may fill in the issue fields; the
  // row's id is never rewritten.
  try {
    return await getPrisma().gitRepoAssignment.upsert({
      where: pair,
      create: { ...data, provider },
      update: issueFields,
      include,
    });
  } catch (error) {
    if ((error as { code?: unknown })?.code !== 'P2002') throw error;
    return recoverFromCreateConflict(data, pair, issueFields, include, error);
  }
};

/**
 * A unique violation out of `create`'s upsert. Because the create sets `id`
 * (the issue id in ISSUE mode), Prisma cannot turn that upsert into one
 * INSERT ... ON CONFLICT: it reads by (git repo, assignment) and then inserts,
 * so two runs for the same pair can both miss the row and both insert. The
 * loser trips the primary key first (Postgres checks the pkey index before the
 * others), which is the "Unique constraint failed on the fields: (`id`)" a
 * concurrent release produced in production.
 *
 * Losing that race is success: the pair's row exists, so return it. It only
 * takes this run's issue fields when it has none of its own, so a row keyed on
 * the winner's issue never ends up pointing at the loser's. Anything else (the
 * issue is already another pair's submission row) is a genuine conflict and
 * is reported with both sides named rather than as a bare P2002.
 */
const recoverFromCreateConflict = async (
  data: GitRepoAssignmentCreateData,
  pair: { git_repo_id_assignment_id: { git_repo_id: string; assignment_id: string } },
  issueFields: Prisma.GitRepoAssignmentUncheckedUpdateInput,
  include: { assignment: true; git_repo: true },
  error: unknown
) => {
  const prisma = getPrisma();
  const existing = await prisma.gitRepoAssignment.findUnique({ where: pair, include });
  if (existing) {
    if (existing.provider_id == null && data.provider_id != null) {
      return prisma.gitRepoAssignment.update({ where: pair, data: issueFields, include });
    }
    return existing;
  }

  const holder = data.provider_id
    ? await prisma.gitRepoAssignment.findFirst({
        where: {
          OR: [
            { provider: data.provider as GitProvider, provider_id: data.provider_id },
            ...(data.id ? [{ id: data.id }] : []),
          ],
        },
        select: { id: true, git_repo_id: true, assignment_id: true },
      })
    : null;
  if (holder) {
    throw new Error(
      `Issue ${data.provider_id} is already the submission row ${holder.id} for ` +
        `repo ${holder.git_repo_id} / assignment ${holder.assignment_id}; refusing to ` +
        `reuse it for repo ${data.git_repo_id} / assignment ${data.assignment_id}`,
      { cause: error }
    );
  }
  throw error;
};

/**
 * A push to a student repo is the submission for every published REPO-mode
 * assignment that submits through it. The latest push BEFORE the deadline is
 * the submission and the deadline freezes it, the way GitHub Classroom
 * treated repos; extension hours the student bought with tokens push their
 * deadline out by that many hours. A push AFTER that cutoff only counts when
 * the row has no submission yet: it becomes a late submission (the late
 * penalty applies, or the instructor waives it) rather than leaving the
 * student at "Not submitted". An on-time submission is never replaced by a
 * late push, a row with grades is frozen too, and a late-delivered older
 * webhook never moves the time backwards. Returns the rows that changed.
 */
export const recordPush = async (gitRepoId: string, pushedAt: Date) => {
  const prisma = getPrisma();
  const candidates = await prisma.gitRepoAssignment.findMany({
    where: {
      git_repo_id: gitRepoId,
      assignment: { type: 'REPO', submission_mode: 'REPO', is_published: true },
      OR: [
        // Never submitted: the first push is the submission, graded or not.
        // A grade given before any push must not leave the row stuck at
        // "Not submitted" forever.
        { closed_at: null },
        // Already submitted: a later push may move the time only while the
        // row is ungraded; once graded, the submission is frozen.
        { closed_at: { lt: pushedAt }, grades: { none: {} } },
      ],
    },
    select: {
      id: true,
      closed_at: true,
      assignment: { select: { student_deadline: true } },
      // Every row, not PURCHASE alone: a cancelled purchase leaves a REFUND
      // with negative hours, which takes its extension back.
      token_transactions: { select: { hours_purchased: true } },
    },
  });
  const open = candidates.filter(c => {
    const cutoff = extendedDeadlineMs(c.assignment.student_deadline, c.token_transactions);
    if (cutoff === null) return true;
    if (pushedAt.getTime() <= cutoff) return true;
    // Past the cutoff: a first push is a late submission; an existing one stays.
    return c.closed_at === null;
  });
  if (open.length === 0) return [];
  await prisma.gitRepoAssignment.updateMany({
    where: { id: { in: open.map(c => c.id) } },
    data: { status: 'CLOSED', closed_at: pushedAt },
  });
  return open.map(c => ({ id: c.id }));
};

/**
 * The identity the provisioning task commits as when it copies the template
 * into a student repo (see packages/tasks createRepository). Its commits are
 * never a student's push.
 */
export const CLASSMOJI_BOT_EMAIL = 'hello@classmoji.com';

/**
 * A push-mode submission row created for a repo that already holds work: the
 * student's latest push before the deadline counts as their submission,
 * exactly as one arriving through the webhook would. Reads the repo's recent
 * commits and skips what is not the student's: bot commits (autograding
 * workflow pushes), the Classmoji Bot's own template commit, and anything
 * dated before the repo existed (the template's history, pushed as-is). A
 * student who pushes seconds after provisioning still counts; an earlier
 * two-minute grace window used to swallow that push. Only fills an empty
 * `closed_at`; a push after the deadline is recorded as a late submission,
 * as the webhook path does. Returns the time recorded, or null.
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
          classroom: { select: { git_namespace: true, git_organization: true } },
        },
      },
    },
  });
  if (!row || row.closed_at || row.assignment.submission_mode !== 'REPO') return null;
  const gitOrg = row.git_repo.classroom.git_organization;
  // The org on Github; the class subgroup on GitLab.
  const owner = repoNamespace(row.git_repo.classroom);
  if (!gitOrg?.login || !owner) return null;

  const commits = await getGitProvider(gitOrg).listCommits(owner, row.git_repo.name, {
    maxCommits: 10,
  });
  const createdAt = new Date(row.git_repo.created_at).getTime();
  const own = commits.find(c => {
    if (c.author_login?.endsWith('[bot]')) return false;
    if (c.author_email?.toLowerCase() === CLASSMOJI_BOT_EMAIL) return false;
    return new Date(c.ts).getTime() > createdAt;
  });
  if (!own) return null;
  const pushedAt = new Date(own.ts);

  const result = await prisma.gitRepoAssignment.updateMany({
    where: { id: row.id, closed_at: null },
    data: { status: 'CLOSED', closed_at: pushedAt },
  });
  return result.count > 0 ? pushedAt : null;
};

/**
 * Re-read a push-mode submission after the student bought extension hours.
 * A push that came after the old cutoff was ignored by `recordPush` when an
 * on-time submission existed; if the repo's latest push now falls within the
 * deadline plus the purchased hours, it becomes the submission, so the
 * student does not have to push again. Same rules as `recordPush`: only a
 * published REPO-mode row, never a graded one, never a push past the new
 * cutoff, and never a time earlier than the current submission (the write
 * re-checks the last two, so a concurrent push or grade wins).
 *
 * Reads the push time recorded from the provider's push events
 * (`GitRepo.last_push_at`, server time, as `recordPush` receives it), so it
 * makes no network call. Only the latest push is known: when the student
 * pushed again after the new cutoff, nothing changes. Returns the time
 * recorded, or null.
 */
export const recordPushAfterExtension = async (gitRepoAssignmentId: string) => {
  const prisma = getPrisma();
  const row = await prisma.gitRepoAssignment.findUnique({
    where: { id: gitRepoAssignmentId },
    select: {
      id: true,
      closed_at: true,
      assignment: {
        select: { type: true, submission_mode: true, is_published: true, student_deadline: true },
      },
      // Every row, refunds included: a REFUND carries negative hours.
      token_transactions: { select: { hours_purchased: true } },
      git_repo: { select: { last_push_at: true } },
      _count: { select: { grades: true } },
    },
  });
  if (!row) return null;
  const { assignment } = row;
  if (
    assignment.type !== 'REPO' ||
    assignment.submission_mode !== 'REPO' ||
    !assignment.is_published ||
    row._count.grades > 0
  ) {
    return null;
  }
  const pushedAt = row.git_repo.last_push_at;
  if (!pushedAt) return null;
  // No deadline: every push already counts, nothing to re-read.
  const cutoff = extendedDeadlineMs(assignment.student_deadline, row.token_transactions);
  if (cutoff === null || pushedAt.getTime() > cutoff) return null;
  if (row.closed_at && row.closed_at.getTime() >= pushedAt.getTime()) return null;

  const result = await prisma.gitRepoAssignment.updateMany({
    where: {
      id: row.id,
      grades: { none: {} },
      OR: [{ closed_at: null }, { closed_at: { lt: pushedAt } }],
    },
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

// Shared with the MCP read surfaces, which shape rows outside this service.
export { isPastDeadlineIgnoringOverride };

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

interface CountedLateRow {
  closed_at: Date | null;
  is_late_override: boolean;
  assignment: { student_deadline: Date | null } | null;
  token_transactions: { hours_purchased: number | null }[];
}

/**
 * Whether the staff dashboards count a submission as late: turned in after
 * the deadline plus the extension hours the student bought (the rule of the
 * `is_late` computed field), or carrying a late exemption, since an exempted
 * submission was still late. A row with nothing turned in is missing, not late.
 */
export const isCountedLate = (row: CountedLateRow) =>
  row.is_late_override || (row.closed_at !== null && isPastDeadlineIgnoringOverride(row));

/**
 * Count a classroom's submissions and the late ones among them (see
 * `isCountedLate`).
 * @param {string} classroomSlug - Classroom slug
 * @returns {Promise<{ total: number, late: number }>}
 */
export const getLateCount = async (classroomSlug: string) => {
  const repoAssignments = await getPrisma().gitRepoAssignment.findMany({
    where: {
      git_repo: { classroom: { slug: classroomSlug } },
    },
    select: {
      closed_at: true,
      is_late_override: true,
      assignment: { select: { student_deadline: true } },
      // Every row, refunds included: a REFUND carries negative hours.
      token_transactions: { select: { hours_purchased: true } },
    },
  });
  return {
    total: repoAssignments.length,
    late: repoAssignments.filter(isCountedLate).length,
  };
};

/**
 * Get late submission percentage for a classroom
 * @param {string} classroomSlug - Classroom slug
 * @returns {Promise<number>} - Percentage late
 */
export const getLatePercentage = async (classroomSlug: string) => {
  const { total, late } = await getLateCount(classroomSlug);
  if (total === 0) return 0;
  return parseFloat(((late / total) * 100).toFixed(0));
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
  return withLogins(
    await getPrisma().gitRepoAssignment.findMany({
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
            student: { include: GIT_IDENTITY },
            repository: true,
          },
        },
        assignment: true,
        graders: {
          include: {
            grader: { include: GIT_IDENTITY },
          },
        },
        grades: {
          include: {
            grader: { include: GIT_IDENTITY },
            token_transaction: true,
          },
        },
      },
      orderBy: {
        assignment: {
          student_deadline: 'desc',
        },
      },
    })
  );
};
