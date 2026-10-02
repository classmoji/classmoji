import getPrisma, { GIT_IDENTITY } from '@classmoji/database';
import {
  countingQuizAttempt,
  isClosed,
  isReleased,
  mirroredQuizStatus,
  mirroredQuizWeight,
  withLogins,
} from '@classmoji/utils';
import { normalizeExcludedPaths } from '@classmoji/utils/quiz-excluded-paths';
import type { Prisma, QuizGradingStrategy, QuizStatus, Role } from '@prisma/client';
import * as assignmentService from './assignment.service.ts';
import {
  MODULE_REQUIRED_MESSAGE,
  QUIZ_ASSIGNMENT_SELECT,
  QuizAssignmentError,
  mirrorQuizFromAssignment,
  notifyQuizPublished,
  setQuizAssignmentPublished,
  type QuizAssignmentRow,
} from './quizAssignment.service.ts';
import {
  SOURCE_MATERIAL_INCLUDE,
  setQuizSourceMaterial,
  sourceMaterialOf,
  type SourceMaterialRef,
} from './quizSourceMaterial.service.ts';

export { QuizAssignmentError } from './quizAssignment.service.ts';

/**
 * A quiz's place in the course, as the quiz form's Assignment panel writes
 * it. Each field is optional on an update (absent = unchanged); `moduleId` is
 * required to create a quiz. Dates take an ISO string, a Date, or null to
 * clear; `weight` and `tokensPerHour` are numbers of 0 or more.
 */
export interface QuizAssignmentInput {
  moduleId?: string | null;
  /** Opens: students see the quiz from then on. Null = when published. */
  releaseAt?: string | Date | null;
  dueDate?: string | Date | null;
  /** Closes: no new attempt from then on. Null = never closes. */
  closesAt?: string | Date | null;
  weight?: string | number | null;
  tokensPerHour?: string | number | null;
  isPublished?: boolean;
}

interface QuizCreateInput {
  name: string;
  classroomId: string;
  repositoryId?: string | null;
  systemPrompt?: string | null;
  rubricPrompt: string;
  subject?: string | null;
  difficultyLevel?: string | null;
  /** Old shape, routed to the assignment's due date. */
  dueDate?: string | Date | null;
  /** Old shape: DRAFT = unpublished, PUBLISHED = published, CLOSED = published and closed now. */
  status?: QuizStatus;
  /** Old shape, routed to the assignment's weight. */
  weight?: string | number | null;
  questionCount?: string | number | null;
  includeCodeContext?: boolean;
  maxAttempts?: string | number | null;
  gradingStrategy?: QuizGradingStrategy;
  /** The quiz's assignment; `moduleId` is required. */
  assignment?: QuizAssignmentInput;
  /**
   * The documents the quiz is about, ONE ordered list across pages and decks.
   * Absent leaves the material alone; a list replaces it (an empty list clears
   * it). Validated by setQuizSourceMaterial, in the quiz's own transaction.
   */
  sourceMaterial?: SourceMaterialRef[];
  /** Let the quiz agent search the whole course, not only the linked material. */
  courseSearchEnabled?: boolean;
  /**
   * "Paths to exclude" for a code-aware quiz: glob patterns relative to the
   * repository root, like .gitignore lines. Absent saves none; checked by
   * `normalizeExcludedPaths` (a bad list throws `QuizExcludedPathsError`).
   */
  excludedPaths?: string[];
}

interface QuizUpdateInput {
  name?: string;
  repositoryId?: string | null;
  systemPrompt?: string | null;
  rubricPrompt?: string;
  subject?: string | null;
  difficultyLevel?: string | null;
  /** Old shapes, as on QuizCreateInput: routed to the assignment when there is one. */
  dueDate?: string | Date | null;
  status?: QuizStatus;
  weight?: string | number | null;
  questionCount?: string | number | null;
  includeCodeContext?: boolean;
  maxAttempts?: string | number | null;
  gradingStrategy?: QuizGradingStrategy;
  /**
   * Assignment changes. A quiz with no assignment yet gets one when this
   * names a module; without a module, assignment fields are refused.
   */
  assignment?: QuizAssignmentInput;
  /** As on QuizCreateInput: absent = unchanged, a list replaces the material. */
  sourceMaterial?: SourceMaterialRef[];
  courseSearchEnabled?: boolean;
  /** As on QuizCreateInput: absent = unchanged, a list replaces them (empty clears). */
  excludedPaths?: string[];
}

interface QuizMembership {
  role: Role;
  classroom_id?: string | null;
  user_id?: string | null;
  userId?: string | null;
}

