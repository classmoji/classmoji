/**
 * Quiz tools — quiz_create / quiz_update / quiz_publish / quiz_delete.
 *
 * ROLE TIERS (the rules in @classmoji/utils quizAssignment.ts, shared with the
 * web quiz actions in apps/webapp/app/routes/admin.$class.quizzes/route.tsx):
 *   - quiz_create, quiz_publish, quiz_delete: QUIZ_AUTHORS (OWNER, TEACHER,
 *     = QUIZ_AUTHOR_ROLES). A quiz's module, schedule, weight and publish
 *     state live on its QUIZ Assignment, which only its authors change.
 *   - quiz_update: QUIZ_STAFF (OWNER, TEACHER, ASSISTANT). An assistant may
 *     change a quiz's content and its name; a call carrying any assignment
 *     field (QUIZ_ASSIGNMENT_ARGS: module_id, release_at, due_date, closes_at,
 *     weight, tokens_per_hour, published) or author setting
 *     (QUIZ_AUTHOR_SETTING_ARGS: question_count, max_attempts,
 *     grading_strategy) from a caller who holds neither OWNER nor TEACHER is
 *     refused before the quiz is read or written.
 *
 * A quiz is placed in a module by its assignment: quiz_create requires
 * module_id, and the module is checked against the authorized classroom
 * (S1, as assignment_create checks it) before the service, which checks it
 * again inside its transaction.
 *
 * TWO EXTRA GATES run in-handler, because the registry pipeline (scope → rate
 * limit → role → mutation gate) does not know about them:
 *   1. Pro tier — the web action calls assertProTier before dispatching any
 *      quiz mutation. We call the SAME helper (authz/proTier.ts, a thin
 *      translation of @classmoji/auth's lifted assertProTier) that the quizzes
 *      read resource uses, so read, write and the webapp cannot drift apart.
 *   2. quizzes_enabled — read from the request's already-resolved, sanitized
 *      classroom settings. The web app checks this in the LOADER only, not in
 *      the action; MCP is deliberately stricter, so a classroom that has turned
 *      quizzes off cannot be mutated through this surface either.
 *
 * Backbone: ClassmojiService.quiz.* — the same functions the web action calls.
 * quiz.publish is the ONLY path that notifies students (it publishes the
 * quiz's assignment and fires QUIZ_PUBLISHED on the change INTO published, and
 * reports whether it did), which is why quiz_update refuses to set PUBLISHED:
 * a status flip through quiz.update would publish the quiz silently. The
 * service's QuizAssignmentError is mapped by mapQuizAssignmentError.
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
import {
  MAX_EXCLUDED_PATH_CHARS,
  MAX_EXCLUDED_PATHS,
  normalizeExcludedPaths,
} from '@classmoji/utils/quiz-excluded-paths';
import { MAX_STUDENT_TURNS } from '@classmoji/utils/quiz-agent/limits';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolContext, ToolDefinition } from '../mcp/registry.ts';
import { assertProTier } from '../authz/proTier.ts';
import { quizPlacement, sanitizedSettings, type QuizPlacementSource } from '../resources/shape.ts';
import {
  holdsRole,
  loadQuizInClassroom,
  loadRepositoryInClassroom,
  ok,
  QUIZ_AUTHORS,
  QUIZ_STAFF,
  requireClassroomCtx,
  scopedNotFound,
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
  await assertProTier(ctx);
  if (sanitizedSettings(ctx).quizzes_enabled === false) {
    throw new ToolError('forbidden', 'Quizzes are disabled for this classroom');
  }
}

/**
 * The quiz service's QuizAssignmentError as a tool error: no module chosen, a
 * value out of range, or an assignment-only path → invalid_params; a module or
 * quiz that is not there → not_found. The service writes nothing before it
 * throws, and its message is meant to be shown as is. Matched by name, so it
 * does not depend on class identity.
 * Anything else is returned unchanged for the caller to rethrow.
 */
