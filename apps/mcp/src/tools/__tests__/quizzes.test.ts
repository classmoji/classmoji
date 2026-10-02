/**
 * Unit tests for quiz_create / quiz_update / quiz_publish / quiz_delete.
 *
 * Security focus:
 *   - S1: every tool resolves its target (and any linked repository) against
 *     the ctx classroom, and refuses missing/foreign records with the uniform
 *     scopedNotFound BEFORE any service call.
 *   - The two in-handler gates the registry cannot apply — Pro tier and
 *     quizzes_enabled — deny before mutating.
 *   - The notification invariant: publishing is quiz.publish's job only, so
 *     the update schema must refuse PUBLISHED (and ARCHIVED, which is not even
 *     in the Prisma enum).
 *   - Role tiers: create/publish/delete are for quiz authors (OWNER, TEACHER);
 *     an assistant reaches quiz_update for content and the name, and a call of
 *     theirs carrying an assignment field is refused before any read or write.
 * Only the service boundary is mocked — these tools fire no external effects.
 *
 * Schema-level rules (clamps, the status enum, confirm:true) are asserted
 * against `tool.inputSchema` itself: the registry/SDK validates arguments
 * BEFORE the handler runs, so a direct handler call bypasses zod entirely.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { QUIZ_AUTHOR_ROLES, QUIZ_EDITOR_ROLES } from '@classmoji/utils';
import { MAX_STUDENT_TURNS } from '@classmoji/utils/quiz-agent/limits';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  quizCreate: vi.fn(),
  quizUpdate: vi.fn(),
  quizPublish: vi.fn(),
  quizDelete: vi.fn(),
  quizFindById: vi.fn(),
  moduleFindById: vi.fn(),
  repositoryFindById: vi.fn(),
  membershipFindByClassroomAndUser: vi.fn(),
  assertProTier: vi.fn(),
  auditCreate: vi.fn(),
}));

/**
 * The Pro gate is no longer decided in this app: authz/proTier.ts translates
 * `@classmoji/auth/server`'s lifted `assertProTier`, which throws a 403
 * Response. Mocking THAT is what pins the wrapper's contract — a thrown
 * Response becomes a forbidden ToolError, and the gate runs before any mutation.
 * What "Pro" means (tier + ends_at) is pinned once, in
 * packages/auth/src/__tests__/proTier.test.ts.
 */
vi.mock('@classmoji/auth/server', () => ({
  assertProTier: (...a: unknown[]) => mocks.assertProTier(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    quiz: {
      create: (...a: unknown[]) => mocks.quizCreate(...a),
      update: (...a: unknown[]) => mocks.quizUpdate(...a),
      publish: (...a: unknown[]) => mocks.quizPublish(...a),
      delete: (...a: unknown[]) => mocks.quizDelete(...a),
      findById: (...a: unknown[]) => mocks.quizFindById(...a),
    },
    repository: { findById: (...a: unknown[]) => mocks.repositoryFindById(...a) },
    module: { findById: (...a: unknown[]) => mocks.moduleFindById(...a) },
    classroomMembership: {
      findByClassroomAndUser: (...a: unknown[]) => mocks.membershipFindByClassroomAndUser(...a),
    },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
  },
}));

/** The service's QuizAssignmentError, by name and code, as the tools match it. */
function quizAssignmentError(code: string, message: string) {
  return Object.assign(new Error(message), { name: 'QuizAssignmentError', code, status: 400 });
}

const { quizCreateTool, quizUpdateTool, quizPublishTool, quizDeleteTool } =
  await import('../quizzes.ts');

/** Context with the quiz surface enabled (Pro + quizzes_enabled). */
function ctxWithSettings(settings: Record<string, unknown>): ToolContext {
  return {
    viewer: { userId: 'owner-1', clientId: 'c', scopes: new Set(['read', 'write']) },
    classroom: {
      classroomId: 'class-1',
      role: 'OWNER',
      status: 'ACTIVE',
      membership: { id: 'm-1', role: 'OWNER' },
      // The Pro wrapper reads the AUTHORIZED classroom's slug off this object.
      classroom: { slug: 'w26', settings },
    },
  } as unknown as ToolContext;
}

const CTX = ctxWithSettings({ quizzes_enabled: true });

/** CTX with the registry's gate resolved as `role` for another user. */
function ctxAs(role: 'TEACHER' | 'ASSISTANT', userId: string): ToolContext {
  return {
    ...CTX,
    viewer: { userId, clientId: 'c', scopes: new Set(['read', 'write']) },
    classroom: {
      ...(CTX.classroom as object),
      role,
      membership: { id: `m-${userId}`, role },
    },
  } as unknown as ToolContext;
}

// holdsRole then asks classroomMembership whether the caller ALSO holds an
// author role; the tests answer per case (null = assistant only).
const ASSISTANT_CTX = ctxAs('ASSISTANT', 'ta-1');
const TEACHER_CTX = ctxAs('TEACHER', 'teacher-1');

const MODULE_ID = '22222222-2222-4222-8222-222222222222';

/** The quiz's assignment: its module, dates, weight and publish state. */
const ASSIGNMENT = {
  is_published: false,
  release_at: null,
  student_deadline: null,
  closes_at: null,
  weight: 10,
  tokens_per_hour: 0,
  module: { id: MODULE_ID, title: 'Week 3' },
};

const QUIZ_ROW = {
  id: 'quiz-1',
  classroom_id: 'class-1',
  name: 'Week 3 concepts',
  status: 'DRAFT',
  rubric_prompt: 'Ask about recursion',
  weight: 10,
  assignment: ASSIGNMENT,
  question_count: 5,
  max_attempts: 1,
  grading_strategy: 'HIGHEST',
  include_code_context: false,
  attempts: [{ id: 'att-1', user: { id: 'stu-1', name: 'Alice', email: 'a@x.edu' } }],
};

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.auditCreate.mockResolvedValue(undefined);
  mocks.assertProTier.mockResolvedValue(undefined);
  mocks.membershipFindByClassroomAndUser.mockResolvedValue(null);
  mocks.moduleFindById.mockResolvedValue({ id: MODULE_ID, classroom_id: 'class-1' });
});