/**
 * Roles that may read the staff view of a classroom's quizzes — the whole
 * teaching team, matching the route gates on /admin, /teacher and /assistant
 * quizzes and the MCP QUIZ_ROLES set. Kept as a named constant rather than an
 * inline array so a future role addition has one place to land.
 */
export const QUIZ_STAFF_ROLES = ['OWNER', 'TEACHER', 'ASSISTANT'] as const;

/**
 * Roles that may read the STUDENT view of a classroom's quizzes: students, plus
 * the teaching team previewing what a student sees. Matches the gate on the
 * student quizzes route, which every prefix's modules tree links into.
 */
export const QUIZ_STUDENT_VIEW_ROLES = ['STUDENT', ...QUIZ_STAFF_ROLES] as const;

/**
 * Thrown when the caller's membership does not entitle them to the staff quiz
 * list.
 *
 * A TYPED error rather than a bare `Error` on purpose: callers cannot tell an
 * authorization refusal from a genuine fault in a plain `Error`, so a role gap
 * here surfaced to the user as a 500 rather than a 403 — which is exactly how
 * the TEACHER gap in this function stayed invisible. `status` lets a route map
 * it without string-matching the message, and `code` lets MCP tools branch on
 * the reason the same way they do for StaffServiceError.
 */
export class QuizAccessError extends Error {
  code: 'membership_required' | 'role_not_allowed' | 'classroom_mismatch';
  /** HTTP status a web caller should surface. Always a refusal, never a fault. */
  status = 403;

  constructor(code: QuizAccessError['code'], message: string) {
    super(message);
    this.name = 'QuizAccessError';
    this.code = code;
  }
}

/**
 * A quiz's "Paths to exclude" that cannot be saved (empty, absolute, "..",
 * too many, ...). `message` says which pattern and why, in words the quiz form
 * and the MCP tools show as is; nothing has been written.
 */
export class QuizExcludedPathsError extends Error {
  code = 'invalid_excluded_paths' as const;
  /** HTTP status a web caller should answer with. */
  status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'QuizExcludedPathsError';
  }
}

/**
 * quiz.update refuses a status change it cannot make: a DRAFT quiz cannot be
 * CLOSED, because a closed quiz stays visible to students and a draft has
 * never been published to them. Publish it first.
 */
export class QuizStatusChangeError extends Error {
  code = 'invalid_status_change' as const;
  /** HTTP status a web caller should answer with. */
  status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'QuizStatusChangeError';
  }
}

export const CLOSE_DRAFT_QUIZ_REFUSAL = 'Publish the quiz before closing it';

/** The list to store, checked; throws `QuizExcludedPathsError` for a bad one. */
function excludedPathsToStore(input: unknown): string[] {
  const result = normalizeExcludedPaths(input);
  if (!result.ok) throw new QuizExcludedPathsError(result.error);
  return result.value;
}

/**
 * What create hands back: the row with its repository, attempts and
 * assignment (a new quiz has no attempts, so that is one join).
 */
const QUIZ_WRITE_INCLUDE = {
  repository: true,
  assignment: { include: { module: { select: { id: true, title: true } } } },
  attempts: {
    include: {
      user: { include: GIT_IDENTITY },
    },
  },
} as const;

type Tx = Prisma.TransactionClient;

/** A date field of the panel: undefined = unchanged, null or '' = cleared. */
const dateInput = (label: string, value: string | Date | null | undefined) => {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new QuizAssignmentError('invalid_value', `${label} is not a date`);
  }
  return date;
};

/** A count field of the panel: undefined = unchanged, null or '' = 0. */
const countInput = (
  label: string,
  value: string | number | null | undefined,
  { integer }: { integer: boolean }
) => {
  if (value === undefined) return undefined;
  if (value === null || value === '') return 0;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || (integer && !Number.isInteger(number))) {
    throw new QuizAssignmentError(
      'invalid_value',
      `${label} must be ${integer ? 'a whole number' : 'a number'} of 0 or more`
    );
  }
  return number;
};

/** The assignment columns a save changes, after the inputs are checked. */
interface AssignmentChanges {
  moduleId?: string;
  release_at?: Date | null;
  student_deadline?: Date | null;
  closes_at?: Date | null;
  weight?: number;
  tokens_per_hour?: number;
  is_published?: boolean;
}

/**
 * What a save asks of the quiz's assignment: the `assignment` object, with
 * the old flat fields folded in where the object does not name the same
 * thing (`dueDate` → due, `weight` → weight, `status` → published, and
 * CLOSED also closes now). Throws QuizAssignmentError on a bad value.
 */
