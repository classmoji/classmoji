/**
 * Quiz tools — quiz_create / quiz_update / quiz_publish / quiz_delete.
 *
 * ROUTE-DERIVED TIER: the web actions live in
 * apps/webapp/app/routes/admin.$class.quizzes/route.tsx, gated by
 * assertClassroomAccess with allowedRoles ['OWNER','TEACHER','ASSISTANT'] (S4
 * role parity), so these tools use QUIZ_STAFF.
 *
 * TWO EXTRA GATES run in-handler, because the registry pipeline (scope → rate
 * limit → role → mutation gate) does not know about them:
 *   1. Pro tier — the web action calls assertProTier before dispatching any
 *      quiz mutation. We call the SAME helper the quizzes read resource uses
 *      (resources/content.ts), so read and write cannot drift apart.
 *   2. quizzes_enabled — read from the request's already-resolved, sanitized
 *      classroom settings. The web app checks this in the LOADER only, not in
 *      the action; MCP is deliberately stricter, so a classroom that has turned
 *      quizzes off cannot be mutated through this surface either.
 *
 * Backbone: ClassmojiService.quiz.* — the same functions the web action calls.
 * quiz.publish is the ONLY path that notifies students (it reads the previous
 * status and fires QUIZ_PUBLISHED on a transition INTO published), which is why
 * quiz_update refuses to set PUBLISHED: a status flip through quiz.update would
 * publish the quiz silently.
 *
 * S1: every tool resolves its target through loadQuizInClassroom, comparing
 * quiz.classroom_id against ctx.classroom.classroomId; a missing quiz and
 * another classroom's quiz produce the identical scopedNotFound('Quiz').
 *
 * RESPONSES ARE ALLOW-LISTED: quiz.create/update return the row WITH
 * `attempts: { include: { user: true } }` — full student User rows. Never echo
 * a service return; every response here is built field-by-field by quizSummary.
 */

import { ClassmojiService } from '@classmoji/services';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolContext, ToolDefinition } from '../mcp/registry.ts';
import { assertProTier } from '../resources/content.ts';
import { sanitizedSettings } from '../resources/shape.ts';
import {
  loadQuizInClassroom,
  loadRepositoryInClassroom,
  ok,
  QUIZ_STAFF,
  requireClassroomCtx,
  writeAudit,
} from './shared.ts';

/**
 * The two quiz-surface gates the registry cannot apply, in the web's order:
 * Pro subscription, then the classroom's quizzes_enabled flag. Settings come
 * from the context the registry already resolved (getClassroomForUI's
 * SAFE_SETTINGS_FIELDS whitelist, which includes quizzes_enabled) — the same
 * values the quizzes read resource gates on, with no extra query.
 */
async function assertQuizSurfaceEnabled(ctx: ToolContext): Promise<void> {
  await assertProTier(requireClassroomCtx(ctx).classroomId);
  if (sanitizedSettings(ctx).quizzes_enabled === false) {
    throw new ToolError('forbidden', 'Quizzes are disabled for this classroom');
  }
}

/** Row shape the quiz service returns (only the fields we echo are named). */
interface QuizRow {
  id: string;
  name: string;
  status: string;
  classroom_id: string;
  repository_id?: string | null;
  system_prompt?: string | null;
  rubric_prompt?: string | null;
  subject?: string | null;
  difficulty_level?: string | null;
  due_date?: Date | string | null;
  weight?: number;
  question_count?: number;
  max_attempts?: number;
  grading_strategy?: string;
  include_code_context?: boolean;
}

/**
 * Explicit response allowlist — mirrors the staff shape of the quizzes read
 * resource. Never spread the service row: it carries every attempt with the
 * student User record attached.
 */
