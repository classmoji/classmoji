/**
 * Assignment Service
 *
 * An Assignment is a gradable unit inside a Module. Its `type` says what it
 * points at: REPO (a GitHub issue in the repository's student repos, the only
 * kind that carries grades today), QUIZ, or FORM. `weight` is the only grading
 * weight in the system. Students work on GitRepoAssignments which track their
 * progress on REPO assignments.
 */
import getPrisma, { GIT_IDENTITY } from '@classmoji/database';
import { openToStudents, titleToIdentifier, withLogins } from '@classmoji/utils';
import type { AssignmentType, Prisma } from '@prisma/client';
import * as entitlementService from './entitlement.service.ts';
import * as notificationService from './notification.service.ts';
import {
  QUIZ_ASSIGNMENT_CREATE_REFUSAL,
  QUIZ_ASSIGNMENT_DELETE_REFUSAL,
  QuizAssignmentError,
  mirrorQuizFromAssignment,
  notifyQuizPublished,
  setQuizAssignmentPublished,
} from './quizAssignment.service.ts';

/** The Prisma client, or an interactive transaction's client. */
type Db = Prisma.TransactionClient;

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
  // Linked resources, so the edit modal can prefill them.
  pages: { select: { page: { select: { id: true } } } },
  slides: { select: { slide: { select: { id: true } } } },
  module: { select: { id: true, title: true, slug: true, position: true } },
  repository: {
    select: { id: true, title: true, slug: true, type: true, template: true, is_published: true },
  },
  // A quiz's schedule and publish state are this row's own columns.
  quiz: { select: { id: true, name: true } },
  form: { select: { id: true, title: true, slug: true, status: true } },
  _count: { select: { git_repo_assignments: true } },
} satisfies Prisma.AssignmentInclude;