const assignmentChangesOf = (
  data: Pick<QuizUpdateInput, 'assignment' | 'dueDate' | 'weight' | 'status'>,
  now: Date
): AssignmentChanges => {
  const input = data.assignment ?? {};
  const changes: AssignmentChanges = {};
  if (typeof input.moduleId === 'string' && input.moduleId) changes.moduleId = input.moduleId;
  const releaseAt = dateInput('Opens', input.releaseAt);
  if (releaseAt !== undefined) changes.release_at = releaseAt;
  const due = dateInput('Due', input.dueDate !== undefined ? input.dueDate : data.dueDate);
  if (due !== undefined) changes.student_deadline = due;
  const closes = dateInput('Closes', input.closesAt);
  if (closes !== undefined) changes.closes_at = closes;
  const weight = countInput('Weight', input.weight !== undefined ? input.weight : data.weight, {
    integer: false,
  });
  if (weight !== undefined) changes.weight = weight;
  const tokensPerHour = countInput('Tokens per hour', input.tokensPerHour, { integer: true });
  if (tokensPerHour !== undefined) changes.tokens_per_hour = tokensPerHour;
  if (input.isPublished !== undefined) changes.is_published = input.isPublished === true;
  else if (data.status !== undefined) changes.is_published = data.status !== 'DRAFT';
  if (data.status === 'CLOSED' && changes.closes_at === undefined) changes.closes_at = now;
  return changes;
};

/** Whether the save names any assignment field in the new shape. */
const namesAssignmentFields = (input: QuizAssignmentInput | undefined) =>
  !!input && Object.values(input).some(value => value !== undefined);

/** The module, if it is in the quiz's classroom; refused otherwise. */
const requireModuleInClassroom = async (tx: Tx, moduleId: string, classroomId: string) => {
  const module = await tx.module.findFirst({
    where: { id: moduleId, classroom_id: classroomId },
    select: { id: true },
  });
  if (!module) {
    throw new QuizAssignmentError('module_not_found', 'Module not found in this classroom', 404);
  }
};

/**
 * Create a quiz and its assignment, and its source material when given, in
 * ONE transaction: a module from another classroom, or an unknown or foreign
 * document id, rolls everything back. The quiz's due date, weight and status
 * are written as a mirror of the assignment. A quiz created published tells
 * the class once it has committed.
 */
export const create = async (data: QuizCreateInput) => {
  // Checked before the transaction opens: a bad value writes nothing.
  const excludedPaths =
    data.excludedPaths === undefined ? undefined : excludedPathsToStore(data.excludedPaths);
  const now = new Date();
  const changes = assignmentChangesOf(data, now);
  const moduleId = changes.moduleId;
  if (!moduleId) throw new QuizAssignmentError('module_required', MODULE_REQUIRED_MESSAGE);

  const { quizId, assignment } = await getPrisma().$transaction(async tx => {
    await requireModuleInClassroom(tx, moduleId, data.classroomId);
    const schedule = {
      is_published: changes.is_published ?? false,
      closes_at: changes.closes_at ?? null,
      student_deadline: changes.student_deadline ?? null,
      weight: changes.weight ?? 0,
    };
    const quiz = await createQuizRow(
      tx,
      { ...data, excludedPaths },
      {
        due_date: schedule.student_deadline,
        weight: mirroredQuizWeight(schedule.weight),
        status: mirroredQuizStatus(schedule, now),
      }
    );
    const assignment = await assignmentService.createInTx(tx, {
      module_id: moduleId,
      type: 'QUIZ',
      quiz_id: quiz.id,
      title: data.name,
      weight: schedule.weight,
      is_published: schedule.is_published,
      student_deadline: schedule.student_deadline,
      release_at: changes.release_at ?? null,
      closes_at: schedule.closes_at,
      tokens_per_hour: changes.tokens_per_hour ?? 0,
    });
    if (data.sourceMaterial !== undefined) {
      await setQuizSourceMaterial(tx, {
        quizId: quiz.id,
        classroomId: data.classroomId,
        material: data.sourceMaterial,
      });
    }
    return { quizId: quiz.id, assignment };
  });

  if (assignment.is_published) await notifyQuizPublished(assignment, now);

  return withLogins(
    await getPrisma().quiz.findUniqueOrThrow({ where: { id: quizId }, include: QUIZ_WRITE_INCLUDE })
  );
};