describe('role tiers', () => {
  it('create, publish and delete are for quiz authors: owner and teacher', () => {
    for (const tool of [quizCreateTool, quizPublishTool, quizDeleteTool]) {
      expect(tool.roles, tool.name).toEqual(['OWNER', 'TEACHER']);
      // The same set the web actions and services read.
      expect(tool.roles, tool.name).toEqual([...QUIZ_AUTHOR_ROLES]);
    }
  });

  it('update stays open to the whole teaching team', () => {
    expect(quizUpdateTool.roles).toEqual(['OWNER', 'TEACHER', 'ASSISTANT']);
    expect(quizUpdateTool.roles).toEqual([...QUIZ_EDITOR_ROLES]);
  });

  it('says who may call each tool in its description', () => {
    for (const tool of [quizCreateTool, quizPublishTool, quizDeleteTool]) {
      expect(tool.description, tool.name).toContain('Owner or teacher only');
      expect(tool.description, tool.name).not.toMatch(/assistant/i);
    }
    expect(quizUpdateTool.description).toContain(
      'an assistant may change the content and the name only, not module_id, release_at, ' +
        'due_date, closes_at, weight, tokens_per_hour, published, question_count, max_attempts ' +
        'or grading_strategy'
    );
    for (const tool of [quizCreateTool, quizUpdateTool, quizPublishTool, quizDeleteTool]) {
      expect(new TextEncoder().encode(tool.description).length, tool.name).toBeLessThan(1500);
    }
  });
});