function quizSummary(quiz: QuizRow) {
  const dueDate = quiz.due_date;
  return {
    id: quiz.id,
    name: quiz.name,
    status: quiz.status,
    repository_id: quiz.repository_id ?? null,
    due_date: dueDate instanceof Date ? dueDate.toISOString() : (dueDate ?? null),
    weight: quiz.weight ?? 0,
    question_count: quiz.question_count ?? null,
    max_attempts: quiz.max_attempts ?? null,
    grading_strategy: quiz.grading_strategy ?? null,
    include_code_context: quiz.include_code_context ?? false,
    subject: quiz.subject ?? null,
    difficulty_level: quiz.difficulty_level ?? null,
    system_prompt: quiz.system_prompt ?? null,
    rubric_prompt: quiz.rubric_prompt ?? null,
  };
}

// ─── Shared field schemas (clamps mirror the service's own clamping) ────────

const questionCountSchema = z
  .number()
  .int()
  .min(1)
  .max(20)
  .describe('How many questions the AI asks in a session (1–20, default 5)');

const maxAttemptsSchema = z
  .number()
  .int()
  .min(0)
  .describe('Maximum attempts per student; 0 = unlimited (default 1)');

const weightSchema = z.number().int().min(0).max(100).describe('Grading weight (default 0)');

const gradingStrategySchema = z
  .enum(['HIGHEST', 'MOST_RECENT', 'FIRST'])
  .describe('Which attempt counts toward the grade (default HIGHEST)');

const dueDateSchema = z
  .string()
  .datetime({ offset: true })
  .describe('Due date (ISO 8601, e.g. 2026-07-20T23:59:00-04:00)');

interface QuizCreateArgs {
  classroom: string;
  name: string;
  rubric_prompt: string;
  repository_id?: string;
  system_prompt?: string;
  due_date?: string;
  weight?: number;
  question_count?: number;
  difficulty_level?: string;
  subject?: string;
  include_code_context?: boolean;
  grading_strategy?: 'HIGHEST' | 'MOST_RECENT' | 'FIRST';
  max_attempts?: number;
}

export const quizCreateTool: ToolDefinition<QuizCreateArgs> = {
  name: 'quiz_create',
  // Creates one row; nothing is removed and no external system is touched.
  annotations: { destructive: false, openWorld: false },
  title: 'Create a quiz',
  description:
    'Creates an AI-conversation quiz. There is NO stored question bank: the AI generates and ' +
    'asks questions live from rubric_prompt (required) and system_prompt, and question_count ' +
    'just tells it how many to ask. Set include_code_context to have it explore the student’s ' +
    'repository for the linked repo while questioning them. Owner/assistant only; requires a Pro ' +
    'subscription and quizzes enabled. ALWAYS created as a DRAFT (students see nothing) — use ' +
    'quiz_publish to go live and notify students.',
  scope: 'write',
  roles: QUIZ_STAFF,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    name: z.string().min(1).max(200).describe('Quiz name'),
    rubric_prompt: z
      .string()
      .min(1)
      .max(20000)
      .describe('Required. What the AI should ask about and how it should grade the answers'),
    system_prompt: z
      .string()
      .max(20000)
      .optional()
      .describe('Extra instructions steering the AI’s persona/behavior during the quiz'),
    repository_id: z
      .string()
      .uuid()
      .optional()
      .describe('Repo (assignment container) this quiz is about — required for code context'),
    due_date: dueDateSchema.optional(),
    weight: weightSchema.optional(),
    question_count: questionCountSchema.optional(),
    difficulty_level: z
      .string()
      .max(100)
      .optional()
      .describe("Free-text difficulty label (e.g. 'Beginner')"),
    subject: z.string().max(200).optional().describe('Free-text subject label'),
    include_code_context: z
      .boolean()
      .optional()
      .describe('Let the AI read the student’s repo for the linked repository (default false)'),
    grading_strategy: gradingStrategySchema.optional(),
    max_attempts: maxAttemptsSchema.optional(),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    await assertQuizSurfaceEnabled(ctx);

    // S1: the quiz row does not exist yet, so a supplied repository is verified
    // against the authorized classroom before it can be linked.
    let repositoryId: string | undefined;
    if (args.repository_id !== undefined) {
      repositoryId = (await loadRepositoryInClassroom(args.repository_id, ctx)).id;
    }

    // classroomId is ALWAYS the authorized classroom, never request input, and
    // status is pinned to DRAFT — publishing is quiz_publish's job because only
    // that path notifies students.
    const created = (await ClassmojiService.quiz.create({
      classroomId: classroom.classroomId,
      name: args.name,
      rubricPrompt: args.rubric_prompt,
      status: 'DRAFT',
      ...(repositoryId !== undefined ? { repositoryId } : {}),
      ...(args.system_prompt !== undefined ? { systemPrompt: args.system_prompt } : {}),
      ...(args.due_date !== undefined ? { dueDate: args.due_date } : {}),
      ...(args.weight !== undefined ? { weight: args.weight } : {}),
      ...(args.question_count !== undefined ? { questionCount: args.question_count } : {}),
      ...(args.difficulty_level !== undefined ? { difficultyLevel: args.difficulty_level } : {}),
      ...(args.subject !== undefined ? { subject: args.subject } : {}),
      ...(args.include_code_context !== undefined
        ? { includeCodeContext: args.include_code_context }
        : {}),
      ...(args.grading_strategy !== undefined ? { gradingStrategy: args.grading_strategy } : {}),
      ...(args.max_attempts !== undefined ? { maxAttempts: args.max_attempts } : {}),
    })) as QuizRow;

    await writeAudit(ctx, {
      resource_type: 'QUIZ',
      resource_id: created.id,
      action: 'CREATE',
      data: { tool: 'quiz_create', name: created.name, repository_id: repositoryId ?? null },
    });

    return ok({ success: true, quiz: quizSummary(created) });
  },
};

