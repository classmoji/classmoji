import getPrisma, { GIT_IDENTITY } from '@classmoji/database';
import { countingQuizAttempt, withLogins } from '@classmoji/utils';
import { normalizeExcludedPaths } from '@classmoji/utils/quiz-excluded-paths';
import type { Prisma, QuizGradingStrategy, QuizStatus, Role } from '@prisma/client';
import * as notificationService from './notification.service.ts';
import {
  SOURCE_MATERIAL_INCLUDE,
  setQuizSourceMaterial,
  sourceMaterialOf,
  type SourceMaterialRef,
} from './quizSourceMaterial.service.ts';

interface QuizCreateInput {
  name: string;
  classroomId: string;
  repositoryId?: string | null;
  systemPrompt?: string | null;
  rubricPrompt: string;
  subject?: string | null;
  difficultyLevel?: string | null;
  dueDate?: string | Date | null;
  status?: QuizStatus;
  weight?: string | number | null;
  questionCount?: string | number | null;
  includeCodeContext?: boolean;
  maxAttempts?: string | number | null;
  gradingStrategy?: QuizGradingStrategy;
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
  dueDate?: string | Date | null;
  status?: QuizStatus;
  weight?: string | number | null;
  questionCount?: string | number | null;
  includeCodeContext?: boolean;
  maxAttempts?: string | number | null;
  gradingStrategy?: QuizGradingStrategy;
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
 * What create hands back: the row with its repository and attempts, as before
 * (a new quiz has no attempts, so this is one join).
 */
const QUIZ_WRITE_INCLUDE = {
  repository: true,
  attempts: {
    include: {
      user: { include: GIT_IDENTITY },
    },
  },
} as const;

/**
 * Create a quiz, and its source material when given, in ONE transaction: an
 * unknown or foreign document id rolls the quiz back with it.
 */
export const create = async (data: QuizCreateInput) => {
  // Checked before the transaction opens: a bad list writes nothing.
  const excludedPaths =
    data.excludedPaths === undefined ? undefined : excludedPathsToStore(data.excludedPaths);
  return getPrisma().$transaction(async tx => {
    const quiz = await createQuizRow(tx, { ...data, excludedPaths });
    if (data.sourceMaterial !== undefined) {
      await setQuizSourceMaterial(tx, {
        quizId: quiz.id,
        classroomId: data.classroomId,
        material: data.sourceMaterial,
      });
    }
    return withLogins(
      await tx.quiz.findUniqueOrThrow({ where: { id: quiz.id }, include: QUIZ_WRITE_INCLUDE })
    );
  });
};

const createQuizRow = (tx: Prisma.TransactionClient, data: QuizCreateInput) =>
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
      due_date: data.dueDate ? new Date(data.dueDate) : null,
      status: data.status || 'DRAFT',
      weight: parseInt(String(data.weight ?? 0), 10) || 0,
      question_count: Math.min(20, Math.max(1, parseInt(String(data.questionCount ?? 5), 10) || 5)),
      include_code_context: data.includeCodeContext || false,
      max_attempts: data.maxAttempts !== undefined ? parseInt(String(data.maxAttempts), 10) : 1,
      grading_strategy: data.gradingStrategy || 'HIGHEST',
      course_search_enabled: data.courseSearchEnabled === true,
      ...(data.excludedPaths !== undefined ? { excluded_paths: data.excludedPaths } : {}),
    },
  });

export const update = async (quizId: string, data: QuizUpdateInput) => {
  const updateData: Prisma.QuizUpdateInput = {};

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
  if (data.dueDate !== undefined)
    updateData.due_date = data.dueDate ? new Date(data.dueDate) : null;
  if (data.status !== undefined) updateData.status = data.status;
  if (data.weight !== undefined) updateData.weight = parseInt(String(data.weight), 10);
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
  // and a bad id rolls the field changes back with it.
  //
  // Returns the quiz's own columns, which is all any caller reads (the MCP
  // quiz_update summary; the web action ignores it). Attempts and their users
  // are not loaded: an interactive transaction holds its connection and has a
  // time limit, and a long-running quiz can have hundreds of attempts.
  return getPrisma().$transaction(async tx => {
    // DRAFT → CLOSED is refused (see QuizStatusChangeError), read in the same
    // transaction as the write.
    if (data.status === 'CLOSED') {
      const current = await tx.quiz.findUnique({ where: { id: quizId }, select: { status: true } });
      if (current?.status === 'DRAFT') throw new QuizStatusChangeError(CLOSE_DRAFT_QUIZ_REFUSAL);
    }
    const quiz = await tx.quiz.update({ where: { id: quizId }, data: updateData });
    if (data.sourceMaterial !== undefined) {
      await setQuizSourceMaterial(tx, {
        quizId: quiz.id,
        classroomId: quiz.classroom_id,
        material: data.sourceMaterial,
      });
    }
    return quiz;
  });
};

const deleteQuiz = async (quizId: string) => {
  return getPrisma().quiz.delete({
    where: { id: quizId },
  });
};
export { deleteQuiz as delete };

