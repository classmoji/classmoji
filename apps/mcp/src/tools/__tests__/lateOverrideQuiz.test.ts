/**
 * submission_late_override, quiz mode (#813, D3): staff's late waiver for one
 * student on one quiz, through the same tool as the repo shield.
 *
 * The handler with `@classmoji/services` mocked (selectors, scoping, the
 * refusals, idempotency, the audit row and the response), then the REGISTRY
 * pipeline (who may call it). The service's own scoping (a QUIZ of this
 * classroom, an accepted STUDENT of it) is pinned in
 * packages/services/src/classmoji/__tests__/quizLateWaiver.*.test.ts.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext, ToolDefinition } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  setQuizLateWaiver: vi.fn(),
  setLateOverride: vi.fn(),
  assignmentFindById: vi.fn(),
  quizFindById: vi.fn(),
  quizzesVisible: vi.fn(),
  quizzesVisibleOrThrow: vi.fn(),
  auditCreate: vi.fn(),
  classroomFindAll: vi.fn(),
  findByClassroomAndUser: vi.fn(),
}));

vi.mock('@classmoji/database', async () =>
  (await import('../../__tests__/prismaSchemaStub.ts')).databaseModuleMock()
);

vi.mock('@classmoji/services', () => ({
  HelperService: {},
  ClassmojiService: {
    quizLateWaiver: {
      setQuizLateWaiver: (...a: unknown[]) => mocks.setQuizLateWaiver(...a),
    },
    gitRepoAssignment: {
      setLateOverrideInClassroom: (...a: unknown[]) => mocks.setLateOverride(...a),
    },
    assignment: { findById: (...a: unknown[]) => mocks.assignmentFindById(...a) },
    quiz: { findById: (...a: unknown[]) => mocks.quizFindById(...a) },
    entitlement: {
      quizzesVisible: (...a: unknown[]) => mocks.quizzesVisible(...a),
      quizzesVisibleOrThrow: (...a: unknown[]) => mocks.quizzesVisibleOrThrow(...a),
    },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
    classroom: {
      findAll: (...a: unknown[]) => mocks.classroomFindAll(...a),
      getClassroomForUI: (c: unknown) => c,
      getTimeZone: async () => null,
    },
    classroomMembership: {
      findByClassroomAndUser: (...a: unknown[]) => mocks.findByClassroomAndUser(...a),
    },
  },
}));

const { submissionLateOverrideTool } = await import('../lateOverride.ts');
const { buildMcpServer, registerToolDefinition } = await import('../../mcp/registry.ts');
const { resetRateLimits } = await import('../../mcp/rateLimit.ts');

const QUIZ_ID = '22222222-2222-4222-8222-222222222222';
const QUIZ_ASSIGNMENT = '33333333-3333-4333-8333-333333333333';
const REPO_ASSIGNMENT = '44444444-4444-4444-8444-444444444444';
const FOREIGN_ASSIGNMENT = '55555555-5555-4555-8555-555555555555';
const FOREIGN_QUIZ = '66666666-6666-4666-8666-666666666666';
const STUDENT_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const STUDENT_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const SUB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const CTX: ToolContext = {
  viewer: { userId: 'teacher-1', clientId: 'c', scopes: new Set(['read', 'write']) },
  classroom: {
    classroomId: 'class-1',
    role: 'TEACHER',
    status: 'ACTIVE',
    membership: { id: 'm-1', role: 'TEACHER' },
    classroom: { settings: {} },
  },
} as unknown as ToolContext;

/** The service's refusal, as `quizLateWaiver.service.ts` throws it. */
class QuizLateWaiverError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.name = 'QuizLateWaiverError';
    this.code = code;
  }
}

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

const auditRows = () =>
  mocks.auditCreate.mock.calls.map(
    c =>
      c[0] as {
        user_id: string;
        classroom_id: string;
        role: string;
        resource_type: string;
        resource_id: string;
        action: string;
        data: Record<string, unknown>;
      }
  );