/** The quiz's own columns; due date, weight and status come from the assignment. */
const createQuizRow = (
  tx: Prisma.TransactionClient,
  data: QuizCreateInput,
  mirror: { due_date: Date | null; weight: number; status: QuizStatus }
) =>
  tx.quiz.create({
    select: { id: true },
    data: {
      name: data.name,
      classroom_id: data.classroomId,
      repository_id: data.repositoryId || null,
      system_prompt: data.systemPrompt || null,
      rubric_prompt: data.rubricPrompt,
      subject: data.subject || null,
      difficulty_level: data.difficultyLevel || null,
      ...mirror,
      question_count: Math.min(20, Math.max(1, parseInt(String(data.questionCount ?? 5), 10) || 5)),
      include_code_context: data.includeCodeContext || false,
      max_attempts: data.maxAttempts !== undefined ? parseInt(String(data.maxAttempts), 10) : 1,
      grading_strategy: data.gradingStrategy || 'HIGHEST',
      course_search_enabled: data.courseSearchEnabled === true,
      ...(data.excludedPaths !== undefined ? { excluded_paths: data.excludedPaths } : {}),
    },
  });

/** The module-move refusals of assignment.moveToModuleEndTx, as quiz refusals. */
const translateMoveError = (error: unknown): never => {
  if (error instanceof Error && error.message === 'Module not found in classroom') {
    throw new QuizAssignmentError('module_not_found', 'Module not found in this classroom', 404);
  }
  throw error;
};

/**
 * Update a quiz and, when the save names any, its assignment, in ONE
 * transaction.
 *
 * - Content fields (name, prompts, questions, source material, excluded
 *   paths) are the quiz's. A new name renames the assignment too.
 * - Assignment fields go to the quiz's assignment, and the quiz's due date,
 *   weight and status are mirrored from it. A module change moves the
 *   assignment to the end of the new module (refused for a module outside the
 *   quiz's classroom).
 * - A quiz with no assignment gets one when the save names a module; its
 *   current due date, weight and publish state carry over unless the save
 *   says otherwise (a CLOSED quiz closes at its last update). Without a
 *   module, the old flat fields still write the quiz's own columns, as
 *   before; new-shape assignment fields are refused.
 *
 * Notifications (published, due date changed) go out after the commit.
 */