function mapQuizAssignmentError(error: unknown): unknown {
  const named = error as { name?: unknown; code?: unknown; message?: unknown } | null;
  if (named?.name !== 'QuizAssignmentError') return error;
  const message = typeof named.message === 'string' ? named.message : 'Quiz assignment refused';
  if (named.code === 'module_not_found' || named.code === 'not_found') {
    return new ToolError('not_found', message);
  }
  return new ToolError('invalid_params', message);
}

/**
 * quiz_update arguments that write the quiz's assignment rather than the quiz.
 * Only a quiz author (QUIZ_AUTHORS) may send them.
 */
const QUIZ_ASSIGNMENT_ARGS = [
  'module_id',
  'release_at',
  'due_date',
  'closes_at',
  'weight',
  'tokens_per_hour',
  'published',
] as const;

/**
 * quiz_update arguments that set how the quiz is taken and scored, which only
 * a quiz author may change (the web form shows them read-only to an
 * assistant): QUIZ_AUTHOR_SETTING_KEYS in @classmoji/utils.
 */
const QUIZ_AUTHOR_SETTING_ARGS = ['question_count', 'max_attempts', 'grading_strategy'] as const;

/**
 * S1 for a module a quiz is placed in: it must be in the authorized classroom.
 * A foreign or unknown one gets the same not_found, before anything is
 * written.
 */
async function loadModuleInClassroom(moduleId: string, ctx: ToolContext): Promise<string> {
  const module = await ClassmojiService.module.findById(moduleId);
  if (!module || module.classroom_id !== requireClassroomCtx(ctx).classroomId) {
    throw scopedNotFound('Module');
  }
  return module.id;
}

/**
 * Said alongside a successful publish while every document linked as the
 * quiz's source material is still a draft: students cannot start it until one
 * is published. Same text as the web quizzes screen.
 */
const SOURCE_MATERIAL_DRAFT_WARNING =
  'All source material is still draft; students will not be able to start this quiz.';

/** At least one linked document, and every one of them a draft. */
function allSourceMaterialDraft(
  quiz: { source_material?: ReadonlyArray<{ is_draft: boolean }> } | null | undefined
): boolean {
  const material = quiz?.source_material ?? [];
  return material.length > 0 && material.every(doc => doc.is_draft);
}

/** Row shape the quiz service returns (only the fields we echo are named). */
interface QuizRow extends QuizPlacementSource {
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
  /** The quiz's assignment: module, dates, weight, tokens per hour, published. */
  assignment?:
    | (NonNullable<QuizPlacementSource['assignment']> & { tokens_per_hour?: number })
    | null;
  question_count?: number;
  max_attempts?: number;
  grading_strategy?: string;
  include_code_context?: boolean;
  course_search_enabled?: boolean;
  excluded_paths?: string[];
}

/** What quiz.publish returns: the quiz row plus what the publish did. */
interface QuizPublishRow extends QuizRow {
  /** Published before this call. */
  wasPublished?: boolean;
  /** Whether QUIZ_PUBLISHED went out to the class. */
  notified?: boolean;
}

/**
 * Explicit response allowlist — mirrors the staff shape of the quizzes read
 * resource. Never spread the service row: it carries every attempt with the
 * student User record attached. Where the quiz sits and when (module, status,
 * published, Opens, due and close dates, weight) is its assignment's, as of
 * now.
 */
