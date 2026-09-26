/**
 * GitRepoAssignmentGrader Service (formerly RepositoryIssueGrader)
 *
 * Manages grader assignments to GitRepoAssignments
 */
import _ from 'lodash';
import { tasks } from '@trigger.dev/sdk';

import getPrisma from '@classmoji/database';
import * as classroomService from './classroom.service.ts';
import * as classroomMembershipService from './classroomMembership.service.ts';
import * as gitRepoAssignmentService from './gitRepoAssignment.service.ts';
import * as notificationService from './notification.service.ts';
import { planGraderReassignment } from './graderReassignPlan.ts';

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
 * @param options.notify - false skips the TA_GRADING_ASSIGNED notification
 *   (a caller moving many slots sends one summary instead). Defaults to true.
 * @returns {Promise<Object>}
 */
export const addGraderToAssignment = async (
  repositoryAssignmentId: string,
  graderId: string,
  { notify = true }: { notify?: boolean } = {}
) => {
  const created = await getPrisma().gitRepoAssignmentGrader.create({
    data: {
      git_repo_assignment_id: repositoryAssignmentId,
      grader_id: graderId,
    },
  });
  if (notify) await notifyGraderAssigned(repositoryAssignmentId, [graderId]);
  return created;
};

/**
 * The staff roles that can be picked as a grader: the same pair the web grader
 * pickers list and the RANDOM bulk assignment draws from. OWNER is not one.
 */
export const GRADER_ROLES = ['ASSISTANT', 'TEACHER'] as const;

/**
 * Find a user who may be picked as a grader in this classroom: a membership
 * with a grader role and `is_grader` set — the pool the web pickers offer.
 *
 * One query over the membership row itself, with the role in the `where`: a
 * user can hold several memberships in one classroom (one per role), so a
 * user-first lookup would read an arbitrary one of them. Returns the user
 * (whose stored login is the one to use), or null when not eligible or when
 * either id is not a non-empty string.
 */