/**
 * The subset of the quiz service's update input these tools may write, in the
 * service's own camelCase vocabulary. Declaring it explicitly is what makes
 * "never forward caller args" checkable: an argument reaches the service only
 * by being copied into one of these named keys. `status` is narrowed to the two
 * values quiz_update accepts — PUBLISHED is reachable only via quiz.publish.
 */
interface QuizServiceUpdate {
  name?: string;
  repositoryId?: string | null;
  systemPrompt?: string;
  rubricPrompt?: string;
  subject?: string;
  difficultyLevel?: string;
  /** null clears the due date; the service maps a falsy value to null. */
  dueDate?: string | null;
  status?: 'DRAFT' | 'CLOSED';
  weight?: number;
  questionCount?: number;
  includeCodeContext?: boolean;
  maxAttempts?: number;
  gradingStrategy?: 'HIGHEST' | 'MOST_RECENT' | 'FIRST';
}

interface QuizUpdateArgs {
  classroom: string;
  quiz_id: string;
  name?: string;
  rubric_prompt?: string;
  system_prompt?: string;
  repository_id?: string | null;
  due_date?: string | null;
  status?: 'DRAFT' | 'CLOSED';
  weight?: number;
  question_count?: number;
  difficulty_level?: string;
  subject?: string;
  include_code_context?: boolean;
  grading_strategy?: 'HIGHEST' | 'MOST_RECENT' | 'FIRST';
  max_attempts?: number;
}

