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

  const repoAssignments = await gitRepoAssignmentService.findByAssignmentId(
    assignmentId,
    classroomSlug
  );

  let graderLoginList: GraderInfo[] = [];

  if (method === 'RANDOM') {
    const assistants = _.shuffle(
      await classroomMembershipService.findUsersByRole(classroomId, 'ASSISTANT', {
        is_grader: true,
      })
    );

    // The original modulo indexing divided by zero here and produced
    // `Cannot read properties of undefined` — fail with something actionable.
    if (assistants.length === 0) {
      throw new AssignGradersError(
        'no_graders',
        '[assign-graders] no assistants with is_grader set in this classroom'
      );
    }

    graderLoginList = repoAssignments.map(
      (_repoAssignment, index) => assistants[index % assistants.length] as unknown as GraderInfo
    );
  } else {
    const templateRepoAssignments = await gitRepoAssignmentService.findByAssignmentId(
      templateAssignmentId!,
      classroomSlug
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