const handle = (args: Record<string, unknown>, ctx: ToolContext = CTX) =>
  submissionLateOverrideTool.handler(
    { classroom: 'org/c', is_late_override: true, ...args } as never,
    ctx
  );

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.auditCreate.mockResolvedValue(undefined);
  mocks.quizzesVisible.mockResolvedValue(true);
  mocks.quizzesVisibleOrThrow.mockResolvedValue(true);
  // Assignments: a QUIZ and a REPO one in class-1, one QUIZ in class-2.
  mocks.assignmentFindById.mockImplementation(async (id: string) => {
    if (id === QUIZ_ASSIGNMENT) {
      return { id, type: 'QUIZ', module: { classroom_id: 'class-1' }, repository: null };
    }
    if (id === REPO_ASSIGNMENT) {
      return {
        id,
        type: 'REPO',
        module: { classroom_id: 'class-1' },
        repository: { classroom_id: 'class-1' },
      };
    }
    if (id === FOREIGN_ASSIGNMENT) {
      return { id, type: 'QUIZ', module: { classroom_id: 'class-2' }, repository: null };
    }
    return null;
  });
  mocks.quizFindById.mockImplementation(async (id: string) => {
    if (id === QUIZ_ID) {
      return { id, classroom_id: 'class-1', assignment: { id: QUIZ_ASSIGNMENT } };
    }
    if (id === FOREIGN_QUIZ) {
      return { id, classroom_id: 'class-2', assignment: { id: FOREIGN_ASSIGNMENT } };
    }
    return null;
  });
  mocks.setQuizLateWaiver.mockResolvedValue({ changed: true, waived: true, quizId: QUIZ_ID });
  resetRateLimits();
});

// ─── Selectors ───────────────────────────────────────────────────────────────