describe('quiz_create', () => {
  const ARGS = {
    classroom: 'org/w26',
    name: 'Week 3 concepts',
    rubric_prompt: 'Ask about recursion',
    module_id: MODULE_ID,
    weight: 10,
    question_count: 5,
  };

  it('creates an unpublished quiz in its module under the ctx classroom and audits CREATE', async () => {
    mocks.quizCreate.mockResolvedValue(QUIZ_ROW);

    const payload = parse(await quizCreateTool.handler(ARGS, CTX));
    expect(payload.success).toBe(true);
    expect(payload.quiz).toMatchObject({
      id: 'quiz-1',
      status: 'DRAFT',
      published: false,
      module: { id: MODULE_ID, title: 'Week 3' },
      weight: 10,
    });

    const data = mocks.quizCreate.mock.calls[0][0] as Record<string, unknown>;
    // classroomId comes from ctx, never from args, and the assignment is
    // created unpublished: publishing must go through quiz_publish so students
    // get notified. Due date and weight are the assignment's.
    expect(data.classroomId).toBe('class-1');
    expect(data.assignment).toEqual({ moduleId: MODULE_ID, isPublished: false, weight: 10 });
    expect(data).not.toHaveProperty('status');
    expect(data).not.toHaveProperty('dueDate');
    expect(data).not.toHaveProperty('weight');
    expect(data.rubricPrompt).toBe('Ask about recursion');
    // The module was checked against this classroom first (S1).
    expect(mocks.moduleFindById).toHaveBeenCalledWith(MODULE_ID);

    const audit = mocks.auditCreate.mock.calls[0][0] as { action: string; classroom_id: string };
    expect(audit.action).toBe('CREATE');
    expect(audit.classroom_id).toBe('class-1');
  });

  it('does not accept a status argument at all (always DRAFT)', () => {
    expect(quizCreateTool.inputSchema).not.toHaveProperty('status');
  });

  it('never echoes the attempts/user rows the service returns', async () => {
    mocks.quizCreate.mockResolvedValue(QUIZ_ROW);
    const payload = parse(await quizCreateTool.handler(ARGS, CTX));
    expect(payload.quiz).not.toHaveProperty('attempts');
    expect(JSON.stringify(payload)).not.toContain('a@x.edu');
  });

  it('links a repository only after verifying it is in this classroom', async () => {
    mocks.repositoryFindById.mockResolvedValue({ id: 'repo-1', classroom_id: 'class-1' });
    mocks.quizCreate.mockResolvedValue({ ...QUIZ_ROW, repository_id: 'repo-1' });

    await quizCreateTool.handler({ ...ARGS, repository_id: 'repo-1' }, CTX);
    expect((mocks.quizCreate.mock.calls[0][0] as { repositoryId: string }).repositoryId).toBe(
      'repo-1'
    );
  });

  it('refuses a repository from another classroom (S1) and never creates', async () => {
    mocks.repositoryFindById.mockResolvedValue({ id: 'repo-1', classroom_id: 'OTHER-class' });

    await expect(
      quizCreateTool.handler({ ...ARGS, repository_id: 'repo-1' }, CTX)
    ).rejects.toMatchObject({ kind: 'not_found' });
    expect(mocks.quizCreate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('requires module_id in the schema', () => {
    const schema = z.object(quizCreateTool.inputSchema);
    const { module_id: _moduleId, ...withoutModule } = ARGS;
    expect(schema.safeParse(withoutModule).success).toBe(false);
    expect(schema.safeParse({ ...ARGS, module_id: 'not-a-uuid' }).success).toBe(false);
    expect(schema.safeParse(ARGS).success).toBe(true);
  });

  it.each([
    ['in another classroom', { id: MODULE_ID, classroom_id: 'OTHER-class' }],
    ['unknown', null],
  ])('refuses a module %s (S1) and never creates', async (_case, module) => {
    mocks.moduleFindById.mockResolvedValue(module);

    await expect(quizCreateTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
      message: 'Module not found in this classroom',
    });
    expect(mocks.quizCreate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('puts Opens, due and close dates, weight and tokens per hour on the assignment', async () => {
    mocks.quizCreate.mockResolvedValue(QUIZ_ROW);

    await quizCreateTool.handler(
      {
        ...ARGS,
        release_at: '2026-10-05T09:00:00-04:00',
        due_date: '2026-10-12T23:59:00-04:00',
        closes_at: '2026-10-19T23:59:00-04:00',
        weight: 0,
        tokens_per_hour: 2,
      },
      CTX
    );

    expect((mocks.quizCreate.mock.calls[0][0] as { assignment: unknown }).assignment).toEqual({
      moduleId: MODULE_ID,
      isPublished: false,
      releaseAt: '2026-10-05T09:00:00-04:00',
      dueDate: '2026-10-12T23:59:00-04:00',
      closesAt: '2026-10-19T23:59:00-04:00',
      weight: 0,
      tokensPerHour: 2,
    });
  });

  it.each([
    ['invalid_value', 'invalid_params'],
    ['quiz_assignment', 'invalid_params'],
    ['module_not_found', 'not_found'],
    ['not_found', 'not_found'],
  ])('maps QuizAssignmentError code %s to %s', async (code, kind) => {
    mocks.quizCreate.mockRejectedValue(quizAssignmentError(code, `refused: ${code}`));
    await expect(quizCreateTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind,
      message: `refused: ${code}`,
    });
  });

  it('does not dress up an unrelated failure', async () => {
    mocks.quizCreate.mockRejectedValue(new Error('connection lost'));
    await expect(quizCreateTool.handler(ARGS, CTX)).rejects.toThrow('connection lost');
    await expect(quizCreateTool.handler(ARGS, CTX)).rejects.not.toHaveProperty('kind');
  });

  it('denies a classroom without a Pro subscription before mutating', async () => {
    mocks.assertProTier.mockRejectedValue(
      new Response('This feature requires a Pro subscription', { status: 403 })
    );
    await expect(quizCreateTool.handler(ARGS, CTX)).rejects.toMatchObject({ kind: 'forbidden' });
    expect(mocks.quizCreate).not.toHaveBeenCalled();
  });

  it('denies when quizzes are disabled for the classroom (stricter than the web app)', async () => {
    const disabled = ctxWithSettings({ quizzes_enabled: false });
    await expect(quizCreateTool.handler(ARGS, disabled)).rejects.toMatchObject({
      kind: 'forbidden',
      message: 'Quizzes are disabled for this classroom',
    });
    expect(mocks.quizCreate).not.toHaveBeenCalled();
  });

  it('enforces the service clamps in the schema (question_count, max_attempts, weight)', () => {
    const schema = z.object(quizCreateTool.inputSchema);
    const base = { classroom: 'org/w26', name: 'Q', rubric_prompt: 'r', module_id: MODULE_ID };

    expect(schema.safeParse({ ...base, question_count: 0 }).success).toBe(false);
    expect(schema.safeParse({ ...base, question_count: 21 }).success).toBe(false);
    expect(schema.safeParse({ ...base, question_count: 20 }).success).toBe(true);
    expect(schema.safeParse({ ...base, question_count: 2.5 }).success).toBe(false);

    // 0 is legal for max_attempts — it means unlimited.
    expect(schema.safeParse({ ...base, max_attempts: 0 }).success).toBe(true);
    expect(schema.safeParse({ ...base, max_attempts: -1 }).success).toBe(false);

    // The assignment's weight: 0 (practice) up to 10000, as assignment_update.
    expect(schema.safeParse({ ...base, weight: 0 }).success).toBe(true);
    expect(schema.safeParse({ ...base, weight: 2.5 }).success).toBe(true);
    expect(schema.safeParse({ ...base, weight: 101 }).success).toBe(true);
    expect(schema.safeParse({ ...base, weight: -1 }).success).toBe(false);
    expect(schema.safeParse({ ...base, weight: 10001 }).success).toBe(false);
    expect(schema.safeParse({ ...base, tokens_per_hour: -1 }).success).toBe(false);
    expect(schema.safeParse({ ...base, tokens_per_hour: 1.5 }).success).toBe(false);

    // rubric_prompt is required and non-empty.
    expect(
      schema.safeParse({ classroom: 'org/w26', name: 'Q', module_id: MODULE_ID }).success
    ).toBe(false);
    expect(schema.safeParse({ ...base, rubric_prompt: '' }).success).toBe(false);
  });
});

describe('course_search_enabled (quiz source material, Stage 2 tier)', () => {
  it('quiz_create forwards it as courseSearchEnabled and echoes it', async () => {
    mocks.quizCreate.mockResolvedValue({ ...QUIZ_ROW, course_search_enabled: true });

    const payload = parse(
      await quizCreateTool.handler(
        {
          classroom: 'org/w26',
          name: 'Q',
          rubric_prompt: 'r',
          module_id: MODULE_ID,
          course_search_enabled: true,
        },
        CTX
      )
    );

    expect(mocks.quizCreate.mock.calls[0][0]).toMatchObject({ courseSearchEnabled: true });
    expect(payload.quiz.course_search_enabled).toBe(true);
  });

  it('quiz_create leaves it out when not given, and the summary reports false', async () => {
    mocks.quizCreate.mockResolvedValue(QUIZ_ROW);

    const payload = parse(
      await quizCreateTool.handler(
        { classroom: 'org/w26', name: 'Q', rubric_prompt: 'r', module_id: MODULE_ID },
        CTX
      )
    );

    expect(mocks.quizCreate.mock.calls[0][0]).not.toHaveProperty('courseSearchEnabled');
    expect(payload.quiz.course_search_enabled).toBe(false);
  });

  it('quiz_update maps it alone as a field and audits the field name', async () => {
    mocks.quizFindById.mockResolvedValue(QUIZ_ROW);
    mocks.quizUpdate.mockResolvedValue({ ...QUIZ_ROW, course_search_enabled: false });

    await quizUpdateTool.handler(
      { classroom: 'org/w26', quiz_id: 'quiz-1', course_search_enabled: false },
      CTX
    );

    expect(mocks.quizUpdate.mock.calls[0][1]).toEqual({ courseSearchEnabled: false });
    const audit = mocks.auditCreate.mock.calls[0][0] as { data: { fields: string[] } };
    expect(audit.data.fields).toEqual(['course_search_enabled']);
  });

  it('is a boolean in both schemas and neither tool takes source material', () => {
    for (const tool of [quizCreateTool, quizUpdateTool]) {
      const schema = z.object(tool.inputSchema);
      expect(tool.inputSchema).toHaveProperty('course_search_enabled');
      expect(tool.inputSchema).not.toHaveProperty('source_material');
      expect(
        schema.safeParse({
          classroom: 'o/s',
          quiz_id: 'x',
          name: 'n',
          rubric_prompt: 'r',
          course_search_enabled: 'yes',
        }).success
      ).toBe(false);
    }
  });

  it('keeps the descriptions under 1,500 bytes and points at the link tool for material', () => {
    for (const tool of [quizCreateTool, quizUpdateTool, quizPublishTool]) {
      expect(new TextEncoder().encode(tool.description).length, tool.name).toBeLessThan(1500);
    }
    expect(quizCreateTool.description).toContain('resource_link_add');
  });

  it('states the per-attempt message limit from the shared constant', () => {
    expect(MAX_STUDENT_TURNS).toBe(200);
    for (const tool of [quizCreateTool, quizUpdateTool]) {
      expect(tool.description, tool.name).toContain(
        `Students can send up to ${MAX_STUDENT_TURNS} messages per attempt; at ` +
          `${MAX_STUDENT_TURNS} the attempt is submitted and unanswered questions count as skipped.`
      );
    }
  });
});

describe('excluded_paths (code-aware quizzes)', () => {
  it('quiz_create forwards the list trimmed, repeats dropped, and echoes it', async () => {
    mocks.quizCreate.mockResolvedValue({
      ...QUIZ_ROW,
      excluded_paths: ['tests/**', '**/*.spec.js'],
    });

    const payload = parse(
      await quizCreateTool.handler(
        {
          classroom: 'org/w26',
          name: 'Q',
          rubric_prompt: 'r',
          module_id: MODULE_ID,
          include_code_context: true,
          excluded_paths: [' tests/** ', '**/*.spec.js', 'tests/**'],
        },
        CTX
      )
    );

    expect(mocks.quizCreate.mock.calls[0][0]).toMatchObject({
      excludedPaths: ['tests/**', '**/*.spec.js'],
    });
    expect(payload.quiz.excluded_paths).toEqual(['tests/**', '**/*.spec.js']);
  });

  it('quiz_create leaves it out when not given, and the summary reports none', async () => {
    mocks.quizCreate.mockResolvedValue(QUIZ_ROW);

    const payload = parse(
      await quizCreateTool.handler(
        { classroom: 'org/w26', name: 'Q', rubric_prompt: 'r', module_id: MODULE_ID },
        CTX
      )
    );

    expect(mocks.quizCreate.mock.calls[0][0]).not.toHaveProperty('excludedPaths');
    expect(payload.quiz.excluded_paths).toEqual([]);
  });

  it.each([
    [['/etc/**'], 'is an absolute path'],
    [['../other/**'], 'uses ".."'],
    [[''], 'cannot be empty'],
    [['!tests/**'], 'starts with "!"'],
  ])('quiz_create refuses %j before writing, with the form’s reason', async (paths, reason) => {
    const error = await quizCreateTool
      .handler(
        {
          classroom: 'org/w26',
          name: 'Q',
          rubric_prompt: 'r',
          module_id: MODULE_ID,
          excluded_paths: paths,
        },
        CTX
      )
      .catch((e: unknown) => e);

    expect(error).toMatchObject({ kind: 'invalid_params' });
    expect((error as Error).message).toContain('excluded_paths: ');
    expect((error as Error).message).toContain(reason);
    expect(mocks.quizCreate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('quiz_update maps it alone as a field and audits the field name', async () => {
    mocks.quizFindById.mockResolvedValue(QUIZ_ROW);
    mocks.quizUpdate.mockResolvedValue({ ...QUIZ_ROW, excluded_paths: ['e2e/'] });

    const payload = parse(
      await quizUpdateTool.handler(
        { classroom: 'org/w26', quiz_id: 'quiz-1', excluded_paths: [' e2e/ '] },
        CTX
      )
    );

    expect(mocks.quizUpdate.mock.calls[0][1]).toEqual({ excludedPaths: ['e2e/'] });
    expect(payload.quiz.excluded_paths).toEqual(['e2e/']);
    const audit = mocks.auditCreate.mock.calls[0][0] as { data: { fields: string[] } };
    expect(audit.data.fields).toEqual(['excluded_paths']);
  });

  it('quiz_update clears the list with []', async () => {
    mocks.quizFindById.mockResolvedValue(QUIZ_ROW);
    mocks.quizUpdate.mockResolvedValue(QUIZ_ROW);

    await quizUpdateTool.handler(
      { classroom: 'org/w26', quiz_id: 'quiz-1', excluded_paths: [] },
      CTX
    );

    expect(mocks.quizUpdate.mock.calls[0][1]).toEqual({ excludedPaths: [] });
  });

  it('quiz_update refuses a bad pattern before reading the quiz', async () => {
    await expect(
      quizUpdateTool.handler(
        { classroom: 'org/w26', quiz_id: 'quiz-1', excluded_paths: ['C:\\repo\\tests'] },
        CTX
      )
    ).rejects.toMatchObject({ kind: 'invalid_params' });
    expect(mocks.quizFindById).not.toHaveBeenCalled();
    expect(mocks.quizUpdate).not.toHaveBeenCalled();
  });

  it('is a list of at most 50 strings of at most 200 characters in both schemas', () => {
    for (const tool of [quizCreateTool, quizUpdateTool]) {
      const field = tool.inputSchema.excluded_paths as z.ZodTypeAny;
      expect(field, tool.name).toBeDefined();
      expect(field.safeParse(undefined).success).toBe(true);
      expect(field.safeParse(['tests/**', '**/*.spec.js']).success).toBe(true);
      expect(field.safeParse([]).success).toBe(true);
      expect(field.safeParse('tests/**').success).toBe(false);
      expect(field.safeParse([3]).success).toBe(false);
      expect(field.safeParse(['a'.repeat(201)]).success).toBe(false);
      expect(field.safeParse(Array.from({ length: 51 }, (_, i) => `d${i}/**`)).success).toBe(false);
    }
  });
});

describe('quiz_update', () => {
  const ARGS = { classroom: 'org/w26', quiz_id: 'quiz-1', name: 'Renamed' };

  it('updates a quiz in this classroom and audits the changed fields', async () => {
    mocks.quizFindById.mockResolvedValue(QUIZ_ROW);
    mocks.quizUpdate.mockResolvedValue({ ...QUIZ_ROW, name: 'Renamed' });

    const payload = parse(await quizUpdateTool.handler(ARGS, CTX));
    expect(payload.quiz.name).toBe('Renamed');

    // Mapped explicitly into the service's camelCase vocabulary.
    expect(mocks.quizUpdate).toHaveBeenCalledWith('quiz-1', { name: 'Renamed' });

    const audit = mocks.auditCreate.mock.calls[0][0] as {
      action: string;
      classroom_id: string;
      data: { fields: string[] };
    };
    expect(audit.action).toBe('UPDATE');
    expect(audit.classroom_id).toBe('class-1');
    expect(audit.data.fields).toEqual(['name']);
  });

  it('closes, reopens and unpublishes through the assignment', async () => {
    mocks.quizFindById.mockResolvedValue(QUIZ_ROW);
    mocks.quizUpdate.mockResolvedValue(QUIZ_ROW);
    const base = { classroom: 'org/w26', quiz_id: 'quiz-1' };

    await quizUpdateTool.handler({ ...base, closes_at: '2026-10-19T23:59:00-04:00' }, CTX);
    expect(mocks.quizUpdate).toHaveBeenLastCalledWith('quiz-1', {
      assignment: { closesAt: '2026-10-19T23:59:00-04:00' },
    });

    await quizUpdateTool.handler({ ...base, closes_at: null }, CTX);
    expect(mocks.quizUpdate).toHaveBeenLastCalledWith('quiz-1', { assignment: { closesAt: null } });

    await quizUpdateTool.handler({ ...base, published: false }, CTX);
    expect(mocks.quizUpdate).toHaveBeenLastCalledWith('quiz-1', {
      assignment: { isPublished: false },
    });
  });

  it('moves the quiz to a module of this classroom, and refuses a foreign one (S1)', async () => {
    mocks.quizFindById.mockResolvedValue(QUIZ_ROW);
    mocks.quizUpdate.mockResolvedValue(QUIZ_ROW);
    const base = { classroom: 'org/w26', quiz_id: 'quiz-1', module_id: MODULE_ID };

    await quizUpdateTool.handler({ ...base, weight: 3 }, CTX);
    expect(mocks.quizUpdate).toHaveBeenLastCalledWith('quiz-1', {
      assignment: { weight: 3, moduleId: MODULE_ID },
    });
    expect(mocks.auditCreate.mock.calls[0][0].data.fields).toEqual(['weight', 'module_id']);

    mocks.quizUpdate.mockClear();
    mocks.moduleFindById.mockResolvedValue({ id: MODULE_ID, classroom_id: 'OTHER-class' });
    await expect(quizUpdateTool.handler(base, CTX)).rejects.toMatchObject({ kind: 'not_found' });
    expect(mocks.quizUpdate).not.toHaveBeenCalled();
  });

  it('tells a caller to set module_id when the quiz is in no module', async () => {
    mocks.quizFindById.mockResolvedValue({ ...QUIZ_ROW, assignment: null });
    mocks.quizUpdate.mockRejectedValue(
      quizAssignmentError('module_required', 'Choose a module for this quiz')
    );

    await expect(
      quizUpdateTool.handler(
        { classroom: 'org/w26', quiz_id: 'quiz-1', due_date: '2026-10-12T23:59:00-04:00' },
        CTX
      )
    ).rejects.toMatchObject({
      kind: 'invalid_params',
      message: 'This quiz is in no module: set module_id too (see list_modules).',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('requires at least one field', async () => {
    await expect(
      quizUpdateTool.handler({ classroom: 'org/w26', quiz_id: 'quiz-1' }, CTX)
    ).rejects.toMatchObject({ kind: 'invalid_params' });
    expect(mocks.quizFindById).not.toHaveBeenCalled();
    expect(mocks.quizUpdate).not.toHaveBeenCalled();
  });

  it('refuses a quiz in another classroom (S1) with zero service calls', async () => {
    mocks.quizFindById.mockResolvedValue({ ...QUIZ_ROW, classroom_id: 'OTHER-class' });

    await expect(quizUpdateTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
      message: 'Quiz not found in this classroom',
    });
    expect(mocks.quizUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('refuses an unknown quiz id with the identical error (no existence leak)', async () => {
    mocks.quizFindById.mockResolvedValue(null);
    await expect(quizUpdateTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
      message: 'Quiz not found in this classroom',
    });
  });

  it('disconnects the repository on null and verifies a non-null one first', async () => {
    mocks.quizFindById.mockResolvedValue(QUIZ_ROW);
    mocks.quizUpdate.mockResolvedValue(QUIZ_ROW);

    await quizUpdateTool.handler(
      { classroom: 'org/w26', quiz_id: 'quiz-1', repository_id: null },
      CTX
    );
    expect(mocks.quizUpdate).toHaveBeenCalledWith('quiz-1', { repositoryId: null });
    expect(mocks.repositoryFindById).not.toHaveBeenCalled();

    mocks.repositoryFindById.mockResolvedValue({ id: 'repo-9', classroom_id: 'OTHER-class' });
    await expect(
      quizUpdateTool.handler(
        { classroom: 'org/w26', quiz_id: 'quiz-1', repository_id: 'repo-9' },
        CTX
      )
    ).rejects.toMatchObject({ kind: 'not_found' });
    expect(mocks.quizUpdate).toHaveBeenCalledTimes(1); // only the null-disconnect call
  });

  it('clears the due date on null and forwards a supplied one', async () => {
    mocks.quizFindById.mockResolvedValue(QUIZ_ROW);
    mocks.quizUpdate.mockResolvedValue(QUIZ_ROW);

    // null reaches the service as a clear; the service maps falsy → null.
    await quizUpdateTool.handler({ classroom: 'org/w26', quiz_id: 'quiz-1', due_date: null }, CTX);
    expect(mocks.quizUpdate).toHaveBeenCalledWith('quiz-1', { assignment: { dueDate: null } });
    expect(mocks.auditCreate.mock.calls[0][0].data.fields).toEqual(['due_date']);

    await quizUpdateTool.handler(
      { classroom: 'org/w26', quiz_id: 'quiz-1', due_date: '2026-07-20T23:59:00-04:00' },
      CTX
    );
    expect(mocks.quizUpdate).toHaveBeenLastCalledWith('quiz-1', {
      assignment: { dueDate: '2026-07-20T23:59:00-04:00' },
    });
  });

  it('accepts null but not a malformed string for due_date', () => {
    const dueDate = quizUpdateTool.inputSchema.due_date;
    expect(dueDate.safeParse(null).success).toBe(true);
    expect(dueDate.safeParse(undefined).success).toBe(true);
    expect(dueDate.safeParse('2026-07-20T23:59:00-04:00').success).toBe(true);
    expect(dueDate.safeParse('next friday').success).toBe(false);
  });

  it.each([
    ['CLOSED', { status: 'CLOSED' }],
    ['DRAFT beside another field', { status: 'DRAFT', name: 'Renamed' }],
  ])(
    'refuses the removed status (%s) by name, naming what replaces it, before anything else',
    async (_case, extra) => {
      mocks.quizFindById.mockResolvedValue(QUIZ_ROW);

      await expect(
        quizUpdateTool.handler({ classroom: 'org/w26', quiz_id: 'quiz-1', ...extra }, CTX)
      ).rejects.toMatchObject({
        kind: 'invalid_params',
        message:
          'status is no longer accepted: use published:false to unpublish, closes_at to stop ' +
          'new attempts (null reopens), and quiz_publish to publish',
      });
      expect(mocks.assertProTier).not.toHaveBeenCalled();
      expect(mocks.quizFindById).not.toHaveBeenCalled();
      expect(mocks.quizUpdate).not.toHaveBeenCalled();
      expect(mocks.auditCreate).not.toHaveBeenCalled();
    }
  );

  it('keeps status in the schema only so it reaches the refusal, not stripped unseen', () => {
    // Unknown arguments are stripped before the handler runs.
    const parsed = z.object(quizUpdateTool.inputSchema).safeParse({
      classroom: 'org/w26',
      quiz_id: '11111111-1111-4111-8111-111111111111',
      status: 'CLOSED',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toHaveProperty('status', 'CLOSED');
  });

  it('takes published only as false', () => {
    // A close is closes_at; publishing would skip the notification path.
    const published = quizUpdateTool.inputSchema.published;
    expect(published.safeParse(false).success).toBe(true);
    expect(published.safeParse(undefined).success).toBe(true);
    expect(published.safeParse(true).success).toBe(false);
  });

  it('applies the same clamps as create', () => {
    const schema = z.object(quizUpdateTool.inputSchema);
    const base = { classroom: 'org/w26', quiz_id: '11111111-1111-4111-8111-111111111111' };
    expect(schema.safeParse({ ...base, question_count: 21 }).success).toBe(false);
    expect(schema.safeParse({ ...base, max_attempts: -1 }).success).toBe(false);
    expect(schema.safeParse({ ...base, weight: -1 }).success).toBe(false);
    expect(schema.safeParse({ ...base, tokens_per_hour: -1 }).success).toBe(false);
    expect(schema.safeParse({ ...base, rubric_prompt: '' }).success).toBe(false);
  });

  it('denies when the quiz surface is off (Pro / quizzes_enabled) before loading', async () => {
    mocks.assertProTier.mockRejectedValue(
      new Response('This feature requires a Pro subscription', { status: 403 })
    );
    await expect(quizUpdateTool.handler(ARGS, CTX)).rejects.toMatchObject({ kind: 'forbidden' });
    expect(mocks.quizFindById).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid_value', 'invalid_params'],
    ['module_not_found', 'not_found'],
  ])('maps the service’s QuizAssignmentError %s to %s, unaudited', async (code, kind) => {
    mocks.quizFindById.mockResolvedValue(QUIZ_ROW);
    mocks.quizUpdate.mockRejectedValue(quizAssignmentError(code, `refused: ${code}`));

    await expect(
      quizUpdateTool.handler({ ...ARGS, due_date: '2026-07-20T23:59:00-04:00' }, CTX)
    ).rejects.toMatchObject({ kind, message: `refused: ${code}` });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});

describe('quiz_update: an assistant edits content, not the assignment', () => {
  const BASE = { classroom: 'org/w26', quiz_id: 'quiz-1' };

  beforeEach(() => {
    mocks.quizFindById.mockResolvedValue(QUIZ_ROW);
    mocks.quizUpdate.mockResolvedValue(QUIZ_ROW);
  });

  it.each([
    ['module_id', MODULE_ID],
    ['release_at', '2026-07-13T09:00:00-04:00'],
    ['release_at', null],
    ['due_date', '2026-07-20T23:59:00-04:00'],
    ['due_date', null],
    ['closes_at', '2026-07-27T23:59:00-04:00'],
    ['closes_at', null],
    ['weight', 20],
    ['weight', 0],
    ['tokens_per_hour', 2],
    ['published', false],
  ] as const)('refuses %s (%s) before reading or writing anything', async (field, value) => {
    const error = await quizUpdateTool
      .handler({ ...BASE, [field]: value }, ASSISTANT_CTX)
      .catch((e: unknown) => e);

    expect(error).toMatchObject({
      kind: 'forbidden',
      code: 'INSUFFICIENT_ROLE',
      message:
        'Only the class owner or a teacher can change a quiz’s module, dates, weight, ' +
        'tokens per hour or publish state',
    });
    // Asked whether the assistant also holds an author role, and nothing else.
    expect(mocks.membershipFindByClassroomAndUser).toHaveBeenCalledWith('class-1', 'ta-1', [
      'OWNER',
      'TEACHER',
    ]);
    expect(mocks.quizFindById).not.toHaveBeenCalled();
    expect(mocks.quizUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('refuses a mixed call whole, without applying the content field', async () => {
    await expect(
      quizUpdateTool.handler({ ...BASE, name: 'Renamed', weight: 20 }, ASSISTANT_CTX)
    ).rejects.toMatchObject({ kind: 'forbidden' });
    expect(mocks.quizUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ['question_count', 7],
    ['max_attempts', 3],
    ['max_attempts', 0],
    ['grading_strategy', 'MOST_RECENT'],
  ] as const)(
    'refuses %s (%s), how the quiz is taken and scored, before reading or writing anything',
    async (field, value) => {
      const error = await quizUpdateTool
        .handler({ ...BASE, rubric_prompt: 'Ask about loops', [field]: value }, ASSISTANT_CTX)
        .catch((e: unknown) => e);

      expect(error).toMatchObject({
        kind: 'forbidden',
        code: 'INSUFFICIENT_ROLE',
        message:
          'Only the class owner or a teacher can change a quiz’s number of questions, max ' +
          'attempts or grading strategy',
      });
      expect(mocks.quizFindById).not.toHaveBeenCalled();
      expect(mocks.quizUpdate).not.toHaveBeenCalled();
      expect(mocks.auditCreate).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['question_count', 7, { questionCount: 7 }],
    ['max_attempts', 3, { maxAttempts: 3 }],
    ['grading_strategy', 'MOST_RECENT', { gradingStrategy: 'MOST_RECENT' }],
  ] as const)('lets a teacher set %s', async (field, value, forwarded) => {
    await quizUpdateTool.handler({ ...BASE, [field]: value }, TEACHER_CTX);
    expect(mocks.quizUpdate).toHaveBeenCalledWith('quiz-1', forwarded);
  });

  it.each([
    ['name', 'Renamed', { name: 'Renamed' }],
    ['rubric_prompt', 'Ask about loops', { rubricPrompt: 'Ask about loops' }],
    ['system_prompt', 'Be brief', { systemPrompt: 'Be brief' }],
    ['include_code_context', true, { includeCodeContext: true }],
    ['course_search_enabled', true, { courseSearchEnabled: true }],
    ['excluded_paths', ['tests/**'], { excludedPaths: ['tests/**'] }],
  ] as const)('lets %s through for an assistant', async (field, value, forwarded) => {
    const payload = parse(await quizUpdateTool.handler({ ...BASE, [field]: value }, ASSISTANT_CTX));

    expect(payload.success).toBe(true);
    expect(mocks.quizUpdate).toHaveBeenCalledWith('quiz-1', forwarded);
    // A content-only edit never needs the role lookup.
    expect(mocks.membershipFindByClassroomAndUser).not.toHaveBeenCalled();
  });

  it('lets a teacher change the due date', async () => {
    await quizUpdateTool.handler({ ...BASE, due_date: '2026-07-20T23:59:00-04:00' }, TEACHER_CTX);
    expect(mocks.quizUpdate).toHaveBeenCalledWith('quiz-1', {
      assignment: { dueDate: '2026-07-20T23:59:00-04:00' },
    });
    // TEACHER is an author on its own; no membership lookup needed.
    expect(mocks.membershipFindByClassroomAndUser).not.toHaveBeenCalled();
  });

  it('lets an assistant who also holds TEACHER change the weight', async () => {
    mocks.membershipFindByClassroomAndUser.mockResolvedValue({ id: 'm-9', role: 'TEACHER' });
    await quizUpdateTool.handler({ ...BASE, weight: 20 }, ASSISTANT_CTX);
    expect(mocks.quizUpdate).toHaveBeenCalledWith('quiz-1', { assignment: { weight: 20 } });
  });
});

describe('quiz_publish', () => {
  const ARGS = { classroom: 'org/w26', quiz_id: 'quiz-1' };

  /** What quiz.publish returns: the row plus what the publish did. */
  const publishResult = (wasPublished: boolean, notified: boolean) => ({
    ...QUIZ_ROW,
    status: 'PUBLISHED',
    assignment: { ...ASSIGNMENT, is_published: true },
    wasPublished,
    notified,
    sourceMaterialAllDraft: false,
  });

  it('publishes a draft and reports that students were notified', async () => {
    mocks.quizFindById.mockResolvedValue(QUIZ_ROW); // status DRAFT
    mocks.quizPublish.mockResolvedValue(publishResult(false, true));

    const payload = parse(await quizPublishTool.handler(ARGS, CTX));
    expect(payload).toMatchObject({
      success: true,
      previous_status: 'DRAFT',
      students_notified: true,
      message: 'Quiz published — students have been notified.',
    });
    expect(mocks.quizPublish).toHaveBeenCalledWith('quiz-1');
    // The bookkeeping fields are not part of the quiz summary.
    expect(payload.quiz).not.toHaveProperty('notified');
    expect(payload.quiz).not.toHaveProperty('wasPublished');

    const audit = mocks.auditCreate.mock.calls[0][0] as {
      action: string;
      data: { students_notified: boolean };
    };
    expect(audit.action).toBe('UPDATE');
    expect(audit.data.students_notified).toBe(true);
  });

  it('is idempotent: republishing reports that nobody was notified', async () => {
    mocks.quizFindById.mockResolvedValue({
      ...QUIZ_ROW,
      status: 'PUBLISHED',
      assignment: { ...ASSIGNMENT, is_published: true },
    });
    mocks.quizPublish.mockResolvedValue(publishResult(true, false));

    const payload = parse(await quizPublishTool.handler(ARGS, CTX));
    expect(payload.students_notified).toBe(false);
    expect(payload.previous_status).toBe('PUBLISHED');
    expect(payload.message).toBe(
      'Quiz was already published — nothing changed and no notifications were sent.'
    );
    expect(quizPublishTool.annotations?.idempotent).toBe(true);
  });

  it('takes students_notified from the service, not from the previous status', async () => {
    // A draft published before it opens: the service tells nobody yet.
    mocks.quizFindById.mockResolvedValue(QUIZ_ROW); // status DRAFT
    mocks.quizPublish.mockResolvedValue(publishResult(false, false));

    const payload = parse(await quizPublishTool.handler(ARGS, CTX));
    expect(payload).toMatchObject({
      success: true,
      previous_status: 'DRAFT',
      students_notified: false,
      message: 'Quiz published — no notifications were sent.',
    });
    const audit = mocks.auditCreate.mock.calls[0][0] as { data: { students_notified: boolean } };
    expect(audit.data.students_notified).toBe(false);
  });

  it('refuses a quiz in no module before publishing, naming module_id, unaudited', async () => {
    mocks.quizFindById.mockResolvedValue({ ...QUIZ_ROW, assignment: null });

    await expect(quizPublishTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
      message: 'This quiz is in no module: set its module_id with quiz_update, then publish it.',
    });
    expect(mocks.quizPublish).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('reads the previous status off the assignment, not the quiz’s own column', async () => {
    // The quiz's own status says PUBLISHED (written at its last save); its
    // assignment is published and past its close date.
    mocks.quizFindById.mockResolvedValue({
      ...QUIZ_ROW,
      status: 'PUBLISHED',
      assignment: { ...ASSIGNMENT, is_published: true, closes_at: new Date(Date.now() - 1000) },
    });
    mocks.quizPublish.mockResolvedValue(publishResult(true, false));

    const payload = parse(await quizPublishTool.handler(ARGS, CTX));
    expect(payload.previous_status).toBe('CLOSED');
  });

  it('answers a quiz gone since it was loaded as not_found', async () => {
    mocks.quizFindById.mockResolvedValue(QUIZ_ROW);
    mocks.quizPublish.mockRejectedValue(quizAssignmentError('not_found', 'Quiz not found'));

    await expect(quizPublishTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  describe('source material all draft', () => {
    const WARNING =
      'All source material is still draft; students will not be able to start this quiz.';
    const doc = (id: string, is_draft: boolean, order: number) => ({
      kind: 'page',
      id,
      title: `Doc ${id}`,
      is_draft,
      order,
    });

    // The material rides on the loaded row only: quiz.publish returns the bare
    // row, so the warning must be decided from the findById read.
    async function publishWith(source_material: unknown[]) {
      mocks.quizFindById.mockResolvedValue({ ...QUIZ_ROW, source_material });
      mocks.quizPublish.mockResolvedValue(publishResult(false, true));
      return parse(await quizPublishTool.handler(ARGS, CTX));
    }

    it('warns, in the payload and the message, when every linked doc is a draft', async () => {
      const payload = await publishWith([doc('p1', true, 0), doc('p2', true, 1)]);
      expect(payload.success).toBe(true);
      expect(payload.warning).toBe(WARNING);
      expect(payload.message).toContain(WARNING);
      expect(mocks.quizPublish).toHaveBeenCalledWith('quiz-1');
    });

    it('does not warn when at least one linked doc is published', async () => {
      const payload = await publishWith([doc('p1', true, 0), doc('p2', false, 1)]);
      expect(payload).not.toHaveProperty('warning');
      expect(payload.message).not.toContain('Warning');
    });

    it('does not warn when the quiz has no source material', async () => {
      const payload = await publishWith([]);
      expect(payload).not.toHaveProperty('warning');
      expect(payload.message).not.toContain('Warning');
    });
  });

  it('refuses a quiz from another classroom (S1) and never publishes', async () => {
    mocks.quizFindById.mockResolvedValue({ ...QUIZ_ROW, classroom_id: 'OTHER-class' });
    await expect(quizPublishTool.handler(ARGS, CTX)).rejects.toMatchObject({ kind: 'not_found' });
    expect(mocks.quizPublish).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('denies when quizzes are disabled for the classroom', async () => {
    const disabled = ctxWithSettings({ quizzes_enabled: false });
    await expect(quizPublishTool.handler(ARGS, disabled)).rejects.toMatchObject({
      kind: 'forbidden',
    });
    expect(mocks.quizPublish).not.toHaveBeenCalled();
  });
});

describe('quiz_delete', () => {
  const ARGS = { classroom: 'org/w26', quiz_id: 'quiz-1', confirm: true as const };

  it('deletes the quiz and records the cascade blast radius', async () => {
    mocks.quizFindById.mockResolvedValue(QUIZ_ROW);
    mocks.quizDelete.mockResolvedValue({ id: 'quiz-1' });

    const payload = parse(await quizDeleteTool.handler(ARGS, CTX));
    expect(payload).toMatchObject({
      success: true,
      deleted_quiz_id: 'quiz-1',
      attempts_deleted: 1,
    });
    expect(mocks.quizDelete).toHaveBeenCalledWith('quiz-1');

    const audit = mocks.auditCreate.mock.calls[0][0] as {
      action: string;
      classroom_id: string;
      data: { attempts_deleted: number };
    };
    expect(audit.action).toBe('DELETE');
    expect(audit.classroom_id).toBe('class-1');
    // Student attempts cascade-delete with the quiz (schema: QuizAttempt.quiz
    // onDelete: Cascade) — the count is preserved in the audit trail.
    expect(audit.data.attempts_deleted).toBe(1);
  });

  it('requires confirm:true in the schema (destructive gate)', () => {
    const confirm = quizDeleteTool.inputSchema.confirm;
    expect(confirm.safeParse(true).success).toBe(true);
    expect(confirm.safeParse(false).success).toBe(false);
    expect(confirm.safeParse(undefined).success).toBe(false);
    expect(quizDeleteTool.annotations?.destructive).toBe(true);
  });

  it('refuses a quiz from another classroom (S1) and never deletes', async () => {
    mocks.quizFindById.mockResolvedValue({ ...QUIZ_ROW, classroom_id: 'OTHER-class' });
    await expect(quizDeleteTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
      message: 'Quiz not found in this classroom',
    });
    expect(mocks.quizDelete).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('denies without a Pro subscription before loading the quiz', async () => {
    mocks.assertProTier.mockRejectedValue(
      new Response('This feature requires a Pro subscription', { status: 403 })
    );
    await expect(quizDeleteTool.handler(ARGS, CTX)).rejects.toMatchObject({ kind: 'forbidden' });
    expect(mocks.quizFindById).not.toHaveBeenCalled();
    expect(mocks.quizDelete).not.toHaveBeenCalled();
  });
});
