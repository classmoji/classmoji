/**
 * Assignment Service
 *
 * An Assignment is a gradable unit inside a Module. Its `type` says what it
 * points at: REPO (a GitHub issue in the repository's student repos, the only
 * kind that carries grades today), QUIZ, or FORM. `weight` is the only grading
 * weight in the system. Students work on GitRepoAssignments which track their
 * progress on REPO assignments.
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
      module: true,
      repository: {
        include: {
          classroom: true,
        },
      },
      quiz: true,
      form: true,
      git_repo_assignments: true,
    },
  });
};

/**
 * Find an Assignment by repository and title
 * @param {string} repositoryId - UUID of the Repository
 * @param {string} title - Assignment title
 * @returns {Promise<Object|null>}
 */
export const findByModuleAndTitle = async (repositoryId: string, title: string) => {
  return getPrisma().assignment.findFirst({
    where: { repository_id: repositoryId, title },
    include: {
      repository: true,
    },
  });
};

/**
 * Find all Assignments for a repository
 * @param {string} repositoryId - UUID of the Repository
 * @returns {Promise<Object[]>}
 */
export const findByRepositoryId = async (repositoryId: string) => {
  return getPrisma().assignment.findMany({
    where: { repository_id: repositoryId },
    orderBy: { created_at: 'asc' },
  });
};

/**
 * Find all published Assignments for a repository
 * @param {string} repositoryId - UUID of the Repository
 * @returns {Promise<Object[]>}
 */
export const findPublishedByRepositoryId = async (repositoryId: string) => {
  return getPrisma().assignment.findMany({
    where: {
      repository_id: repositoryId,
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
      module: { classroom_id: classroomId },
      ...query,
    },
    include: {
      module: true,
      repository: true,
    },
    orderBy: { created_at: 'asc' },
  });
};

/** The include every flat assignment listing carries. */
const LIST_INCLUDE = {
  module: { select: { id: true, title: true, slug: true, position: true } },
  repository: { select: { id: true, title: true, slug: true, type: true, is_published: true } },
  quiz: { select: { id: true, name: true, status: true } },
  form: { select: { id: true, title: true, slug: true, status: true } },
  _count: { select: { git_repo_assignments: true } },
} satisfies Prisma.AssignmentInclude;

const LIST_ORDER = [
  { module: { position: 'asc' } },
  { student_deadline: { sort: 'asc', nulls: 'last' } },
  { title: 'asc' },
] satisfies Prisma.AssignmentOrderByWithRelationInput[];

/**
 * Every assignment in a classroom, flat, with its module and target resolved.
 * Feeds the class-level Assignments page and the gradebook's column list.
 */
export const listForClassroom = async (
  classroomId: string,
  { publishedOnly = false }: { publishedOnly?: boolean } = {}
) => {
  return getPrisma().assignment.findMany({
    where: {
      module: { classroom_id: classroomId },
      ...(publishedOnly ? { is_published: true } : {}),
    },
    include: LIST_INCLUDE,
    orderBy: LIST_ORDER,
  });
};

/** The assignments of one module, in display order. */
export const findByModuleId = async (moduleId: string) => {
  return getPrisma().assignment.findMany({
    where: { module_id: moduleId },
    include: LIST_INCLUDE,
    orderBy: LIST_ORDER,
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
      module: { classroom_id: classroomId },
      is_published: true,
      student_deadline: {
        gte: afterDate,
      },
    },
    include: {
      module: true,
      repository: true,
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
      // Only REPO assignments are released into student repos as issues.
      // Quiz and form assignments never reach the release workflow.
      type: 'REPO',
      repository_id: { not: null },
      is_published: false,
      release_at: {
        lte: beforeDate,
      },
    },
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
  });
};

/**
 * Find a repository's not-yet-released assignments for an on-demand "release now"
 * (ignores release_at — the caller is forcing immediate release). Optionally
 * limit to specific assignment ids. Uses the same include shape as
 * findReadyForRelease so the release workflow can consume it directly.
 * @param {string} repositoryId - UUID of the Repository
 * @param {string[]} [assignmentIds] - Restrict to these assignment ids
 * @returns {Promise<Object[]>}
 */
/**
 * Stamp release_at = now on a repository's not-yet-released assignments so the
 * student-facing release gate (is_published AND release_at) can pass on an
 * on-demand "release now". Optionally limit to specific assignment ids.
 * @param {string} repositoryId - UUID of the Repository
 * @param {string[]} [assignmentIds] - Restrict to these assignment ids
 */