export const update = async (quizId: string, data: QuizUpdateInput) => {
  const updateData: Prisma.QuizUpdateInput = {};
  const now = new Date();
  const changes = assignmentChangesOf(data, now);

  if (data.name !== undefined) updateData.name = data.name;
  if (data.repositoryId !== undefined) {
    // Use relation syntax for updating repository
    if (data.repositoryId === null) {
      updateData.repository = { disconnect: true };
    } else {
      updateData.repository = { connect: { id: data.repositoryId } };
    }
  }
  if (data.systemPrompt !== undefined) updateData.system_prompt = data.systemPrompt;
  if (data.rubricPrompt !== undefined) updateData.rubric_prompt = data.rubricPrompt;
  if (data.subject !== undefined) updateData.subject = data.subject;
  if (data.difficultyLevel !== undefined) updateData.difficulty_level = data.difficultyLevel;
  if (data.questionCount !== undefined)
    updateData.question_count = Math.min(
      20,
      Math.max(1, parseInt(String(data.questionCount), 10) || 5)
    );
  if (data.includeCodeContext !== undefined)
    updateData.include_code_context = data.includeCodeContext;
  if (data.maxAttempts !== undefined)
    updateData.max_attempts = parseInt(String(data.maxAttempts), 10);
  if (data.gradingStrategy !== undefined) updateData.grading_strategy = data.gradingStrategy;
  if (data.courseSearchEnabled !== undefined)
    updateData.course_search_enabled = data.courseSearchEnabled === true;
  if (data.excludedPaths !== undefined)
    updateData.excluded_paths = excludedPathsToStore(data.excludedPaths);

  // One transaction, as in create: the material is validated against the
  // quiz's own classroom (read back from the row, not taken from the caller),
  // and a bad id or module rolls every change back with it.
  //
  // Returns the quiz's own columns and its assignment, which is all any caller
  // reads (the MCP quiz_update summary; the web action ignores it). Attempts
  // and their users are not loaded: an interactive transaction holds its
  // connection and has a time limit, and a long-running quiz can have
  // hundreds of attempts.
  const result = await getPrisma().$transaction(async tx => {
    // The quiz's assignment row is locked before it is read, so two saves at
    // once see each other's result and a publish is announced once.
    await tx.$queryRaw`SELECT id FROM assignments WHERE quiz_id = ${quizId} FOR UPDATE`;
    const current = await tx.quiz.findUnique({
      where: { id: quizId },
      select: {
        classroom_id: true,
        status: true,
        weight: true,
        due_date: true,
        updated_at: true,
        assignment: { select: QUIZ_ASSIGNMENT_SELECT },
      },
    });
    if (!current) throw new QuizAssignmentError('not_found', 'Quiz not found', 404);

    // DRAFT → CLOSED is refused (see QuizStatusChangeError), read in the same
    // transaction as the write.
    if (data.status === 'CLOSED') {
      const published = current.assignment
        ? current.assignment.is_published
        : current.status !== 'DRAFT';
      if (!published) throw new QuizStatusChangeError(CLOSE_DRAFT_QUIZ_REFUSAL);
    }

    let assignment: QuizAssignmentRow | null = current.assignment;
    let previous: { student_deadline: Date | null; is_published: boolean } | null = assignment && {
      student_deadline: assignment.student_deadline,
      is_published: assignment.is_published,
    };

    // An unassigned quiz saved without a module keeps the old behaviour for
    // the old flat fields; the new assignment fields need a module.
    if (!assignment && !changes.moduleId) {
      if (namesAssignmentFields(data.assignment)) {
        throw new QuizAssignmentError('module_required', MODULE_REQUIRED_MESSAGE);
      }
      if (data.dueDate !== undefined) updateData.due_date = changes.student_deadline ?? null;
      if (data.status !== undefined) updateData.status = data.status;
      if (data.weight !== undefined) updateData.weight = mirroredQuizWeight(changes.weight ?? 0);
    }

    const quiz = await tx.quiz.update({ where: { id: quizId }, data: updateData });

    if (assignment) {
      const assignmentData: Prisma.AssignmentUncheckedUpdateInput = {};
      if (data.name !== undefined) assignmentData.title = data.name;
      if (changes.release_at !== undefined) assignmentData.release_at = changes.release_at;
      if (changes.student_deadline !== undefined) {
        assignmentData.student_deadline = changes.student_deadline;
      }
      if (changes.closes_at !== undefined) assignmentData.closes_at = changes.closes_at;
      // The old "PUBLISHED" reopened a closed quiz; it still does.
      if (
        data.status === 'PUBLISHED' &&
        changes.closes_at === undefined &&
        isClosed(assignment.closes_at, now)
      ) {
        assignmentData.closes_at = null;
      }
      if (changes.weight !== undefined) assignmentData.weight = changes.weight;
      if (changes.tokens_per_hour !== undefined) {
        assignmentData.tokens_per_hour = changes.tokens_per_hour;
      }
      if (changes.is_published !== undefined) assignmentData.is_published = changes.is_published;

      const moves = Boolean(changes.moduleId && changes.moduleId !== assignment.module_id);
      if (moves) {
        await assignmentService
          .moveToModuleEndTx(tx, assignment.id, changes.moduleId!, quiz.classroom_id)
          .catch(translateMoveError);
      }
      // A content-only save leaves the assignment (and the mirror) alone.
      if (moves || Object.keys(assignmentData).length > 0) {
        assignment = await tx.assignment.update({
          where: { id: assignment.id },
          data: assignmentData,
          select: QUIZ_ASSIGNMENT_SELECT,
        });
        await mirrorQuizFromAssignment(tx, assignment, now);
      }
    } else if (changes.moduleId) {
      // First module for a quiz that had none: what it had carries over.
      await requireModuleInClassroom(tx, changes.moduleId, quiz.classroom_id);
      const wasPublished = current.status !== 'DRAFT';
      const created = await assignmentService.createInTx(tx, {
        module_id: changes.moduleId,
        type: 'QUIZ',
        quiz_id: quiz.id,
        title: quiz.name,
        weight: changes.weight ?? current.weight,
        is_published: changes.is_published ?? wasPublished,
        student_deadline:
          changes.student_deadline !== undefined ? changes.student_deadline : current.due_date,
        release_at: changes.release_at ?? null,
        closes_at:
          changes.closes_at !== undefined
            ? changes.closes_at
            : current.status === 'CLOSED'
              ? current.updated_at
              : null,
        tokens_per_hour: changes.tokens_per_hour ?? 0,
      });
      assignment = await tx.assignment.findUniqueOrThrow({
        where: { id: created.id },
        select: QUIZ_ASSIGNMENT_SELECT,
      });
      // Students already saw a published quiz, and its old due date: neither
      // is news.
      previous = { student_deadline: current.due_date, is_published: wasPublished };
      await mirrorQuizFromAssignment(tx, assignment, now);
    }

    if (data.sourceMaterial !== undefined) {
      await setQuizSourceMaterial(tx, {
        quizId: quiz.id,
        classroomId: quiz.classroom_id,
        material: data.sourceMaterial,
      });
    }
    const saved = await tx.quiz.findUniqueOrThrow({
      where: { id: quizId },
      include: { assignment: { include: { module: { select: { id: true, title: true } } } } },
    });
    return { saved, assignment, previous };
  });

  const { assignment, previous } = result;
  if (assignment && previous) {
    const notifyFields: Record<string, unknown> = {};
    if (changes.student_deadline !== undefined) {
      notifyFields.student_deadline = changes.student_deadline;
    }
    await assignmentService.notifyAfterUpdate(
      assignment.id,
      notifyFields,
      { ...previous, grades_released: false },
      { ...assignment, grades_released: false }
    );
  }
  return result.saved;
};