/**
 * One quiz with its classroom, repository and attempts, plus `source_material`:
 * the linked pages and decks in material order, drafts included (a staff and
 * server-side read; the student list below filters drafts out).
 */
export const findById = async (quizId: string) => {
  const quiz = await getPrisma().quiz.findUnique({
    where: { id: quizId },
    include: {
      repository: true,
      classroom: true,
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
 * Published quizzes only by default. `includeClosed` adds CLOSED quizzes, which
 * take no new attempts from a student but stay visible, so a student keeps the
 * quiz they finished and its score; the student quiz list asks for them.
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

  const quizzes = await getPrisma().quiz.findMany({
    where: {
      classroom_id: classroomId,
      status: includeClosed ? { in: ['PUBLISHED', 'CLOSED'] } : 'PUBLISHED',
    },
    include: {
      repository: true,
      // The quiz's assignment owns its due date where it has one.
      assignment: { select: { student_deadline: true } },
      attempts: {
        where: { user_id: userId },
        orderBy: { started_at: 'desc' }, // Most recent first
        select: STUDENT_ATTEMPT_SELECT,
      },
      ...SOURCE_MATERIAL_INCLUDE,
    },
    orderBy: { created_at: 'desc' },
  });

  // Add attempt metadata for each quiz
  return quizzes.map(({ page_links, slide_links, ...quiz }) => {
    const attempts = quiz.attempts || [];
    const attemptCount = attempts.length;
    const maxAttempts = quiz.max_attempts ?? 1;
    const hasUnlimitedAttempts = maxAttempts === 0;

    // Check if user can create new attempts. Staff preview quizzes repeatedly,
    // so they are not held to max_attempts — TEACHER included, or a teacher
    // would be locked out of their own quiz after one preview. A student
    // starts attempts on a PUBLISHED quiz only, as the start gate requires.
    const isInstructor = (QUIZ_STAFF_ROLES as readonly string[]).includes(membership.role);
    const canCreateNew =
      isInstructor ||
      (quiz.status === 'PUBLISHED' && (hasUnlimitedAttempts || attemptCount < maxAttempts));

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

export const publish = async (quizId: string) => {
  const previous = await getPrisma().quiz.findUnique({
    where: { id: quizId },
    select: { status: true },
  });
  const quiz = await getPrisma().quiz.update({
    where: { id: quizId },
    data: { status: 'PUBLISHED' },
  });
  if (previous && previous.status !== 'PUBLISHED') {
    await notificationService.runSafely('quiz publish notification', async () => {
      const studentIds = await notificationService.getStudentsInClassroom(quiz.classroom_id);
      await notificationService.createNotifications({
        type: 'QUIZ_PUBLISHED',
        classroomId: quiz.classroom_id,
        recipientUserIds: studentIds,
        resourceType: 'quiz',
        resourceId: quiz.id,
        title: `Quiz published: ${quiz.name}`,
      });
    });
  }
  return quiz;
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

export const getStatsByClassroom = async (classroomId: string) => {
  return getQuizStatsByOrganization(classroomId);
};

export const getQuizStatsByOrganization = async (classroomId: string) => {
  const quizzes = await getPrisma().quiz.findMany({
    where: { classroom_id: classroomId },
    include: {
      _count: {
        select: { attempts: true },
      },
      attempts: {
        where: { completed_at: { not: null } },
        select: { score: true, partial_credit_percentage: true },
      },
    },
  });

  const stats: {
    totalQuizzes: number;
    publishedCount: number;
    draftCount: number;
    archivedCount: number;
    totalWeight: number;
    totalAttempts: number;
    averageScore: number | null;
  } = {
    totalQuizzes: quizzes.length,
    publishedCount: quizzes.filter(q => (q.status as string) === 'PUBLISHED').length,
    draftCount: quizzes.filter(q => (q.status as string) === 'DRAFT').length,
    archivedCount: quizzes.filter(q => (q.status as string) === 'ARCHIVED').length,
    totalWeight: quizzes
      .filter(q => (q.status as string) !== 'ARCHIVED')
      .reduce((sum, q) => sum + (q.weight || 0), 0),
    totalAttempts: quizzes.reduce((sum, q) => sum + q._count.attempts, 0),
    averageScore: null,
  };

  // Calculate overall average score
  const allScores = quizzes
    .flatMap(q => q.attempts.map(a => a.score ?? a.partial_credit_percentage))
    .filter((s): s is number => s !== null && s !== undefined);
  if (allScores.length > 0) {
    stats.averageScore = Math.round(allScores.reduce((sum, s) => sum + s, 0) / allScores.length);
  }

  return stats;
};

// Aliases for consistent naming across services
export const createQuiz = create;
export const updateQuiz = update;
export const getQuizById = findById;
export const getQuizzesByClassroom = findByClassroom;
export const publishQuiz = publish;
export const getQuizStatsByClassroom = getStatsByClassroom;