export const quizUpdateTool: ToolDefinition<QuizUpdateArgs> = {
  name: 'quiz_update',
  annotations: { destructive: false, openWorld: false },
  title: 'Update a quiz',
  description:
    'Updates a quiz’s settings and prompts. Owner/assistant only; requires a Pro subscription ' +
    'and quizzes enabled. Provide at least one field. status accepts only DRAFT (unpublish, ' +
    'hiding it from students again) or CLOSED (stop new attempts); publishing must go through ' +
    'quiz_publish, because only that path notifies students. Set repository_id to null to unlink ' +
    'the repo, or due_date to null to clear the deadline. Editing prompts does not re-grade ' +
    'attempts already taken.',
  scope: 'write',
  roles: QUIZ_STAFF,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    quiz_id: z.string().uuid().describe('Quiz id'),
    name: z.string().min(1).max(200).optional().describe('Quiz name'),
    rubric_prompt: z
      .string()
      .min(1)
      .max(20000)
      .optional()
      .describe('What the AI should ask about and how it should grade the answers'),
    system_prompt: z
      .string()
      .max(20000)
      .optional()
      .describe('Extra instructions steering the AI’s persona/behavior during the quiz'),
    repository_id: z
      .string()
      .uuid()
      .nullable()
      .optional()
      .describe('Repo (assignment container) this quiz is about; null unlinks it'),
    // Nullable here but not on quiz_create: an update has an existing value to
    // clear, and `set()` forwards null while it skips undefined.
    due_date: dueDateSchema.nullable().optional().describe('Due date (ISO 8601); null clears it'),
    status: z
      .enum(['DRAFT', 'CLOSED'])
      .optional()
      .describe('DRAFT unpublishes, CLOSED stops new attempts. To PUBLISH, use quiz_publish'),
    weight: weightSchema.optional(),
    question_count: questionCountSchema.optional(),
    difficulty_level: z.string().max(100).optional().describe('Free-text difficulty label'),
    subject: z.string().max(200).optional().describe('Free-text subject label'),
    include_code_context: z
      .boolean()
      .optional()
      .describe('Let the AI read the student’s repo for the linked repository'),
    grading_strategy: gradingStrategySchema.optional(),
    max_attempts: maxAttemptsSchema.optional(),
  },
  handler: async (args, ctx) => {
    await assertQuizSurfaceEnabled(ctx);

    // Explicit field-by-field mapping (snake_case tool args → the service's
    // camelCase input): nothing the caller sends is forwarded wholesale.
    const updates: QuizServiceUpdate = {};
    const fields: string[] = [];
    const set = <K extends keyof QuizServiceUpdate>(
      field: string,
      key: K,
      value: QuizServiceUpdate[K] | undefined
    ) => {
      if (value === undefined) return;
      updates[key] = value;
      fields.push(field);
    };
    set('name', 'name', args.name);
    set('rubric_prompt', 'rubricPrompt', args.rubric_prompt);
    set('system_prompt', 'systemPrompt', args.system_prompt);
    set('due_date', 'dueDate', args.due_date);
    set('status', 'status', args.status);
    set('weight', 'weight', args.weight);
    set('question_count', 'questionCount', args.question_count);
    set('difficulty_level', 'difficultyLevel', args.difficulty_level);
    set('subject', 'subject', args.subject);
    set('include_code_context', 'includeCodeContext', args.include_code_context);
    set('grading_strategy', 'gradingStrategy', args.grading_strategy);
    set('max_attempts', 'maxAttempts', args.max_attempts);
    if (args.repository_id !== undefined) fields.push('repository_id');

    if (fields.length === 0) {
      throw new ToolError('invalid_params', 'Provide at least one field to update');
    }

    // S1 before any write: the quiz must belong to the authorized classroom.
    const quiz = await loadQuizInClassroom(args.quiz_id, ctx);

    if (args.repository_id !== undefined) {
      // null disconnects; a value must first prove it lives in this classroom.
      updates.repositoryId =
        args.repository_id === null
          ? null
          : (await loadRepositoryInClassroom(args.repository_id, ctx)).id;
    }

    const updated = (await ClassmojiService.quiz.update(quiz.id, updates)) as QuizRow;

    await writeAudit(ctx, {
      resource_type: 'QUIZ',
      resource_id: quiz.id,
      action: 'UPDATE',
      data: { tool: 'quiz_update', fields },
    });

    return ok({ success: true, quiz: quizSummary(updated) });
  },
};