const deleteQuiz = async (quizId: string) => {
  return getPrisma().quiz.delete({
    where: { id: quizId },
  });
};
export { deleteQuiz as delete };

/**
 * One quiz with its classroom, repository, assignment and attempts, plus `source_material`:
 * the linked pages and decks in material order, drafts included (a staff and
 * server-side read; the student list below filters drafts out).
 */
export const findById = async (quizId: string) => {
  const quiz = await getPrisma().quiz.findUnique({
    where: { id: quizId },
    include: {
      repository: true,
      classroom: true,
      // Its place in the course: module, schedule, weight, published.
      assignment: { include: { module: { select: { id: true, title: true } } } },
      attempts: {
        include: {
          user: { include: GIT_IDENTITY },
        },
      },
      ...SOURCE_MATERIAL_INCLUDE,
    },
  });
  if (!quiz) return null;
  const { page_links: _pageLinks, slide_links: _slideLinks, ...rest } = quiz;
  return withLogins({ ...rest, source_material: sourceMaterialOf(quiz) });
};

export const findByClassroom = async (classroomId: string, membership: QuizMembership | null) => {
  return getQuizzesByOrganization(classroomId, membership);
};

export const getQuizzesByOrganization = async (
  classroomId: string,
  membership: QuizMembership | null
) => {
  if (!membership) {
    throw new QuizAccessError(
      'membership_required',
      'Membership required to access classroom quizzes'
    );
  }

  if (!(QUIZ_STAFF_ROLES as readonly string[]).includes(membership.role)) {
    throw new QuizAccessError(
      'role_not_allowed',
      `[quiz] ${membership.role} may not read the staff quiz list ` +
        `(expected one of ${QUIZ_STAFF_ROLES.join(', ')})`
    );
  }

  const membershipClassroomId = membership.classroom_id?.toString() ?? null;
  if (membershipClassroomId && membershipClassroomId !== classroomId.toString()) {
    throw new QuizAccessError('classroom_mismatch', 'Membership does not match classroom');
  }

  const quizzes = await getPrisma().quiz.findMany({
    where: { classroom_id: classroomId },
    include: {
      repository: true,
      // The quiz's assignment owns its module, schedule, weight and publish
      // state; a quiz with none is in no module.
      assignment: {
        select: {
          id: true,
          module_id: true,
          module: { select: { id: true, title: true } },
          release_at: true,
          student_deadline: true,
          closes_at: true,
          weight: true,
          tokens_per_hour: true,
          is_published: true,
        },
      },
      attempts: {
        include: {
          user: { include: GIT_IDENTITY },
        },
      },
      _count: {
        select: { attempts: true },
      },
      ...SOURCE_MATERIAL_INCLUDE,
    },
    orderBy: { created_at: 'desc' },
  });

  // Calculate statistics for each quiz
  return withLogins(quizzes).map(({ page_links, slide_links, ...quiz }) => {
    const completedAttempts = quiz.attempts.filter(
      a => a.completed_at !== null && a.partial_credit_percentage !== null
    );
    const avgScore =
      completedAttempts.length > 0
        ? completedAttempts.reduce((sum, a) => sum + (a.partial_credit_percentage || 0), 0) /
          completedAttempts.length
        : null;

    return {
      ...quiz,
      // Staff list: drafts included, flagged by is_draft.
      source_material: sourceMaterialOf({
        classroom_id: quiz.classroom_id,
        page_links,
        slide_links,
      }),
      attemptsCount: quiz._count.attempts,
      avgScore: avgScore !== null ? Math.round(avgScore) : null,
    };
  });
};

/**
 * The attempt columns the student quiz list reads (its table, tab filters and
 * focus metrics) and the scoring below needs. Selected rather than spread:
 * an attempt row also carries the agent config, the session token and the
 * codebase path, none of which leave the server.
 */
const STUDENT_ATTEMPT_SELECT = {
  id: true,
  attempt_number: true,
  started_at: true,
  completed_at: true,
  score: true,
  feedback: true,
  session_status: true,
  questions_asked: true,
  last_activity: true,
  partial_credit_percentage: true,
  first_attempt_percentage: true,
  total_duration_ms: true,
  unfocused_duration_ms: true,
} as const;