export const setReleaseNow = async (repositoryId: string, assignmentIds?: string[]) => {
  return getPrisma().assignment.updateMany({
    where: {
      type: 'REPO',
      repository_id: repositoryId,
      is_published: false,
      ...(assignmentIds && assignmentIds.length > 0 ? { id: { in: assignmentIds } } : {}),
    },
    data: { release_at: new Date() },
  });
};

export const findForReleaseByRepository = async (
  repositoryId: string,
  assignmentIds?: string[]
) => {
  return getPrisma().assignment.findMany({
    where: {
      type: 'REPO',
      repository_id: repositoryId,
      is_published: false,
      ...(assignmentIds && assignmentIds.length > 0 ? { id: { in: assignmentIds } } : {}),
    },
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
  });
};

/**
 * Create an Assignment
 * @param {Object} data - Assignment data
 * @param {string} data.repository_id - UUID of the Repository
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
export type AssignmentTargetType = 'REPO' | 'QUIZ' | 'FORM';

/**
 * Exactly one target, matching the kind. Mirrors the assignments_type_target
 * CHECK so a caller gets a readable error instead of a constraint violation,
 * and adds the cross-row rule the CHECK cannot express: a REPO assignment's
 * module is its repository's module.
 */
const validateTarget = async (data: Prisma.AssignmentUncheckedCreateInput) => {
  const type = (data.type ?? 'REPO') as AssignmentTargetType;
  const targets = {
    repository_id: data.repository_id ?? null,
    quiz_id: data.quiz_id ?? null,
    form_id: data.form_id ?? null,
  };
  const expected = { REPO: 'repository_id', QUIZ: 'quiz_id', FORM: 'form_id' }[type];
  if (!expected) throw new Error(`Unknown assignment type: ${String(type)}`);
  for (const [column, value] of Object.entries(targets)) {
    if (column === expected && !value) {
      throw new Error(`A ${type} assignment needs a ${column}`);
    }
    if (column !== expected && value) {
      throw new Error(`A ${type} assignment cannot have a ${column}`);
    }
  }
  if (type === 'REPO') {
    const repository = await getPrisma().repository.findUnique({
      where: { id: targets.repository_id! },
      select: { module_id: true },
    });
    if (!repository) throw new Error('Repository not found');
    if (repository.module_id !== data.module_id) {
      throw new Error('Assignment repository must belong to the same module');
    }
  }
  return type;
};

export const create = async (data: Prisma.AssignmentUncheckedCreateInput) => {
  const type = await validateTarget(data);
  return getPrisma().assignment.create({
    data: {
      ...data,
      type,
      slug: titleToIdentifier(data.title),
      weight: Number(data.weight || 100),
    },
    include: {
      module: true,
      repository: true,
      quiz: true,
      form: true,
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
      repository: true,
    },
  });

  await notifyAfterUpdate(id, updates, previous, updated);

  return updated;
};

type AssignmentNotificationSnapshot = { student_deadline: Date | null; grades_released: boolean };

/**
 * Due-date-changed and graded notifications, shared by every update path.
 * The classroom comes from the module, which every assignment has; the
 * repository is null for quiz/form assignments.
 */
const notifyAfterUpdate = async (
  id: string,
  updates: Prisma.AssignmentUpdateInput | Prisma.AssignmentUncheckedUpdateInput,
  previous: AssignmentNotificationSnapshot | null,
  updated: AssignmentNotificationSnapshot & {
    title: string;
    module: { classroom_id: string };
  }
) => {
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
};

/** Input for the classroom-scoped write helpers below. */
export interface AssignmentWriteInput {
  module_id: string;
  type: AssignmentTargetType;
  repository_id?: string | null;
  quiz_id?: string | null;
  form_id?: string | null;
  title: string;
  weight?: number;
  is_extra_credit?: boolean;
  is_published?: boolean;
  description?: string;
  student_deadline?: Date | string | null;
  grader_deadline?: Date | string | null;
  release_at?: Date | string | null;
  tokens_per_hour?: number;
  grades_released?: boolean;
}

const toDate = (value: Date | string | null | undefined): Date | null | undefined =>
  value === undefined ? undefined : value === null ? null : new Date(value);

/**
 * Create an assignment on behalf of a classroom. The module and every target
 * are proven to live in that classroom before anything is written; the
 * type/target shape is then validated by `create`.
 */