const LIST_ORDER = [
  { module: { position: 'asc' } },
  // The order the Modules screen arranges by hand; deadline and title are the
  // tie-break for rows that have never been dragged.
  { position: 'asc' },
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

/**
 * One assignment, with the same module/target shape the lists carry, or null
 * when it is not in this classroom. Feeds the assignment page.
 */
export const findByIdInClassroom = async (id: string, classroomId: string) => {
  return getPrisma().assignment.findFirst({
    where: { id, module: { classroom_id: classroomId } },
    include: LIST_INCLUDE,
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

/**
 * Flip a repository's REPO assignments whose release date has passed to
 * published. For a self-formed group repository nothing provisions rows at
 * publish time (teams do not exist yet), so this is what releases them.
 */
export const publishReleased = async (repositoryId: string) => {
  return getPrisma().assignment.updateMany({
    where: {
      type: 'REPO',
      repository_id: repositoryId,
      is_published: false,
      release_at: { lte: new Date() },
    },
    data: { is_published: true },
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
 * CHECK so a caller gets a readable error instead of a constraint violation.
 * A repository is storage a REPO assignment points at, not a module member,
 * so assignments in different modules may share one repository.
 */
const validateTarget = async (data: Prisma.AssignmentUncheckedCreateInput, db: Db) => {
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
    const repository = await db.repository.findUnique({
      where: { id: targets.repository_id! },
      select: { id: true },
    });
    if (!repository) throw new Error('Repository not found');
  }
  return type;
};

/**
 * Where an assignment lands when nothing says otherwise: after the last one.
 * Takes a transaction's client so a write that creates the assignment with
 * something else (a quiz) reads the module in the same transaction.
 */
export const nextPositionInModule = async (moduleId: string, db: Db = getPrisma()) => {
  const last = await db.assignment.findFirst({
    where: { module_id: moduleId },
    orderBy: { position: 'desc' },
    select: { position: true },
  });
  return last ? last.position + 1 : 0;
};

/**
 * The weight to store. Only a missing weight takes the default: 0 is a real
 * weight (a practice quiz, an ungraded check-in) and is kept.
 */
const weightToStore = (weight: number | undefined | null) => Number(weight ?? 100);

const createWith = async (db: Db, data: Prisma.AssignmentUncheckedCreateInput) => {
  const type = await validateTarget(data, db);
  return db.assignment.create({
    data: {
      ...data,
      type,
      slug: titleToIdentifier(data.title),
      weight: weightToStore(data.weight),
      // Position 0 is the top of the module's list, so an assignment that does
      // not name one is appended instead of taking the column default.
      position: data.position ?? (await nextPositionInModule(data.module_id, db)),
    },
    include: {
      module: true,
      repository: true,
      quiz: true,
      form: true,
    },
  });
};

export const create = async (data: Prisma.AssignmentUncheckedCreateInput) =>
  createWith(getPrisma(), data);

/** `create` inside the caller's transaction (the quiz service creates a quiz and its assignment together). */
export const createInTx = (tx: Db, data: Prisma.AssignmentUncheckedCreateInput) =>
  createWith(tx, data);

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
      weight: weightToStore(a.weight),
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
  // One transaction: a QUIZ row's quiz is mirrored from the row as written
  // (read back, so any update shape the caller used is covered). The row is
  // locked before the previous values are read, so two writes at once see
  // each other's result and a publish is announced once.
  const { previous, updated } = await getPrisma().$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM assignments WHERE id = ${id} FOR UPDATE`;
    const previous = await tx.assignment.findUnique({
      where: { id },
      select: { student_deadline: true, grades_released: true, is_published: true },
    });
    const updated = await tx.assignment.update({
      where: { id },
      data: updates,
      include: {
        module: true,
        repository: true,
      },
    });
    if (updated.type === 'QUIZ') await mirrorQuizFromAssignment(tx, updated);
    return { previous, updated };
  });

  // Notifications only once the write has committed.
  await notifyAfterUpdate(id, updates, previous, updated);

  return updated;
};

type AssignmentNotificationSnapshot = {
  student_deadline: Date | null;
  grades_released: boolean;
  is_published: boolean;
};

/**
 * Due-date-changed and graded notifications, shared by every update path.
 * The classroom comes from the module, which every assignment has; the
 * repository is null for quiz/form assignments.
 *
 * A quiz assignment's due date change notifies nobody where the classroom's
 * quizzes are hidden (`entitlement.quizzesVisible`): no bell row, and so no
 * email, names a quiz there. Nor while the quiz is not open to students (a
 * draft, or before its Opens date): the notice names the quiz to every
 * student. Asked for QUIZ rows only; a failed lookup is caught by `runSafely`
 * and sends nothing. The graded branch needs no check: its recipients are
 * graded repository submissions, which a quiz never has.
 *
 * A QUIZ row that goes from unpublished to published tells the class through
 * the quiz publish notice (`notifyQuizPublished`), whichever path published it.
 */
export const notifyAfterUpdate = async (
  id: string,
  updates:
    | Prisma.AssignmentUpdateInput
    | Prisma.AssignmentUncheckedUpdateInput
    | Record<string, unknown>,
  previous: AssignmentNotificationSnapshot | null,
  updated: AssignmentNotificationSnapshot & {
    type: AssignmentType;
    title: string;
    quiz_id: string | null;
    module_id: string;
    release_at: Date | null;
    closes_at: Date | null;
    student_deadline: Date | null;
    weight: number;
    tokens_per_hour: number;
    module: { classroom_id: string };
  }
) => {
  const now = new Date();
  if (updated.type === 'QUIZ' && previous && !previous.is_published && updated.is_published) {
    await notifyQuizPublished({ ...updated, id }, now);
  }

  if ('student_deadline' in updates) {
    await notificationService.runSafely('assignment due date notification', async () => {
      const newDeadline = updated.student_deadline?.toISOString() ?? null;
      const oldDeadline = previous?.student_deadline?.toISOString() ?? null;
      if (newDeadline === oldDeadline) return;
      if (
        updated.type === 'QUIZ' &&
        (!(await entitlementService.quizzesVisible(updated.module.classroom_id)) ||
          !openToStudents(updated, now, { quizzesVisible: true }))
      ) {
        return;
      }
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
export type SubmissionModeInput = 'ISSUE' | 'REPO';

export interface AssignmentWriteInput {
  module_id: string;
  type: AssignmentTargetType;
  /** REPO assignments only: ISSUE (close an issue) or REPO (a push submits). */
  submission_mode?: SubmissionModeInput;
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
  /** QUIZ only: from then on no new attempt starts. Null = never closes. */
  closes_at?: Date | string | null;
  tokens_per_hour?: number;
  grades_released?: boolean;
  /** Pages / slide decks attached to the assignment; replaces the current set when given. */
  page_ids?: string[];
  slide_ids?: string[];
}

/**
 * Replace the pages / slide decks linked to an assignment. Links the caller
 * leaves out are removed; links already present are kept (no churn on the
 * `order` column).
 */
export const syncContentLinks = async (
  assignmentId: string,
  pageIds: string[] | undefined,
  slideIds: string[] | undefined,
  prisma: Db = getPrisma()
) => {
  if (pageIds) {
    const current = (
      await prisma.pageLink.findMany({
        where: { assignment_id: assignmentId },
        select: { page_id: true },
      })
    ).map(l => l.page_id);
    const toAdd = pageIds.filter(id => !current.includes(id));
    const toRemove = current.filter(id => !pageIds.includes(id));
    if (toAdd.length) {
      await prisma.pageLink.createMany({
        data: toAdd.map(page_id => ({ page_id, assignment_id: assignmentId })),
        skipDuplicates: true,
      });
    }
    if (toRemove.length) {
      await prisma.pageLink.deleteMany({
        where: { assignment_id: assignmentId, page_id: { in: toRemove } },
      });
    }
  }
  if (slideIds) {
    const current = (
      await prisma.slideLink.findMany({
        where: { assignment_id: assignmentId },
        select: { slide_id: true },
      })
    ).map(l => l.slide_id);
    const toAdd = slideIds.filter(id => !current.includes(id));
    const toRemove = current.filter(id => !slideIds.includes(id));
    if (toAdd.length) {
      await prisma.slideLink.createMany({
        data: toAdd.map(slide_id => ({ slide_id, assignment_id: assignmentId })),
        skipDuplicates: true,
      });
    }
    if (toRemove.length) {
      await prisma.slideLink.deleteMany({
        where: { assignment_id: assignmentId, slide_id: { in: toRemove } },
      });
    }
  }
};

const toDate = (value: Date | string | null | undefined): Date | null | undefined =>
  value === undefined ? undefined : value === null ? null : new Date(value);

/**
 * Create an assignment on behalf of a classroom. The module and every target
 * are proven to live in that classroom before anything is written; the
 * type/target shape is then validated by `create`.
 */
export const createInClassroom = async (classroomId: string, input: AssignmentWriteInput) => {
  const prisma = getPrisma();
  // A quiz's assignment is created with the quiz, by the quiz service, so the
  // two cannot disagree from the start.
  if (input.type === 'QUIZ') {
    throw new QuizAssignmentError('quiz_assignment', QUIZ_ASSIGNMENT_CREATE_REFUSAL);
  }
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

  const created = await create({
    module_id: input.module_id,
    type: input.type,
    submission_mode: input.type === 'REPO' ? (input.submission_mode ?? 'ISSUE') : 'ISSUE',
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
  await syncContentLinks(created.id, input.page_ids, input.slide_ids);
  return created;
};

/**
 * Update an assignment the classroom owns. Type and target are immutable
 * (change the kind by deleting and recreating); everything else is editable.
 * Notifications fire exactly as they do for `update`. On a QUIZ row the quiz
 * is mirrored in the same transaction (a new title renames the quiz).
 */
export const updateInClassroom = async (
  id: string,
  classroomId: string,
  input: Partial<
    Omit<AssignmentWriteInput, 'module_id' | 'type' | 'repository_id' | 'quiz_id' | 'form_id'>
  >
) => {
  const prisma = getPrisma();
  const previous = await prisma.assignment.findFirst({
    where: { id, module: { classroom_id: classroomId } },
    select: {
      id: true,
      type: true,
      submission_mode: true,
      student_deadline: true,
      grades_released: true,
      is_published: true,
      _count: { select: { git_repo_assignments: true } },
    },
  });
  if (!previous) throw new Error('Assignment not found in classroom');
  // Repositories have no close date (yet): nothing that serves a repo
  // assignment would read one.
  if (input.closes_at !== undefined && previous.type === 'REPO') {
    throw new Error('Repository assignments have no close date');
  }

  const data: Prisma.AssignmentUncheckedUpdateInput = {};
  // The mode may change only while no submission row exists: flipping it
  // afterwards would strand issues already opened, or rows that expect none.
  if (input.submission_mode !== undefined && input.submission_mode !== previous.submission_mode) {
    if (previous.type !== 'REPO') throw new Error('Only REPO assignments have a submission mode');
    if (previous._count.git_repo_assignments > 0) {
      throw new Error('Submission mode cannot change once students have submission rows');
    }
    data.submission_mode = input.submission_mode;
  }
  if (input.title !== undefined) data.title = input.title;
  if (input.weight !== undefined) data.weight = Number(input.weight);
  if (input.is_extra_credit !== undefined) data.is_extra_credit = input.is_extra_credit;
  if (input.is_published !== undefined) data.is_published = input.is_published;
  if (input.description !== undefined) data.description = input.description;
  if (input.student_deadline !== undefined) data.student_deadline = toDate(input.student_deadline);
  if (input.grader_deadline !== undefined) data.grader_deadline = toDate(input.grader_deadline);
  if (input.release_at !== undefined) data.release_at = toDate(input.release_at);
  if (input.closes_at !== undefined) data.closes_at = toDate(input.closes_at);
  if (input.tokens_per_hour !== undefined) data.tokens_per_hour = input.tokens_per_hour;
  if (input.grades_released !== undefined) data.grades_released = input.grades_released;

  const { before, updated } = await prisma.$transaction(async tx => {
    // Locked, then read again: the publish state and deadline the
    // notifications compare against are the ones this write replaced.
    await tx.$queryRaw`SELECT id FROM assignments WHERE id = ${id} FOR UPDATE`;
    const before = await tx.assignment.findUnique({
      where: { id },
      select: { student_deadline: true, grades_released: true, is_published: true },
    });
    const row = await tx.assignment.update({
      where: { id },
      data,
      include: { module: true, repository: true, quiz: true, form: true },
    });
    await syncContentLinks(id, input.page_ids, input.slide_ids, tx);
    if (row.type === 'QUIZ') await mirrorQuizFromAssignment(tx, row);
    return { before, updated: row };
  });

  await notifyAfterUpdate(id, data, before ?? previous, updated);

  return updated;
};

/** Delete an assignment the classroom owns. Submissions and grades cascade. */
/**
 * Persist a new ordering for one module's assignments. `orderedAssignmentIds`
 * is the full list in its new order; each row's position becomes its index.
 * The module is proven to belong to the classroom first, and the list has to
 * name every assignment in it — a partial list would leave the rest behind on
 * stale positions.
 */
export const reorderInModule = async (
  moduleId: string,
  orderedAssignmentIds: string[],
  classroomId: string
) =>
  getPrisma().$transaction(tx =>
    reorderInModuleTx(tx, moduleId, orderedAssignmentIds, classroomId)
  );

/** Whether `ordered` names exactly the ids in `existing`, each once. */
const sameIdSet = (existing: Iterable<string>, ordered: string[]) => {
  const existingIds = new Set(existing);
  const orderedIds = new Set(ordered);
  return (
    existingIds.size === ordered.length &&
    orderedIds.size === ordered.length &&
    ordered.every(id => existingIds.has(id))
  );
};

/** `reorderInModule` inside the caller's transaction. */
export const reorderInModuleTx = async (
  tx: Db,
  moduleId: string,
  orderedAssignmentIds: string[],
  classroomId: string
) => {
  const module = await tx.module.findFirst({
    where: { id: moduleId, classroom_id: classroomId },
    select: { id: true },
  });
  if (!module) throw new Error('Module not found in classroom');

  const existing = await tx.assignment.findMany({
    where: { module_id: moduleId },
    select: { id: true },
  });
  if (!sameIdSet(existing.map(a => a.id), orderedAssignmentIds)) {
    throw new Error('Ordered assignment ids must match the module assignments');
  }

  for (const [index, id] of orderedAssignmentIds.entries()) {
    await tx.assignment.update({
      where: { id, module_id: moduleId },
      data: { position: index },
    });
  }
};

/**
 * Move an assignment into `toModuleId` and give that module the ordering the
 * caller hands over. `orderedAssignmentIds` is the TARGET module's full list
 * after the move, the moved id included; the module it came from is compacted
 * behind it. Passing the module it is already in is a plain reorder.
 *
 * Only the module changes: weight, deadlines, grades and submissions travel
 * with the assignment, and the course grade is a weighted mean over all of
 * them, so which module holds it does not move any number.
 */
export const moveToModule = async (
  assignmentId: string,
  toModuleId: string,
  orderedAssignmentIds: string[],
  classroomId: string
) =>
  getPrisma().$transaction(tx =>
    moveToModuleTx(tx, assignmentId, toModuleId, orderedAssignmentIds, classroomId)
  );

/**
 * `moveToModule` inside the caller's transaction. Everything is checked
 * before anything is written (the target module is in the classroom, the
 * assignment is, and the ordering names exactly the target's assignments plus
 * the moved one), then the move, the target's order and the source's
 * compaction land together. Both module rows are locked in id order, as
 * `moveToModuleEnd` and `module.deleteById` lock them.
 */
export const moveToModuleTx = async (
  tx: Db,
  assignmentId: string,
  toModuleId: string,
  orderedAssignmentIds: string[],
  classroomId: string
) => {
  const target = await tx.module.findFirst({
    where: { id: toModuleId, classroom_id: classroomId },
    select: { id: true },
  });
  if (!target) throw new Error('Module not found in classroom');

  const assignment = await tx.assignment.findFirst({
    where: { id: assignmentId, module: { classroom_id: classroomId } },
    select: { id: true, module_id: true },
  });
  if (!assignment) throw new Error('Assignment not found in classroom');
  const fromModuleId = assignment.module_id;

  for (const moduleId of [...new Set([fromModuleId, toModuleId])].sort()) {
    await tx.$queryRaw`SELECT id FROM modules WHERE id = ${moduleId} FOR UPDATE`;
  }

  const targetRows = await tx.assignment.findMany({
    where: { module_id: toModuleId },
    select: { id: true },
  });
  const expected = new Set(targetRows.map(row => row.id));
  expected.add(assignmentId);
  if (!sameIdSet(expected, orderedAssignmentIds)) {
    throw new Error('Ordered assignment ids must match the module assignments');
  }

  if (fromModuleId !== toModuleId) {
    await tx.assignment.update({
      where: { id: assignmentId },
      data: { module_id: toModuleId },
    });
  }
  await reorderInModuleTx(tx, toModuleId, orderedAssignmentIds, classroomId);

  if (fromModuleId !== toModuleId) {
    const remaining = await tx.assignment.findMany({
      where: { module_id: fromModuleId },
      orderBy: { position: 'asc' },
      select: { id: true },
    });
    for (const [index, row] of remaining.entries()) {
      await tx.assignment.update({ where: { id: row.id }, data: { position: index } });
    }
  }
};

// One module's assignments in display order: the hand-arranged position, then
// the deadline and title tie-break rows that were never dragged fall back to.
const MODULE_ORDER = [
  { position: 'asc' },
  { student_deadline: { sort: 'asc', nulls: 'last' } },
  { title: 'asc' },
] satisfies Prisma.AssignmentOrderByWithRelationInput[];

/**
 * Move an assignment to the END of `toModuleId`, for a caller that holds no
 * ordering to hand over (the MCP's assignment_update; `moveToModule` is the
 * drag, which does). Returns whether anything moved and the module it left;
 * naming the module it is already in moves nothing.
 *
 * One transaction with both module rows locked, so several moves into the same
 * module at once (an agent placing a week's labs in parallel) each land on
 * their own position instead of reading the same list and colliding. The
 * target keeps its display order and is renumbered 0..n-1 with the moved row
 * at n; the module it left is compacted in display order behind it.
 *
 * Only the module changes: weight, deadlines, grades and submissions travel
 * with the assignment.
 */
export const moveToModuleEnd = async (
  assignmentId: string,
  toModuleId: string,
  classroomId: string
): Promise<{ moved: boolean; fromModuleId: string }> =>
  getPrisma().$transaction(tx => moveToModuleEndTx(tx, assignmentId, toModuleId, classroomId));

/**
 * `moveToModuleEnd` inside the caller's transaction: the quiz form moves a
 * quiz's assignment with the rest of the quiz save, so a refused move rolls
 * the whole save back.
 */
export const moveToModuleEndTx = async (
  tx: Db,
  assignmentId: string,
  toModuleId: string,
  classroomId: string
): Promise<{ moved: boolean; fromModuleId: string }> => {
  const target = await tx.module.findFirst({
    where: { id: toModuleId, classroom_id: classroomId },
    select: { id: true },
  });
  if (!target) throw new Error('Module not found in classroom');

  const scoped = { id: assignmentId, module: { classroom_id: classroomId } };
  const assignment = await tx.assignment.findFirst({
    where: scoped,
    select: { module_id: true },
  });
  if (!assignment) throw new Error('Assignment not found in classroom');

  const fromModuleId = assignment.module_id;
  if (fromModuleId === toModuleId) return { moved: false, fromModuleId };

  // Module rows are the lock, taken in id order so two moves in opposite
  // directions cannot deadlock. The assignment row itself is not locked
  // first: a concurrent move renumbering it would wait on that lock while
  // holding the module one.
  for (const moduleId of [fromModuleId, toModuleId].sort()) {
    await tx.$queryRaw`SELECT id FROM modules WHERE id = ${moduleId} FOR UPDATE`;
  }

  // Read again under the lock. The target may have been deleted while this
  // move waited (module.deleteById holds the same lock), and another move of
  // this same assignment may have finished.
  const targetNow = await tx.module.findUnique({
    where: { id: toModuleId },
    select: { id: true },
  });
  if (!targetNow) throw new Error('Module not found in classroom');
  const current = await tx.assignment.findFirst({ where: scoped, select: { module_id: true } });
  if (!current) throw new Error('Assignment not found in classroom');
  if (current.module_id === toModuleId) return { moved: false, fromModuleId };
  if (current.module_id !== fromModuleId) throw new Error('Assignment moved concurrently');

  const renumber = async (moduleId: string) => {
    const rows = await tx.assignment.findMany({
      where: { module_id: moduleId },
      orderBy: MODULE_ORDER,
      select: { id: true, position: true },
    });
    for (const [index, row] of rows.entries()) {
      if (row.position !== index) {
        await tx.assignment.update({ where: { id: row.id }, data: { position: index } });
      }
    }
    return rows.length;
  };

  const end = await renumber(toModuleId);
  await tx.assignment.update({
    where: { id: assignmentId },
    data: { module_id: toModuleId, position: end },
  });
  await renumber(fromModuleId);

  return { moved: true, fromModuleId };
};

/**
 * A quiz's assignment is not deleted on its own: deleting the quiz removes
 * it, and moving the quiz to another module moves it. (It would leave the
 * quiz in no module, counting for nothing, without anyone deciding that.)
 */
const refuseQuizAssignmentDelete = async (where: Prisma.AssignmentWhereInput) => {
  const row = await getPrisma().assignment.findFirst({ where, select: { type: true } });
  if (row?.type === 'QUIZ') {
    throw new QuizAssignmentError('quiz_assignment', QUIZ_ASSIGNMENT_DELETE_REFUSAL);
  }
};

export const deleteInClassroom = async (id: string, classroomId: string) => {
  await refuseQuizAssignmentDelete({ id, module: { classroom_id: classroomId } });
  const { count } = await getPrisma().assignment.deleteMany({
    where: { id, module: { classroom_id: classroomId }, type: { not: 'QUIZ' } },
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
  await refuseQuizAssignmentDelete({ id });
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
  // A quiz's assignment publishes through the one quiz publish function,
  // which mirrors the quiz and tells the class once.
  const row = await getPrisma().assignment.findUnique({ where: { id }, select: { type: true } });
  if (row?.type === 'QUIZ') {
    await setQuizAssignmentPublished(id, true);
    return getPrisma().assignment.findUniqueOrThrow({ where: { id } });
  }
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
              student: { include: GIT_IDENTITY },
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

  return withLogins({
    ...assignment,
    stats,
  });
};