interface QuizPublishArgs {
  classroom: string;
  quiz_id: string;
}

export const quizPublishTool: ToolDefinition<QuizPublishArgs> = {
  name: 'quiz_publish',
  // Sets one status; republishing an already-published quiz changes nothing
  // (and notifies nobody a second time) → idempotent.
  annotations: { destructive: false, idempotent: true, openWorld: false },
  title: 'Publish a quiz',
  description:
    'Publishes a quiz so students can take it. Owner/assistant only; requires a Pro subscription ' +
    'and quizzes enabled. This is the ONLY path that notifies students — they get a "Quiz ' +
    'published" notification, but only on the transition INTO published, so republishing an ' +
    'already-published quiz notifies nobody. The response reports whether students were ' +
    'notified. Use quiz_update with status DRAFT to unpublish.',
  scope: 'write',
  roles: QUIZ_STAFF,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    quiz_id: z.string().uuid().describe('Quiz id'),
  },
  handler: async (args, ctx) => {
    await assertQuizSurfaceEnabled(ctx);
    const quiz = await loadQuizInClassroom(args.quiz_id, ctx);

    // Read the pre-publish status from the record we already loaded: the
    // service notifies only on a transition INTO published, and after the call
    // the row says PUBLISHED either way.
    const notified = quiz.status !== 'PUBLISHED';

    const published = (await ClassmojiService.quiz.publish(quiz.id)) as QuizRow;

    await writeAudit(ctx, {
      resource_type: 'QUIZ',
      resource_id: quiz.id,
      action: 'UPDATE',
      data: {
        tool: 'quiz_publish',
        previous_status: quiz.status,
        students_notified: notified,
      },
    });

    return ok({
      success: true,
      quiz: quizSummary(published),
      previous_status: quiz.status,
      students_notified: notified,
      message: notified
        ? 'Quiz published — students have been notified.'
        : 'Quiz was already published — nothing changed and no notifications were sent.',
    });
  },
};

interface QuizDeleteArgs {
  classroom: string;
  quiz_id: string;
  confirm: true;
}

export const quizDeleteTool: ToolDefinition<QuizDeleteArgs> = {
  name: 'quiz_delete',
  // Cascade-deletes every attempt → destructive, confirm-gated by the schema.
  annotations: { destructive: true, openWorld: false },
  title: 'Delete a quiz',
  description:
    'Permanently deletes a quiz. Owner/assistant only, destructive, requires confirm:true; ' +
    'requires a Pro subscription and quizzes enabled. THIS CANNOT BE UNDONE and cascades: every ' +
    'student attempt at this quiz — transcripts, scores, and focus metrics — is permanently ' +
    'deleted with it, and the quiz is removed from any curriculum module that lists it. To take ' +
    'a quiz out of circulation without losing student work, use quiz_update with status CLOSED.',
  scope: 'write',
  roles: QUIZ_STAFF,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    quiz_id: z.string().uuid().describe('Quiz id'),
    confirm: z
      .literal(true)
      .describe('Must be true — acknowledges that all student attempts are deleted with the quiz'),
  },
  handler: async (args, ctx) => {
    await assertQuizSurfaceEnabled(ctx);
    const quiz = await loadQuizInClassroom(args.quiz_id, ctx);
    // Blast-radius count for the audit trail (findById includes the attempts).
    const attemptsDeleted = (quiz as { attempts?: unknown[] }).attempts?.length ?? 0;

    await ClassmojiService.quiz.delete(quiz.id);

    await writeAudit(ctx, {
      resource_type: 'QUIZ',
      resource_id: quiz.id,
      action: 'DELETE',
      data: { tool: 'quiz_delete', name: quiz.name, attempts_deleted: attemptsDeleted },
    });

    return ok({
      success: true,
      deleted_quiz_id: quiz.id,
      name: quiz.name,
      attempts_deleted: attemptsDeleted,
    });
  },
};