export const createInClassroom = async (classroomId: string, input: AssignmentWriteInput) => {
  const prisma = getPrisma();
  // Prisma drops an undefined id from a `where`, which would turn this scoped
  // lookup into "any module in the classroom". Refuse up front.
  if (typeof input.module_id !== 'string' || !input.module_id) {
    throw new Error('A module is required');
  }
  const module = await prisma.module.findFirst({
    where: { id: input.module_id, classroom_id: classroomId },
    select: { id: true },
  });
  if (!module) throw new Error('Module not found in classroom');

  if (input.repository_id) {
    const repository = await prisma.repository.findFirst({
      where: { id: input.repository_id, classroom_id: classroomId },
      select: { id: true },
    });
    if (!repository) throw new Error('Repository not found in classroom');
  }
  if (input.quiz_id) {
    const quiz = await prisma.quiz.findFirst({
      where: { id: input.quiz_id, classroom_id: classroomId },
      select: { id: true },
    });
    if (!quiz) throw new Error('Quiz not found in classroom');
  }
  if (input.form_id) {
    const form = await prisma.form.findFirst({
      where: { id: input.form_id, classroom_id: classroomId },
      select: { id: true },
    });
    if (!form) throw new Error('Form not found in classroom');
  }

  return create({
    module_id: input.module_id,
    type: input.type,
    repository_id: input.repository_id ?? null,
    quiz_id: input.quiz_id ?? null,
    form_id: input.form_id ?? null,
    title: input.title,
    weight: input.weight,
    is_extra_credit: input.is_extra_credit ?? false,
    is_published: input.is_published ?? false,
    description: input.description ?? '',
    student_deadline: toDate(input.student_deadline) ?? null,
    grader_deadline: toDate(input.grader_deadline) ?? null,
    release_at: toDate(input.release_at) ?? null,
    tokens_per_hour: input.tokens_per_hour ?? 0,
    grades_released: input.grades_released ?? false,
  });
};

/**
 * Update an assignment the classroom owns. Type and target are immutable
 * (change the kind by deleting and recreating); everything else is editable.
 * Notifications fire exactly as they do for `update`.
 */
export const updateInClassroom = async (
  id: string,
  classroomId: string,
  input: Partial<Omit<AssignmentWriteInput, 'module_id' | 'type' | 'repository_id' | 'quiz_id' | 'form_id'>>
) => {
  const prisma = getPrisma();
  const previous = await prisma.assignment.findFirst({
    where: { id, module: { classroom_id: classroomId } },
    select: { id: true, student_deadline: true, grades_released: true },
  });
  if (!previous) throw new Error('Assignment not found in classroom');

  const data: Prisma.AssignmentUncheckedUpdateInput = {};
  if (input.title !== undefined) data.title = input.title;
  if (input.weight !== undefined) data.weight = Number(input.weight);
  if (input.is_extra_credit !== undefined) data.is_extra_credit = input.is_extra_credit;
  if (input.is_published !== undefined) data.is_published = input.is_published;
  if (input.description !== undefined) data.description = input.description;
  if (input.student_deadline !== undefined) data.student_deadline = toDate(input.student_deadline);
  if (input.grader_deadline !== undefined) data.grader_deadline = toDate(input.grader_deadline);
  if (input.release_at !== undefined) data.release_at = toDate(input.release_at);
  if (input.tokens_per_hour !== undefined) data.tokens_per_hour = input.tokens_per_hour;
  if (input.grades_released !== undefined) data.grades_released = input.grades_released;

  const updated = await prisma.assignment.update({
    where: { id },
    data,
    include: { module: true, repository: true, quiz: true, form: true },
  });

  await notifyAfterUpdate(id, data, previous, updated);

  return updated;
};

/** Delete an assignment the classroom owns. Submissions and grades cascade. */
export const deleteInClassroom = async (id: string, classroomId: string) => {
  const { count } = await getPrisma().assignment.deleteMany({
    where: { id, module: { classroom_id: classroomId } },
  });
  if (count !== 1) throw new Error('Assignment not found in classroom');
  return { id };
};

/**
 * Recipients of a grade-release notification: students/team members whose
 * GitRepoAssignment under this assignment has at least one grade row.
 */
const getGradedRecipientsForAssignment = async (assignmentId: string): Promise<string[]> => {
  const repos = await getPrisma().gitRepoAssignment.findMany({
    where: { assignment_id: assignmentId, grades: { some: {} } },
    select: {
      git_repo: {
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
    if (r.git_repo.student_id) userIds.add(r.git_repo.student_id);
    if (r.git_repo.team_id) teamIds.add(r.git_repo.team_id);
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
      module: true,
      repository: {
        include: {
          classroom: true,
        },
      },
      git_repo_assignments: {
        include: {
          grades: true,
          git_repo: {
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
    total: assignment.git_repo_assignments.length,
    graded: 0,
    ungraded: 0,
    open: 0,
    closed: 0,
  };

  for (const ra of assignment.git_repo_assignments) {
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