/**
 * The quizzes a member sees on the student quiz list, with their own attempts.
 *
 * A quiz with an assignment is listed once the assignment is published and
 * its Opens date (`release_at`) has passed. A quiz with no assignment (in no
 * module) keeps the old rule: its own status is PUBLISHED. Closed quizzes —
 * past the assignment's close date, or a CLOSED quiz with no assignment —
 * take no new attempt from a student but stay visible when `includeClosed` is
 * set, so a student keeps the quiz they finished and its score; the student
 * quiz list asks for them. Each row carries `closed`.
 */
export const getQuizzesForStudent = async (
  classroomId: string,
  userId: string,
  membership: QuizMembership | null,
  { includeClosed = false }: { includeClosed?: boolean } = {}
) => {
  if (!membership) {
    throw new Error('Membership required to access student quizzes');
  }

  const membershipClassroomId = membership.classroom_id?.toString() ?? null;
  if (membershipClassroomId && membershipClassroomId !== classroomId.toString()) {
    throw new Error('Membership does not match classroom');
  }

  // Students plus the whole teaching team: staff open this list to preview a
  // quiz the way a student sees it, and the modules tree's quiz leaf lands
  // every role here. Same set as the route gate — when the two disagreed, the
  // route admitted a role the service then refused.
  if (!(QUIZ_STUDENT_VIEW_ROLES as readonly string[]).includes(membership.role)) {
    throw new QuizAccessError(
      'role_not_allowed',
      `[quiz] ${membership.role} may not read the student quiz list ` +
        `(expected one of ${QUIZ_STUDENT_VIEW_ROLES.join(', ')})`
    );
  }

  if (membership.role === 'STUDENT') {
    const membershipUserId = membership.user_id?.toString() ?? membership.userId?.toString();
    if (membershipUserId && membershipUserId !== userId.toString()) {
      throw new Error('Students may only access their own quizzes');
    }
  }

  const now = new Date();
  const listed = await getPrisma().quiz.findMany({
    where: {
      classroom_id: classroomId,
      OR: [
        {
          assignment: {
            is_published: true,
            OR: [{ release_at: null }, { release_at: { lte: now } }],
          },
        },
        {
          assignment: { is: null },
          status: includeClosed ? { in: ['PUBLISHED', 'CLOSED'] } : 'PUBLISHED',
        },
      ],
    },
    include: {
      repository: true,
      // The quiz's assignment owns its module, due date, schedule and weight
      // where it has one.
      assignment: {
        select: {
          id: true,
          module_id: true,
          module: { select: { id: true, title: true } },
          is_published: true,
          release_at: true,
          student_deadline: true,
          closes_at: true,
          weight: true,
        },
      },
      attempts: {
        where: { user_id: userId },
        orderBy: { started_at: 'desc' }, // Most recent first
        select: STUDENT_ATTEMPT_SELECT,
      },
      ...SOURCE_MATERIAL_INCLUDE,
    },
    orderBy: { created_at: 'desc' },
  });

  /** Past the assignment's close date, or (no assignment) a CLOSED quiz. */
  const closedOf = (quiz: { status: QuizStatus; assignment: { closes_at: Date | null } | null }) =>
    quiz.assignment ? isClosed(quiz.assignment.closes_at, now) : quiz.status === 'CLOSED';
  const quizzes = includeClosed ? listed : listed.filter(quiz => !closedOf(quiz));

  // Add attempt metadata for each quiz
  return quizzes.map(({ page_links, slide_links, ...quiz }) => {
    const attempts = quiz.attempts || [];
    const attemptCount = attempts.length;
    const maxAttempts = quiz.max_attempts ?? 1;
    const hasUnlimitedAttempts = maxAttempts === 0;

    // Check if user can create new attempts. Staff preview quizzes repeatedly,
    // so they are not held to max_attempts — TEACHER included, or a teacher
    // would be locked out of their own quiz after one preview. A student
    // starts attempts on an open quiz that has not closed, as the start gate
    // (quizAttempt.createNew) requires.
    const isInstructor = (QUIZ_STAFF_ROLES as readonly string[]).includes(membership.role);
    const closed = closedOf(quiz);
    const open = quiz.assignment
      ? quiz.assignment.is_published && isReleased(quiz.assignment.release_at, now)
      : quiz.status === 'PUBLISHED';
    const canCreateNew =
      isInstructor || (open && !closed && (hasUnlimitedAttempts || attemptCount < maxAttempts));

    // Process all attempts with metadata (without counting flag yet)
    const baseAttempts = attempts.map((attempt, index) => {
      const attemptNumber = attemptCount - index; // Reverse numbering (oldest = 1)
      const isCompleted = !!attempt.completed_at;

      // Calculate focus metrics
      let focusMetrics = null;
      const totalMs = attempt.total_duration_ms ?? null;
      const unfocusedMs = attempt.unfocused_duration_ms ?? null;
      if (totalMs !== null && unfocusedMs !== null) {
        const focusedMs = Math.max(0, totalMs - unfocusedMs);
        const percentage = totalMs > 0 ? Math.round((focusedMs / totalMs) * 100) : 100;
        focusMetrics = { totalMs, unfocusedMs, focusedMs, percentage };
      }

      const partialCreditScore =
        typeof attempt.partial_credit_percentage === 'number'
          ? attempt.partial_credit_percentage
          : null;
      const firstAttemptScore =
        typeof attempt.first_attempt_percentage === 'number'
          ? attempt.first_attempt_percentage
          : null;

      return {
        ...attempt,
        attemptNumber,
        status: isCompleted ? 'completed' : 'in_progress',
        focusMetrics,
        partialCreditScore,
        firstAttemptScore,
      };
    });

    const scoredAttempts = baseAttempts.filter(
      attempt => attempt.completed_at && attempt.partialCreditScore !== null
    );
    const bestScore =
      scoredAttempts.length > 0
        ? Math.max(...scoredAttempts.map(a => a.partialCreditScore ?? 0))
        : null;

    // The shared selector (@classmoji/utils quizScore), so this list, the
    // results page, the gradebook and the Assignments page agree.
    const counting = countingQuizAttempt(baseAttempts, quiz.grading_strategy);
    const countingAttemptId = counting?.id ?? null;
    const currentScore = counting?.partialCreditScore ?? null;

    const processedAttempts = baseAttempts.map(attempt => ({
      ...attempt,
      isCounting: attempt.id === countingAttemptId,
    }));

    return {
      ...quiz,
      closed,
      // The student view names published documents only.
      source_material: sourceMaterialOf(
        { classroom_id: quiz.classroom_id, page_links, slide_links },
        { publishedOnly: true }
      ),
      attemptCount,
      attempts: processedAttempts,
      attemptsSummary: {
        count: attemptCount,
        canCreateNew,
        bestScore,
        currentScore,
        countingAttemptId,
      },
    };
  });
};