export const findEligibleGrader = async (classroomId: string, userId: unknown) => {
  if (typeof userId !== 'string' || !userId) return null;
  if (typeof classroomId !== 'string' || !classroomId) return null;

  const membership = await getPrisma().classroomMembership.findFirst({
    where: {
      classroom_id: classroomId,
      user_id: userId,
      role: { in: [...GRADER_ROLES] },
      is_grader: true,
    },
    include: { user: true },
  });
  return membership?.user ?? null;
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
          analytics_snapshot: {
            select: { total_commits: true, last_commit_at: true, fetched_at: true },
          },
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

// ─── Bulk grader assignment ──────────────────────────────────────────────────

export type AssignGradersMethod = 'RANDOM' | 'EXISTING';

export interface AssignGradersResult {
  numAssignmentsToAddGradersTo: number;
}

/** Thrown for caller-fixable failures so routes/tools can map them to a message. */
export class AssignGradersError extends Error {
  code: 'classroom_not_found' | 'no_graders' | 'template_required';

  constructor(code: AssignGradersError['code'], message: string) {
    super(message);
    this.name = 'AssignGradersError';
    this.code = code;
  }
}

interface GraderInfo {
  id?: string;
  login?: string | null;
  studentId?: string | null;
  teamId?: string | null;
  graders?: Array<{ grader: { id: string; login: string | null } }>;
  [key: string]: unknown;
}

/**
 * Bulk-assign graders to every submission of an assignment. Shared by the web
 * admin.$class.repos_.$title.assign-graders action and the MCP tool.
 *
 * RANDOM: shuffles the classroom's is_grader ASSISTANTs and walks them
 * round-robin (`assistants[index % length]`) — exactly one grader per submission.
 * EXISTING: copies the grader mapping from `templateAssignmentId` in the same
 * repository, matched by student_id (individual repos) or team_id (team repos);
 * a submission with no match in the template is skipped, and a template
 * submission with several graders yields several assignments.
 *
 * Fans out one `add_grader_to_git_repo_assignment` run per (submission, grader).
 * `sessionId` is optional: the web route passes one so the run tags can drive
 * its progress stream; MCP omits it and the runs go out untagged.
 */
export const assignGradersToAssignment = async ({
  classroomId,
  assignmentId,
  method,
  templateAssignmentId,
  sessionId,
}: {
  classroomId: string;
  assignmentId: string;
  method: AssignGradersMethod;
  templateAssignmentId?: string | null;
  sessionId?: string | null;
}): Promise<AssignGradersResult> => {
  const classroom = await classroomService.findById(classroomId);
  if (!classroom) {
    throw new AssignGradersError(
      'classroom_not_found',
      `[assign-graders] classroom ${classroomId} not found`
    );
  }
  if (method === 'EXISTING' && !templateAssignmentId) {
    throw new AssignGradersError(
      'template_required',
      '[assign-graders] EXISTING requires templateAssignmentId'
    );
  }

  const gitOrganization = classroom.git_organization;
  const classroomSlug = classroom.slug;

  // Scope on the classroom id as well as the slug — we already hold the id, and
  // the primary key is the stronger of the two filters.
  const repoAssignments = await gitRepoAssignmentService.findByAssignmentId(
    assignmentId,
    classroomSlug,
    classroom.id
  );

  let graderLoginList: GraderInfo[] = [];

  if (method === 'RANDOM') {
    // The grader pool spans every staff role that can be flagged as a grader:
    // ASSISTANT and TEACHER. OWNER is excluded on purpose, and the role filter
    // in this query is what enforces it — an OWNER row carrying is_grader (the
    // generic membership writes accept the flag on any row; staff.updateStaff
    // is the path that refuses it) is still never drawn into the pool.
    const graders = _.shuffle(
      await classroomMembershipService.findUsersByRoles(classroomId, ['ASSISTANT', 'TEACHER'], {
        is_grader: true,
      })
    );

    // The original modulo indexing divided by zero here and produced
    // `Cannot read properties of undefined` — fail with something actionable.
    if (graders.length === 0) {
      throw new AssignGradersError(
        'no_graders',
        '[assign-graders] no staff with is_grader set in this classroom'
      );
    }

    graderLoginList = repoAssignments.map(
      (_repoAssignment, index) => graders[index % graders.length] as unknown as GraderInfo
    );
  } else {
    const templateRepoAssignments = await gitRepoAssignmentService.findByAssignmentId(
      templateAssignmentId!,
      classroomSlug,
      classroom.id
    );

    graderLoginList = templateRepoAssignments.map(repoAssignment => ({
      studentId: repoAssignment.git_repo.student_id,
      teamId: repoAssignment.git_repo.team_id,
      graders: repoAssignment.graders as unknown as GraderInfo['graders'],
    }));
  }

  const options = sessionId ? { tags: [`session_${sessionId}`] } : undefined;

  const taskPayloads = repoAssignments.map((repoAssignment, index) => {
    const { git_repo } = repoAssignment;

    if (method === 'RANDOM') {
      return {
        payload: {
          repoName: git_repo.name,
          gitOrganization,
          githubIssueNumber: repoAssignment.provider_issue_number,
          gitRepoAssignmentId: repoAssignment.id,
          graderLogin: graderLoginList[index].login!,
          graderId: graderLoginList[index].id!,
        },
        options,
      };
    }

    const isIndividualRepository = git_repo.student_id !== null;
    const graderMatch = isIndividualRepository
      ? graderLoginList.find(grader => grader.studentId === git_repo.student_id)
      : graderLoginList.find(grader => grader.teamId === git_repo.team_id);

    // Skip if no matching grader assignment found in template
    if (!graderMatch || !graderMatch.graders?.length) {
      return [];
    }

    return graderMatch.graders.map(({ grader }) => ({
      payload: {
        repoName: git_repo.name,
        gitOrganization,
        githubIssueNumber: repoAssignment.provider_issue_number,
        gitRepoAssignmentId: repoAssignment.id,
        graderLogin: grader.login,
        graderId: grader.id,
      },
      options,
    }));
  });

  const flatPayloads = _.flatten(taskPayloads);

  if (flatPayloads.length > 0) {
    await tasks.batchTrigger('add_grader_to_git_repo_assignment', flatPayloads);
  }

  return { numAssignmentsToAddGradersTo: flatPayloads.length };
};

// ─── Grading report ──────────────────────────────────────────────────────────

export interface GradingReportRow {
  grader: { id: string; login: string | null; name: string | null };
  assignment: { id: string; title: string; repository_title: string | null };
  assigned_count: number;
  graded_count: number;
  grade_distribution: Record<string, number>;
  last_graded_at: Date | null;
}

/**
 * Per-grader-per-assignment grading report for a classroom, optionally narrowed
 * to one assignment and/or one grader.
 *
 * `assigned_count` counts GitRepoAssignmentGrader rows (submissions handed to
 * that grader); `graded_count` counts DISTINCT submissions that carry at least
 * one AssignmentGrade from that grader. Because AssignmentGrade.grader_id is
 * independent of the grader join table, a grader can have graded a submission
 * they were never assigned — those pairs still get a row, with
 * `assigned_count: 0`, so real grading work is never hidden.
 *
 * Two grouped queries plus in-memory grouping (same shape as dashboard.taOps) —
 * never one query per grader or per submission.
 */
export const gradingReport = async ({
  classroomId,
  assignmentId,
  graderId,
}: {
  classroomId: string;
  assignmentId?: string | null;
  graderId?: string | null;
}): Promise<GradingReportRow[]> => {
  const prisma = getPrisma();

  const assignmentFilter = assignmentId ? { assignment_id: assignmentId } : {};
  const graderFilter = graderId ? { grader_id: graderId } : {};

  const [assignedRows, gradeRows] = await Promise.all([
    prisma.gitRepoAssignmentGrader.findMany({
      where: {
        ...graderFilter,
        git_repo_assignment: {
          ...assignmentFilter,
          git_repo: { classroom_id: classroomId },
        },
      },
      select: {
        grader: { select: { id: true, login: true, name: true } },
        git_repo_assignment: {
          select: {
            assignment_id: true,
            assignment: {
              select: { id: true, title: true, repository: { select: { title: true } } },
            },
          },
        },
      },
    }),
    prisma.assignmentGrade.findMany({
      where: {
        ...(graderId ? { grader_id: graderId } : { grader_id: { not: null } }),
        git_repo_assignment: {
          ...assignmentFilter,
          git_repo: { classroom_id: classroomId },
        },
      },
      select: {
        grader_id: true,
        emoji: true,
        created_at: true,
        git_repo_assignment_id: true,
        grader: { select: { id: true, login: true, name: true } },
        git_repo_assignment: {
          select: {
            assignment_id: true,
            assignment: {
              select: { id: true, title: true, repository: { select: { title: true } } },
            },
          },
        },
      },
    }),
  ]);

  interface Bucket extends GradingReportRow {
    gradedSubmissionIds: Set<string>;
  }
  const rows = new Map<string, Bucket>();

  const bucketFor = (
    grader: { id: string; login: string | null; name: string | null },
    assignment: { id: string; title: string; repository: { title: string | null } | null }
  ): Bucket => {
    const key = `${grader.id}:${assignment.id}`;
    let bucket = rows.get(key);
    if (!bucket) {
      bucket = {
        grader: { id: grader.id, login: grader.login, name: grader.name },
        assignment: {
          id: assignment.id,
          title: assignment.title,
          repository_title: assignment.repository?.title ?? null,
        },
        assigned_count: 0,
        graded_count: 0,
        grade_distribution: {},
        last_graded_at: null,
        gradedSubmissionIds: new Set<string>(),
      };
      rows.set(key, bucket);
    }
    return bucket;
  };

  for (const row of assignedRows) {
    const assignment = row.git_repo_assignment.assignment;
    if (!assignment) continue;
    bucketFor(row.grader, assignment).assigned_count += 1;
  }

  for (const grade of gradeRows) {
    const assignment = grade.git_repo_assignment.assignment;
    if (!assignment || !grade.grader) continue;
    const bucket = bucketFor(grade.grader, assignment);
    bucket.gradedSubmissionIds.add(grade.git_repo_assignment_id);
    bucket.grade_distribution[grade.emoji] = (bucket.grade_distribution[grade.emoji] ?? 0) + 1;
    if (!bucket.last_graded_at || grade.created_at > bucket.last_graded_at) {
      bucket.last_graded_at = grade.created_at;
    }
  }

  return Array.from(rows.values())
    .map(({ gradedSubmissionIds, ...row }) => ({
      ...row,
      graded_count: gradedSubmissionIds.size,
    }))
    .sort(
      (a, b) =>
        (a.grader.login ?? '').localeCompare(b.grader.login ?? '') ||
        a.assignment.title.localeCompare(b.assignment.title)
    );
};

// ─── Ungraded slots of a departing grader ────────────────────────────────────

/**
 * "Ungraded" means the submission carries NO AssignmentGrade at all — from
 * anyone, including a null-grader grade. That is the rule the grader progress
 * view uses (findGradersProgress: `grades.length > 0` is completed) and the
 * staff drawer shows. grading_report's graded_count is per grader (grades FROM
 * that grader), which is the wrong mirror here: once a co-grader has graded a
 * submission it is done, and moving its slot would only create work.
 *
 * Graded slots are never returned: they are the history of who graded.
 */
const ungradedSlotWhere = (classroomId: string, graderId: string) => ({
  grader_id: graderId,
  git_repo_assignment: {
    git_repo: { classroom_id: classroomId },
    grades: { none: {} },
  },
});

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/**
 * The grader's rows on submissions of this classroom that have no grade yet.
 * Classroom-scoped through git_repo.classroom_id; [] for a missing id.
 */
export const findUngradedSlotsForGrader = async (classroomId: string, graderId: string) => {
  if (!isId(classroomId) || !isId(graderId)) return [];

  return getPrisma().gitRepoAssignmentGrader.findMany({
    where: ungradedSlotWhere(classroomId, graderId),
    select: {
      git_repo_assignment_id: true,
      grader_id: true,
      git_repo_assignment: {
        select: {
          id: true,
          assignment_id: true,
          git_repo_id: true,
          graders: { select: { grader_id: true } },
        },
      },
    },
    orderBy: { git_repo_assignment_id: 'asc' },
  });
};

export type UngradedSlot = Awaited<ReturnType<typeof findUngradedSlotsForGrader>>[number];

/** How many ungraded slots this grader holds in this classroom. */
export const countUngradedSlotsForGrader = async (classroomId: string, graderId: string) => {
  if (!isId(classroomId) || !isId(graderId)) return 0;
  return getPrisma().gitRepoAssignmentGrader.count({
    where: ungradedSlotWhere(classroomId, graderId),
  });
};

/**
 * Ungraded-slot counts for every grader in the classroom, keyed by user id.
 * One grouped query — the Teaching Staff screen needs it for every row.
 */
export const countUngradedSlotsByGrader = async (
  classroomId: string
): Promise<Record<string, number>> => {
  if (!isId(classroomId)) return {};
  const groups = await getPrisma().gitRepoAssignmentGrader.groupBy({
    by: ['grader_id'],
    where: {
      git_repo_assignment: {
        git_repo: { classroom_id: classroomId },
        grades: { none: {} },
      },
    },
    _count: { _all: true },
  });
  return Object.fromEntries(groups.map(g => [g.grader_id, g._count._all]));
};

/**
 * Plan the reassignment of `fromGraderId`'s ungraded slots across the other
 * eligible graders of the classroom (see ./graderReassignPlan.ts for the rule).
 *
 * The pool is the one the web pickers and RANDOM bulk assignment use —
 * ASSISTANT or TEACHER with is_grader — minus the departing grader (their
 * membership may not be deleted yet: the removal task runs in the background)
 * and minus anyone without a stored login (the classroom-scoped helpers need
 * one). Loads come from ONE query over the candidates' rows in this classroom.
 */
export const planUngradedReassignment = async ({
  classroomId,
  fromGraderId,
  slots,
}: {
  classroomId: string;
  fromGraderId: string;
  slots: UngradedSlot[];
}) => {
  const pool = await classroomMembershipService.findUsersByRoles(classroomId, [...GRADER_ROLES], {
    is_grader: true,
  });
  const candidates = pool
    .filter(user => user.id !== fromGraderId && isId(user.login))
    .map(user => ({ id: user.id, login: user.login as string }));

  const loadRows =
    candidates.length === 0
      ? []
      : await getPrisma().gitRepoAssignmentGrader.findMany({
          where: {
            grader_id: { in: candidates.map(c => c.id) },
            git_repo_assignment: { git_repo: { classroom_id: classroomId } },
          },
          select: {
            grader_id: true,
            git_repo_assignment: { select: { assignment_id: true, git_repo_id: true } },
          },
        });

  return planGraderReassignment({
    slots: slots.map(slot => ({
      gitRepoAssignmentId: slot.git_repo_assignment.id,
      assignmentId: slot.git_repo_assignment.assignment_id,
      gitRepoId: slot.git_repo_assignment.git_repo_id,
      graderIds: slot.git_repo_assignment.graders.map(g => g.grader_id),
    })),
    candidates,
    loadRows: loadRows.map(row => ({
      graderId: row.grader_id,
      assignmentId: row.git_repo_assignment.assignment_id,
      gitRepoId: row.git_repo_assignment.git_repo_id,
    })),
  });
};