describe('submission_late_override (quiz) — selectors', () => {
  const refusals: Array<[string, Record<string, unknown>]> = [
    ['quiz_id without student_id', { quiz_id: QUIZ_ID }],
    ['quiz_id + assignment_id', { quiz_id: QUIZ_ID, assignment_id: QUIZ_ASSIGNMENT }],
    ['quiz_id + submission id', { quiz_id: QUIZ_ID, git_repo_assignment_id: SUB_A }],
    ['student_id alone', { student_id: STUDENT_A }],
    ['student_id + submission id', { student_id: STUDENT_A, git_repo_assignment_id: SUB_A }],
    ['student_id + submission ids', { student_id: STUDENT_A, git_repo_assignment_ids: [SUB_A] }],
  ];

  it.each(refusals)('refuses %s before any lookup or write', async (_label, args) => {
    await expect(handle(args)).rejects.toMatchObject({ kind: 'invalid_params' });
    expect(mocks.assignmentFindById).not.toHaveBeenCalled();
    expect(mocks.quizFindById).not.toHaveBeenCalled();
    expect(mocks.setQuizLateWaiver).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('refuses a QUIZ assignment_id without student_id: never the whole class', async () => {
    await expect(handle({ assignment_id: QUIZ_ASSIGNMENT })).rejects.toMatchObject({
      kind: 'invalid_params',
      message: expect.stringContaining('needs student_id'),
    });
    expect(mocks.setQuizLateWaiver).not.toHaveBeenCalled();
    expect(mocks.setLateOverride).not.toHaveBeenCalled();
  });

  it("answers another classroom's quiz assignment_id without student_id as not_found", async () => {
    await expect(handle({ assignment_id: FOREIGN_ASSIGNMENT })).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(mocks.setLateOverride).not.toHaveBeenCalled();
  });

  it('refuses student_id with a REPO assignment', async () => {
    await expect(
      handle({ assignment_id: REPO_ASSIGNMENT, student_id: STUDENT_A })
    ).rejects.toMatchObject({ kind: 'invalid_params' });
    expect(mocks.setQuizLateWaiver).not.toHaveBeenCalled();
    expect(mocks.setLateOverride).not.toHaveBeenCalled();
  });

  it('refuses a quiz that is in no module (no assignment, no due date)', async () => {
    mocks.quizFindById.mockResolvedValue({
      id: QUIZ_ID,
      classroom_id: 'class-1',
      assignment: null,
    });
    await expect(handle({ quiz_id: QUIZ_ID, student_id: STUDENT_A })).rejects.toMatchObject({
      kind: 'invalid_params',
    });
    expect(mocks.setQuizLateWaiver).not.toHaveBeenCalled();
  });

  it.each([
    ['quiz_id', { quiz_id: QUIZ_ID }],
    ['a quiz assignment_id', { assignment_id: QUIZ_ASSIGNMENT }],
  ])(
    'refuses %s where the quiz tools hide quizzes, even if the entitlement alone would show them',
    async (_label, sel) => {
      // The two predicates differ (no AI agent configured): the quiz tools'
      // `quizzesVisibleOrThrow` decides, for both selectors, before any lookup.
      mocks.quizzesVisible.mockResolvedValue(true);
      mocks.quizzesVisibleOrThrow.mockResolvedValue(false);
      await expect(handle({ ...sel, student_id: STUDENT_A })).rejects.toMatchObject({
        kind: 'forbidden',
      });
      expect(mocks.assignmentFindById).not.toHaveBeenCalled();
      expect(mocks.quizFindById).not.toHaveBeenCalled();
      expect(mocks.setQuizLateWaiver).not.toHaveBeenCalled();
    }
  );

  it('answers a hidden quiz assignment_id without student_id as not_found, not "needs student_id"', async () => {
    mocks.quizzesVisibleOrThrow.mockResolvedValue(false);
    await expect(handle({ assignment_id: QUIZ_ASSIGNMENT })).rejects.toMatchObject({
      kind: 'not_found',
    });
  });

  it('says a FORM assignment is not a quiz, without naming repo selectors', async () => {
    mocks.assignmentFindById.mockResolvedValue({
      id: REPO_ASSIGNMENT,
      type: 'FORM',
      module: { classroom_id: 'class-1' },
      repository: null,
    });
    const err = await handle({ assignment_id: REPO_ASSIGNMENT, student_id: STUDENT_A }).catch(
      e => e
    );
    expect(err).toMatchObject({ kind: 'invalid_params' });
    expect(err.message).toContain('not a quiz');
    expect(err.message).not.toMatch(/repo/i);
  });
});

// ─── Writes ──────────────────────────────────────────────────────────────────

describe('submission_late_override (quiz) — set and clear', () => {
  it.each([
    ['quiz_id', { quiz_id: QUIZ_ID }],
    ['a quiz assignment_id', { assignment_id: QUIZ_ASSIGNMENT }],
  ])('sets the waiver by %s, scoped to this classroom and that student', async (_l, sel) => {
    const result = parse(await handle({ ...sel, student_id: STUDENT_A }));

    expect(mocks.setQuizLateWaiver).toHaveBeenCalledExactlyOnceWith({
      classroomId: 'class-1',
      assignmentId: QUIZ_ASSIGNMENT,
      studentId: STUDENT_A,
      waived: true,
      actorId: 'teacher-1',
    });
    expect(result).toEqual({
      success: true,
      is_late_override: true,
      mode: 'quiz',
      assignment_id: QUIZ_ASSIGNMENT,
      quiz_id: QUIZ_ID,
      student_id: STUDENT_A,
      updated_count: 1,
      unchanged_count: 0,
    });
  });

  it('writes one audit row per change, in the web shield shape, never deduped', async () => {
    await handle({ quiz_id: QUIZ_ID, student_id: STUDENT_A });

    expect(auditRows()).toEqual([
      expect.objectContaining({
        user_id: 'teacher-1',
        classroom_id: 'class-1',
        role: 'TEACHER',
        resource_type: 'QUIZ_LATE_WAIVER',
        resource_id: QUIZ_ASSIGNMENT,
        action: 'UPDATE',
        data: {
          tool: 'submission_late_override',
          kind: 'quiz',
          field: 'quiz_late_waiver',
          value: true,
          assignment_id: QUIZ_ASSIGNMENT,
          quiz_id: QUIZ_ID,
          student_id: STUDENT_A,
        },
      }),
    ]);
    expect(mocks.auditCreate.mock.calls[0][1]).toEqual({ dedupe: false });
  });

  it('clears the waiver (false) and records the value', async () => {
    mocks.setQuizLateWaiver.mockResolvedValue({ changed: true, waived: false, quizId: QUIZ_ID });

    const result = parse(
      await handle({ quiz_id: QUIZ_ID, student_id: STUDENT_A, is_late_override: false })
    );

    expect(mocks.setQuizLateWaiver).toHaveBeenCalledWith(
      expect.objectContaining({ waived: false })
    );
    expect(result).toMatchObject({ is_late_override: false, updated_count: 1 });
    expect(auditRows()[0].data).toMatchObject({ value: false });
  });

  it('is idempotent: a repeat that changes nothing writes no audit row', async () => {
    mocks.setQuizLateWaiver.mockResolvedValue({ changed: false, waived: true, quizId: QUIZ_ID });

    const result = parse(await handle({ quiz_id: QUIZ_ID, student_id: STUDENT_A }));

    expect(result).toMatchObject({ updated_count: 0, unchanged_count: 1 });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('still reports the change when its audit row fails, flagged audit_incomplete', async () => {
    mocks.auditCreate.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = parse(await handle({ quiz_id: QUIZ_ID, student_id: STUDENT_A }));

    expect(result).toMatchObject({ updated_count: 1, audit_incomplete: true });
  });
});

// ─── Scoping: classroom X vs Y, student A vs B ───────────────────────────────

describe('submission_late_override (quiz) — scoping', () => {
  it("answers another classroom's quiz as not_found, before the service", async () => {
    await expect(handle({ quiz_id: FOREIGN_QUIZ, student_id: STUDENT_A })).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(mocks.setQuizLateWaiver).not.toHaveBeenCalled();
  });

  it("answers another classroom's quiz assignment as not_found, before the service", async () => {
    await expect(
      handle({ assignment_id: FOREIGN_ASSIGNMENT, student_id: STUDENT_A })
    ).rejects.toMatchObject({ kind: 'not_found' });
    expect(mocks.setQuizLateWaiver).not.toHaveBeenCalled();
  });

  it('answers a student who is not a STUDENT here as not_found, and writes nothing', async () => {
    mocks.setQuizLateWaiver.mockImplementation(async ({ studentId }: { studentId: string }) => {
      if (studentId === STUDENT_B) throw new QuizLateWaiverError('not_student');
      return { changed: true, waived: true, quizId: QUIZ_ID };
    });

    await expect(handle({ quiz_id: QUIZ_ID, student_id: STUDENT_B })).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();

    // Student A in the same classroom is unaffected, and only A is named.
    await handle({ quiz_id: QUIZ_ID, student_id: STUDENT_A });
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0].data).toMatchObject({ student_id: STUDENT_A });
  });

  it.each([
    ['not_found', 'not_found'],
    ['not_quiz', 'invalid_params'],
    ['self', 'forbidden'],
  ])("maps the service's %s to %s", async (code, kind) => {
    mocks.setQuizLateWaiver.mockRejectedValue(new QuizLateWaiverError(code));
    await expect(handle({ quiz_id: QUIZ_ID, student_id: STUDENT_A })).rejects.toMatchObject({
      kind,
    });
  });

  it('lets any other error through unchanged', async () => {
    mocks.setQuizLateWaiver.mockRejectedValue(new Error('boom'));
    await expect(handle({ quiz_id: QUIZ_ID, student_id: STUDENT_A })).rejects.toThrow('boom');
  });
});

// ─── Registry pipeline: roles + classroom status ─────────────────────────────

describe('submission_late_override (quiz) — through the registry', () => {
  let viewerSeq = 0;

  beforeAll(() => {
    registerToolDefinition(submissionLateOverrideTool as unknown as ToolDefinition<never>);
  });

  function mockClassroom(status: string, memberRole: string) {
    mocks.classroomFindAll.mockResolvedValue([{ id: 'class-1', status, slug: 'c' }]);
    mocks.findByClassroomAndUser.mockImplementation(
      async (_classroomId: string, _userId: string, roles: string[] | null) => {
        if (roles && !roles.includes(memberRole)) return null;
        return { id: 'membership-1', role: memberRole };
      }
    );
  }

  async function call(args: Record<string, unknown>) {
    viewerSeq += 1;
    const server = buildMcpServer({
      userId: `user-${viewerSeq}`,
      clientId: 'late-override-quiz-test',
      scopes: new Set(['read', 'write']),
    } as never);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'late-override-quiz-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return (await client.callTool({ name: 'submission_late_override', arguments: args })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
  }

  const ARGS = {
    classroom: 'org/c',
    quiz_id: QUIZ_ID,
    student_id: STUDENT_A,
    is_late_override: true,
  };

  it.each(['OWNER', 'TEACHER'])('lets %s set a quiz waiver', async role => {
    mockClassroom('ACTIVE', role);

    const result = await call(ARGS);
    expect(result.isError).toBeFalsy();
    expect(parse(result)).toMatchObject({ mode: 'quiz', updated_count: 1 });
    expect(auditRows()[0]).toMatchObject({ role, resource_type: 'QUIZ_LATE_WAIVER' });
  });

  it.each(['ASSISTANT', 'STUDENT'])('refuses %s before the handler runs', async role => {
    mockClassroom('ACTIVE', role);

    const result = await call(ARGS);
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ error: 'forbidden' });
    expect(mocks.setQuizLateWaiver).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('refuses a TEACHER on a LOCKED classroom (the webapp mutation gate)', async () => {
    mockClassroom('LOCKED', 'TEACHER');

    const result = await call(ARGS);
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ error: 'forbidden', code: 'CLASSROOM_LOCKED' });
    expect(mocks.setQuizLateWaiver).not.toHaveBeenCalled();
  });

  it('keeps quiz_id and student_id uuids at the schema', async () => {
    mockClassroom('ACTIVE', 'OWNER');
    expect((await call({ ...ARGS, quiz_id: 'nope' })).isError).toBe(true);
    expect((await call({ ...ARGS, student_id: 'nope' })).isError).toBe(true);
    expect(mocks.setQuizLateWaiver).not.toHaveBeenCalled();
  });
});