/**
 * Publish a quiz: its assignment is published through the one quiz publish
 * function (assignment row locked, quiz mirrored, the class told once, and
 * only when the quiz is open now). A quiz with no module has no assignment
 * to publish and is refused. Returns the quiz row with `notified` (whether
 * the class was told) and `sourceMaterialAllDraft` (every linked document is
 * still a draft, so students cannot start it yet).
 */
export const publish = async (quizId: string) => {
  const quiz = await getPrisma().quiz.findUnique({
    where: { id: quizId },
    select: { assignment: { select: { id: true } } },
  });
  if (!quiz) throw new QuizAssignmentError('not_found', 'Quiz not found', 404);
  if (!quiz.assignment) {
    throw new QuizAssignmentError(
      'module_required',
      'Choose a module for this quiz before publishing it'
    );
  }
  const result = await setQuizAssignmentPublished(quiz.assignment.id, true);
  const row = await getPrisma().quiz.findUniqueOrThrow({
    where: { id: quizId },
    include: { assignment: { include: { module: { select: { id: true, title: true } } } } },
  });
  return {
    ...row,
    wasPublished: result.wasPublished,
    notified: result.notified,
    sourceMaterialAllDraft: result.sourceMaterialAllDraft,
  };
};

/**
 * Each quiz's grading strategy, by quiz id: what the counting-attempt selector
 * (`countingQuizAttempt` / `quizStanding` in @classmoji/utils) needs to know.
 * Ids that match no quiz are simply absent.
 */
export const findGradingStrategies = async (
  quizIds: string[]
): Promise<Record<string, QuizGradingStrategy>> => {
  if (quizIds.length === 0) return {};
  const quizzes = await getPrisma().quiz.findMany({
    where: { id: { in: quizIds } },
    select: { id: true, grading_strategy: true },
  });
  return Object.fromEntries(quizzes.map(q => [q.id, q.grading_strategy]));
};

// Aliases for consistent naming across services
export const createQuiz = create;
export const updateQuiz = update;
export const getQuizById = findById;
export const getQuizzesByClassroom = findByClassroom;
export const publishQuiz = publish;