function quizSummary(quiz: QuizRow) {
  return {
    id: quiz.id,
    name: quiz.name,
    ...quizPlacement(quiz),
    tokens_per_hour: quiz.assignment?.tokens_per_hour ?? 0,
    repository_id: quiz.repository_id ?? null,
    question_count: quiz.question_count ?? null,
    max_attempts: quiz.max_attempts ?? null,
    grading_strategy: quiz.grading_strategy ?? null,
    include_code_context: quiz.include_code_context ?? false,
    course_search_enabled: quiz.course_search_enabled ?? false,
    excluded_paths: quiz.excluded_paths ?? [],
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

// The assignment's weight, as on assignment_update: 0 is a practice quiz.
const weightSchema = z
  .number()
  .nonnegative()
  .max(10000)
  .describe('Grading weight beside the course’s other assignments (default 0 = practice)');

const tokensPerHourSchema = z
  .number()
  .int()
  .min(0)
  .describe('Extension tokens per late hour (default 0 = no extensions)');

const moduleIdSchema = z.string().uuid().describe('Module the quiz sits in (see list_modules)');

const gradingStrategySchema = z
  .enum(['HIGHEST', 'MOST_RECENT', 'FIRST'])
  .describe('Which attempt counts toward the grade (default HIGHEST)');

const courseSearchSchema = z
  .boolean()
  .describe(
    'Let the quiz search the whole course, not only its linked source material, to check ' +
      'whether the course covers something a student mentions (default false)'
  );

const excludedPathsSchema = z
  .array(z.string().max(MAX_EXCLUDED_PATH_CHARS))
  .max(MAX_EXCLUDED_PATHS)
  .describe(
    'Code-aware quizzes: files in the student’s repo the AI never lists, reads or quotes. ' +
      'Glob patterns relative to the repo root, like .gitignore lines (e.g. "tests/**", ' +
      '"**/*.spec.js"). At most 50, 200 characters each; no absolute paths, "..", "!" or "#"'
  );

/**
 * The list as the quiz service will store it, checked with the quiz form's
 * own rule (@classmoji/utils/quiz-excluded-paths); a bad one is an
 * invalid_params refusal before anything is read or written.
 */
function excludedPathsArg(value: string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const result = normalizeExcludedPaths(value);
  if (!result.ok) throw new ToolError('invalid_params', `excluded_paths: ${result.error}`);
  return result.value;
}

const dueDateSchema = z
  .string()
  .datetime({ offset: true })
  .describe('Due date (ISO 8601, e.g. 2026-07-20T23:59:00-04:00); late after it');

const releaseAtSchema = z
  .string()
  .datetime({ offset: true })
  .describe('Opens (ISO 8601): students see it from then on, once published');

const closesAtSchema = z
  .string()
  .datetime({ offset: true })
  .describe('Closes (ISO 8601): no new attempt from then on; one under way may finish');

interface QuizCreateArgs {
  classroom: string;
  name: string;
  rubric_prompt: string;
  module_id: string;
  repository_id?: string;
  system_prompt?: string;
  release_at?: string;
  due_date?: string;
  closes_at?: string;
  weight?: number;
  tokens_per_hour?: number;
  question_count?: number;
  difficulty_level?: string;
  subject?: string;
  include_code_context?: boolean;
  course_search_enabled?: boolean;
  excluded_paths?: string[];
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
    `just tells it how many to ask. Students can send up to ${MAX_STUDENT_TURNS} messages per ` +
    `attempt; at ${MAX_STUDENT_TURNS} the attempt is submitted and unanswered questions count ` +
    'as skipped. Set include_code_context to have it explore the student’s ' +
    'repository for the linked repo while questioning them; excluded_paths lists files it ' +
    'must never see there (e.g. tests/**). Link source material (the pages ' +
    'and decks the questions come from) with resource_link_add target_type quiz. ' +
    'module_id is required: a quiz is an assignment of that module, and release_at, due_date, ' +
    'closes_at, weight and tokens_per_hour are that assignment’s. Owner or teacher only; ' +
    'requires a Pro subscription and quizzes enabled. ALWAYS created unpublished (students ' +
    'see nothing) — use quiz_publish to go live and notify students.',
  scope: 'write',
  roles: QUIZ_AUTHORS,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    name: z.string().min(1).max(200).describe('Quiz name'),
    rubric_prompt: z
      .string()
      .min(1)
      .max(20000)
      .describe('Required. What the AI should ask about and how it should grade the answers'),
    module_id: moduleIdSchema,
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
    release_at: releaseAtSchema.optional(),
    due_date: dueDateSchema.optional(),
    closes_at: closesAtSchema.optional(),
    weight: weightSchema.optional(),
    tokens_per_hour: tokensPerHourSchema.optional(),
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
    course_search_enabled: courseSearchSchema.optional(),
    excluded_paths: excludedPathsSchema.optional(),
    grading_strategy: gradingStrategySchema.optional(),
    max_attempts: maxAttemptsSchema.optional(),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    await assertQuizSurfaceEnabled(ctx);
    const excludedPaths = excludedPathsArg(args.excluded_paths);

    // S1: the quiz row does not exist yet, so the module it goes in and a
    // supplied repository are verified against the authorized classroom
    // before either can be linked.
    const moduleId = await loadModuleInClassroom(args.module_id, ctx);
    let repositoryId: string | undefined;
    if (args.repository_id !== undefined) {
      repositoryId = (await loadRepositoryInClassroom(args.repository_id, ctx)).id;
    }

    // classroomId is ALWAYS the authorized classroom, never request input, and
    // the assignment is created unpublished — publishing is quiz_publish's job
    // because only that path notifies students. The service creates the quiz
    // and its assignment in one transaction, checking the module again there.
    let created: QuizRow;
    try {
      created = (await ClassmojiService.quiz.create({
        classroomId: classroom.classroomId,
        name: args.name,
        rubricPrompt: args.rubric_prompt,
        assignment: {
          moduleId,
          isPublished: false,
          ...(args.release_at !== undefined ? { releaseAt: args.release_at } : {}),
          ...(args.due_date !== undefined ? { dueDate: args.due_date } : {}),
          ...(args.closes_at !== undefined ? { closesAt: args.closes_at } : {}),
          ...(args.weight !== undefined ? { weight: args.weight } : {}),
          ...(args.tokens_per_hour !== undefined ? { tokensPerHour: args.tokens_per_hour } : {}),
        },
        ...(repositoryId !== undefined ? { repositoryId } : {}),
        ...(args.system_prompt !== undefined ? { systemPrompt: args.system_prompt } : {}),
        ...(args.question_count !== undefined ? { questionCount: args.question_count } : {}),
        ...(args.difficulty_level !== undefined ? { difficultyLevel: args.difficulty_level } : {}),
        ...(args.subject !== undefined ? { subject: args.subject } : {}),
        ...(args.include_code_context !== undefined
          ? { includeCodeContext: args.include_code_context }
          : {}),
        ...(args.course_search_enabled !== undefined
          ? { courseSearchEnabled: args.course_search_enabled }
          : {}),
        ...(excludedPaths !== undefined ? { excludedPaths } : {}),
        ...(args.grading_strategy !== undefined ? { gradingStrategy: args.grading_strategy } : {}),
        ...(args.max_attempts !== undefined ? { maxAttempts: args.max_attempts } : {}),
      })) as QuizRow;
    } catch (error) {
      throw mapQuizAssignmentError(error);
    }

    await writeAudit(ctx, {
      resource_type: 'QUIZ',
      resource_id: created.id,
      action: 'CREATE',
      data: {
        tool: 'quiz_create',
        name: created.name,
        module_id: moduleId,
        repository_id: repositoryId ?? null,
      },
    });

    return ok({ success: true, quiz: quizSummary(created) });
  },
};

/**
 * The subset of the quiz service's update input these tools may write, in the
 * service's own camelCase vocabulary. Declaring it explicitly is what makes
 * "never forward caller args" checkable: an argument reaches the service only
 * by being copied into one of these named keys. The assignment fields go in
 * `assignment`; `isPublished` is only ever false here — publishing is
 * reachable only via quiz.publish, the path that notifies students.
 */
interface QuizServiceUpdate {
  name?: string;
  repositoryId?: string | null;
  systemPrompt?: string;
  rubricPrompt?: string;
  subject?: string;
  difficultyLevel?: string;
  questionCount?: number;
  includeCodeContext?: boolean;
  courseSearchEnabled?: boolean;
  excludedPaths?: string[];
  maxAttempts?: number;
  gradingStrategy?: 'HIGHEST' | 'MOST_RECENT' | 'FIRST';
  assignment?: {
    moduleId?: string;
    releaseAt?: string | null;
    dueDate?: string | null;
    closesAt?: string | null;
    weight?: number;
    tokensPerHour?: number;
    isPublished?: false;
  };
}

/** quiz_update's answer to the removed `status` argument. */
const STATUS_REPLACED =
  'status is no longer accepted: use published:false to unpublish, closes_at to stop new ' +
  'attempts (null reopens), and quiz_publish to publish';

interface QuizUpdateArgs {
  classroom: string;
  quiz_id: string;
  name?: string;
  rubric_prompt?: string;
  system_prompt?: string;
  repository_id?: string | null;
  module_id?: string;
  release_at?: string | null;
  due_date?: string | null;
  closes_at?: string | null;
  weight?: number;
  tokens_per_hour?: number;
  published?: false;
  /** Removed: refused with the fields that replace it (see STATUS_REPLACED). */
  status?: unknown;
  question_count?: number;
  difficulty_level?: string;
  subject?: string;
  include_code_context?: boolean;
  course_search_enabled?: boolean;
  excluded_paths?: string[];
  grading_strategy?: 'HIGHEST' | 'MOST_RECENT' | 'FIRST';
  max_attempts?: number;
}

export const quizUpdateTool: ToolDefinition<QuizUpdateArgs> = {
  name: 'quiz_update',
  annotations: { destructive: false, openWorld: false },
  title: 'Update a quiz',
  description:
    'Updates a quiz’s settings and prompts. Owner, teacher or assistant; an assistant may change ' +
    'the content and the name only, not module_id, release_at, due_date, closes_at, weight, ' +
    'tokens_per_hour, published, question_count, max_attempts or grading_strategy. Requires a ' +
    'Pro subscription and quizzes enabled. Provide at ' +
    'least one field. module_id moves the quiz to another module (a quiz in no module needs one ' +
    'before any of those fields). closes_at stops new attempts (null reopens); published:false ' +
    'unpublishes. Publishing must go through quiz_publish, because only that path notifies ' +
    'students. null clears repository_id, release_at or due_date. excluded_paths replaces the ' +
    'list ([] clears it). Editing prompts does not re-grade attempts already taken. Students ' +
    `can send up to ${MAX_STUDENT_TURNS} messages per attempt; at ${MAX_STUDENT_TURNS} the ` +
    'attempt is submitted and unanswered questions count as skipped.',
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
    module_id: moduleIdSchema.optional(),
    // Nullable here but not on quiz_create: an update has an existing value to
    // clear.
    release_at: releaseAtSchema.nullable().optional(),
    due_date: dueDateSchema.nullable().optional(),
    closes_at: closesAtSchema.nullable().optional(),
    weight: weightSchema.optional(),
    tokens_per_hour: tokensPerHourSchema.optional(),
    published: z
      .literal(false)
      .optional()
      .describe('false unpublishes (hides it from students). To PUBLISH, use quiz_publish'),
    // Kept in the schema only so an older caller's `status` is refused by name
    // rather than dropped unseen (unknown arguments are stripped before the
    // handler runs).
    status: z
      .unknown()
      .optional()
      .describe('No longer accepted: use published:false to unpublish, closes_at to close'),
    question_count: questionCountSchema.optional(),
    difficulty_level: z.string().max(100).optional().describe('Free-text difficulty label'),
    subject: z.string().max(200).optional().describe('Free-text subject label'),
    include_code_context: z
      .boolean()
      .optional()
      .describe('Let the AI read the student’s repo for the linked repository'),
    course_search_enabled: courseSearchSchema.optional(),
    excluded_paths: excludedPathsSchema.optional(),
    grading_strategy: gradingStrategySchema.optional(),
    max_attempts: maxAttemptsSchema.optional(),
  },
  handler: async (args, ctx) => {
    // `status` was replaced; a caller still sending it is told what to use
    // instead, before anything is read or written.
    if (args.status !== undefined) {
      throw new ToolError('invalid_params', STATUS_REPLACED);
    }
    await assertQuizSurfaceEnabled(ctx);

    // Explicit field-by-field mapping (snake_case tool args → the service's
    // camelCase input): nothing the caller sends is forwarded wholesale.
    const updates: QuizServiceUpdate = {};
    const assignment: NonNullable<QuizServiceUpdate['assignment']> = {};
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
    const setOnAssignment = <K extends keyof typeof assignment>(
      field: string,
      key: K,
      value: (typeof assignment)[K] | undefined
    ) => {
      if (value === undefined) return;
      assignment[key] = value;
      fields.push(field);
    };
    set('name', 'name', args.name);
    set('rubric_prompt', 'rubricPrompt', args.rubric_prompt);
    set('system_prompt', 'systemPrompt', args.system_prompt);
    set('question_count', 'questionCount', args.question_count);
    set('difficulty_level', 'difficultyLevel', args.difficulty_level);
    set('subject', 'subject', args.subject);
    set('include_code_context', 'includeCodeContext', args.include_code_context);
    set('course_search_enabled', 'courseSearchEnabled', args.course_search_enabled);
    set('excluded_paths', 'excludedPaths', excludedPathsArg(args.excluded_paths));
    set('grading_strategy', 'gradingStrategy', args.grading_strategy);
    set('max_attempts', 'maxAttempts', args.max_attempts);
    setOnAssignment('release_at', 'releaseAt', args.release_at);
    setOnAssignment('due_date', 'dueDate', args.due_date);
    setOnAssignment('closes_at', 'closesAt', args.closes_at);
    setOnAssignment('weight', 'weight', args.weight);
    setOnAssignment('tokens_per_hour', 'tokensPerHour', args.tokens_per_hour);
    setOnAssignment('published', 'isPublished', args.published);
    if (args.repository_id !== undefined) fields.push('repository_id');
    if (args.module_id !== undefined) fields.push('module_id');

    if (fields.length === 0) {
      throw new ToolError('invalid_params', 'Provide at least one field to update');
    }

    // A quiz's module, schedule, weight and publish state live on its
    // assignment, which only a quiz author changes; an assistant edits the
    // content and the name. A call carrying any of them is refused whole,
    // before the quiz is read. holdsRole, not ctx.classroom.role: a multi-role
    // author whose gate resolved as ASSISTANT is still an author.
    if (
      QUIZ_ASSIGNMENT_ARGS.some(field => args[field] !== undefined) &&
      !(await holdsRole(ctx, QUIZ_AUTHORS))
    ) {
      throw new ToolError(
        'forbidden',
        'Only the class owner or a teacher can change a quiz’s module, dates, weight, ' +
          'tokens per hour or publish state',
        'INSUFFICIENT_ROLE'
      );
    }
    // How the quiz is taken and scored is the authors' too.
    if (
      QUIZ_AUTHOR_SETTING_ARGS.some(field => args[field] !== undefined) &&
      !(await holdsRole(ctx, QUIZ_AUTHORS))
    ) {
      throw new ToolError(
        'forbidden',
        'Only the class owner or a teacher can change a quiz’s number of questions, max ' +
          'attempts or grading strategy',
        'INSUFFICIENT_ROLE'
      );
    }

    // S1 before any write: the quiz must belong to the authorized classroom,
    // and so must a module it moves to or a repository it links.
    const quiz = await loadQuizInClassroom(args.quiz_id, ctx);

    if (args.module_id !== undefined) {
      assignment.moduleId = await loadModuleInClassroom(args.module_id, ctx);
    }
    if (args.repository_id !== undefined) {
      // null disconnects; a value must first prove it lives in this classroom.
      updates.repositoryId =
        args.repository_id === null
          ? null
          : (await loadRepositoryInClassroom(args.repository_id, ctx)).id;
    }
    if (Object.keys(assignment).length > 0) updates.assignment = assignment;

    let updated: QuizRow;
    try {
      updated = (await ClassmojiService.quiz.update(quiz.id, updates)) as QuizRow;
    } catch (error) {
      // A quiz in no module takes no schedule, weight or publish change until
      // it is given one ('module_required'): said so with the field to set.
      const named = error as { name?: unknown; code?: unknown } | null;
      if (named?.name === 'QuizAssignmentError' && named.code === 'module_required') {
        throw new ToolError(
          'invalid_params',
          'This quiz is in no module: set module_id too (see list_modules).'
        );
      }
      throw mapQuizAssignmentError(error);
    }

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
    'Publishes a quiz so students can take it. Owner or teacher only; requires a Pro subscription ' +
    'and quizzes enabled. This is the ONLY path that notifies students — they get a "Quiz ' +
    'published" notification, but only on the transition INTO published, so republishing an ' +
    'already-published quiz notifies nobody. The response reports whether students were ' +
    'notified. If every linked source document is still a draft, it also carries a warning: ' +
    'students cannot start the quiz until one is published. A quiz in no module cannot be ' +
    'published: set its module_id with quiz_update first. Use quiz_update with ' +
    'published:false to unpublish.',
  scope: 'write',
  roles: QUIZ_AUTHORS,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    quiz_id: z.string().uuid().describe('Quiz id'),
  },
  handler: async (args, ctx) => {
    await assertQuizSurfaceEnabled(ctx);
    const quiz = await loadQuizInClassroom(args.quiz_id, ctx);
    // Publishing is the assignment's: a quiz in no module has none yet.
    if (!quiz.assignment) {
      throw new ToolError(
        'invalid_params',
        'This quiz is in no module: set its module_id with quiz_update, then publish it.'
      );
    }

    let published: QuizPublishRow;
    try {
      published = (await ClassmojiService.quiz.publish(quiz.id)) as QuizPublishRow;
    } catch (error) {
      // A quiz in no module has no assignment to publish ('module_required').
      throw mapQuizAssignmentError(error);
    }
    // The service decides who is told and says so: the class hears once, on
    // the change into published, and not where quizzes are hidden or before
    // the quiz opens. `wasPublished` tells a republish apart from a publish
    // that notified nobody.
    const notified = published.notified === true;
    const wasPublished = published.wasPublished === true;
    // Publishing does not change the material, so the row loaded above says;
    // quiz.publish returns the bare row without it.
    const warning = allSourceMaterialDraft(quiz) ? SOURCE_MATERIAL_DRAFT_WARNING : null;
    // As the assignment read before the publish, not the quiz's own column.
    const previousStatus = quizPlacement(quiz as QuizRow).status;

    await writeAudit(ctx, {
      resource_type: 'QUIZ',
      resource_id: quiz.id,
      action: 'UPDATE',
      data: {
        tool: 'quiz_publish',
        previous_status: previousStatus,
        students_notified: notified,
      },
    });

    return ok({
      success: true,
      quiz: quizSummary(published),
      previous_status: previousStatus,
      students_notified: notified,
      ...(warning ? { warning } : {}),
      message:
        (notified
          ? 'Quiz published — students have been notified.'
          : wasPublished
            ? 'Quiz was already published — nothing changed and no notifications were sent.'
            : 'Quiz published — no notifications were sent.') +
        (warning ? ` Warning: ${warning}` : ''),
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
    'Permanently deletes a quiz. Owner or teacher only, destructive, requires confirm:true; ' +
    'requires a Pro subscription and quizzes enabled. THIS CANNOT BE UNDONE and cascades: every ' +
    'student attempt at this quiz — transcripts, scores, and focus metrics — is permanently ' +
    'deleted with it, and so is its assignment (its place in its module, its dates and ' +
    'weight). To take a quiz out of circulation without losing student work, use quiz_update ' +
    'with closes_at (no new attempts) or published:false.',
  scope: 'write',
  roles: QUIZ_AUTHORS,
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
