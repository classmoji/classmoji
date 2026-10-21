/**
 * Unit tests for regrade_create idempotency (finding F1).
 *
 * A slow `request_regrade` run can materialize its RegradeRequest only AFTER
 * the 60s client poll times out; a client retry would then enqueue a second
 * run → duplicate IN_REVIEW rows + duplicate grader emails. The tool now checks
 * regradeRequest.findOpenByAssignmentId for THIS student before triggering: an
 * existing open request is returned idempotently WITHOUT a second trigger.
 *
 * `@classmoji/services` and `@trigger.dev/sdk` are mocked (factory idiom); the
 * trigger spy asserts zero enqueues on the idempotent path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  findOpenByAssignmentId: vi.fn(),
  findMany: vi.fn(),
  auditCreate: vi.fn(),
  trigger: vi.fn(),
  retrieve: vi.fn(),
  quizzesVisibleOrThrow: vi.fn(),
  createForQuizAttempt: vi.fn(),
  resolveQuiz: vi.fn(),
  attemptFindUnique: vi.fn(),
}));

vi.mock('@classmoji/database', async () => ({
  ...(await vi.importActual<typeof import('@classmoji/database/gitIdentity')>(
    '@classmoji/database/gitIdentity'
  )),
  default: () => ({
    quizAttempt: { findUnique: (...a: unknown[]) => mocks.attemptFindUnique(...a) },
  }),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    gitRepoAssignment: { findById: (...a: unknown[]) => mocks.findById(...a) },
    regradeRequest: {
      findOpenByAssignmentId: (...a: unknown[]) => mocks.findOpenByAssignmentId(...a),
      findMany: (...a: unknown[]) => mocks.findMany(...a),
      createForQuizAttempt: (...a: unknown[]) => mocks.createForQuizAttempt(...a),
      resolveQuiz: (...a: unknown[]) => mocks.resolveQuiz(...a),
    },
    entitlement: { quizzesVisibleOrThrow: (...a: unknown[]) => mocks.quizzesVisibleOrThrow(...a) },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
  },
}));

vi.mock('@trigger.dev/sdk', () => ({
  tasks: { trigger: (...a: unknown[]) => mocks.trigger(...a) },
  runs: { retrieve: (...a: unknown[]) => mocks.retrieve(...a) },
}));

const { regradeCreateTool, regradeResolveTool } = await import('../regrades.ts');
const { toolAnnotations } = await import('../../mcp/registry.ts');

const CTX: ToolContext = {
  viewer: { userId: 'student-1', clientId: 'c', scopes: new Set(['read', 'write']) },
  classroom: {
    classroomId: 'class-1',
    role: 'STUDENT',
    status: 'ACTIVE',
    membership: { id: 'm-1', role: 'STUDENT' },
    classroom: { settings: {} },
  },
} as unknown as ToolContext;

const ARGS = {
  classroom: 'org/winter-2025',
  git_repo_assignment_id: 'gra-1',
  comment: 'please regrade',
};

/** GitRepoAssignment record for an individual submission owned by student-1. */
const GRA = {
  id: 'gra-1',
  git_repo: { classroom_id: 'class-1', student_id: 'student-1' },
  grades: [{ emoji: '🎯' }, { emoji: '✅' }],
};

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.findById.mockResolvedValue(GRA);
  mocks.auditCreate.mockResolvedValue(undefined);
});

describe('regrade_create idempotency (F1)', () => {
  it('returns an existing IN_REVIEW request WITHOUT triggering a second run', async () => {
    mocks.findOpenByAssignmentId.mockResolvedValue({
      id: 'rr-existing',
      status: 'IN_REVIEW',
      previous_grade: ['🎯', '✅'],
      student_id: 'student-1',
    });

    const result = await regradeCreateTool.handler(ARGS, CTX);
    const payload = parse(result);

    expect(payload.success).toBe(true);
    expect(payload.regrade_request.id).toBe('rr-existing');
    expect(payload.regrade_request.status).toBe('IN_REVIEW');
    // The whole point of F1: no second enqueue (and thus no duplicate email).
    expect(mocks.trigger).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('triggers exactly one run when no open request exists yet', async () => {
    mocks.findOpenByAssignmentId.mockResolvedValue(null);
    mocks.trigger.mockResolvedValue({ id: 'run-1' });
    mocks.retrieve.mockResolvedValue({
      status: 'COMPLETED',
      output: { id: 'rr-new', status: 'IN_REVIEW', previous_grade: ['🎯', '✅'] },
    });

    const result = await regradeCreateTool.handler(ARGS, CTX);
    const payload = parse(result);

    expect(mocks.trigger).toHaveBeenCalledTimes(1);
    expect(mocks.trigger).toHaveBeenCalledWith(
      'request_regrade',
      expect.objectContaining({
        classroom_id: 'class-1',
        student_id: 'student-1',
        previous_grade: ['🎯', '✅'],
      })
    );
    expect(payload.regrade_request.id).toBe('rr-new');
  });
});

describe('regrade_create with a numeric (ISSUE-mode) submission id', () => {
  const NUMERIC_ID = '5482151816';

  it('accepts the numeric id at the schema and passes it through to the task', async () => {
    const field = regradeCreateTool.inputSchema.git_repo_assignment_id as z.ZodTypeAny;
    expect(field.safeParse(NUMERIC_ID).success).toBe(true);
    expect(field.safeParse('not-an-id').success).toBe(false);

    mocks.findById.mockResolvedValue({ ...GRA, id: NUMERIC_ID });
    mocks.findOpenByAssignmentId.mockResolvedValue(null);
    mocks.trigger.mockResolvedValue({ id: 'run-1' });
    mocks.retrieve.mockResolvedValue({
      status: 'COMPLETED',
      output: { id: 'rr-new', status: 'IN_REVIEW', previous_grade: ['🎯', '✅'] },
    });

    await regradeCreateTool.handler({ ...ARGS, git_repo_assignment_id: NUMERIC_ID }, CTX);
    expect(mocks.findById).toHaveBeenCalledWith(NUMERIC_ID);
    expect(mocks.trigger).toHaveBeenCalledWith(
      'request_regrade',
      expect.objectContaining({ gitRepoAssignment: expect.objectContaining({ id: NUMERIC_ID }) })
    );
  });
});

// ─── U11: regrade_resolve idempotency (no duplicate resolution email) ────────

describe('regrade_resolve idempotency (U11)', () => {
  const RESOLVE_ARGS = {
    classroom: 'org/winter-2025',
    regrade_request_id: 'rr-1',
    resolution: 'APPROVED' as const,
  };

  /** loadRegradeRequestInClassroom reads findMany()[0]; classroom_id must match. */
  function requestWithStatus(status: string) {
    return [
      {
        id: 'rr-1',
        classroom_id: 'class-1',
        status,
        student: { email: 's@example.com' },
        git_repo_assignment: { assignment: { title: 'Lab 1' } },
      },
    ];
  }

  it('returns the recorded resolution WITHOUT re-triggering when already terminal', async () => {
    mocks.findMany.mockResolvedValue(requestWithStatus('APPROVED'));

    const payload = parse(await regradeResolveTool.handler(RESOLVE_ARGS, CTX));
    expect(payload.already_resolved).toBe(true);
    expect(payload.regrade_request.status).toBe('APPROVED');
    // The whole point of U11: no second task run, so no duplicate email.
    expect(mocks.trigger).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('triggers the resolution task once for an IN_REVIEW request', async () => {
    mocks.findMany.mockResolvedValue(requestWithStatus('IN_REVIEW'));
    mocks.trigger.mockResolvedValue({ id: 'run-1' });
    mocks.retrieve.mockResolvedValue({ status: 'COMPLETED', output: {} });

    const payload = parse(await regradeResolveTool.handler(RESOLVE_ARGS, CTX));
    expect(mocks.trigger).toHaveBeenCalledTimes(1);
    expect(mocks.trigger).toHaveBeenCalledWith('update_regrade_request', expect.any(Object));
    expect(payload.regrade_request.status).toBe('APPROVED');
    expect(payload.already_resolved).toBeUndefined();
  });
});

// ─── Quiz targets ────────────────────────────────────────────────────────────

/** A QuizGradeError as the service throws it (matched by name). */
class QuizGradeError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'QuizGradeError';
    this.code = code;
    this.status = status;
  }
}

const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';

/** The attempt as quizTarget reads it. */
const attemptRow = (classroomId = 'class-1') => ({
  id: ATTEMPT_ID,
  attempt_number: 2,
  quiz: { id: 'quiz-1', name: 'Quiz 1', classroom_id: classroomId },
});

const STAFF_CTX: ToolContext = {
  viewer: {
    userId: 'ta-1',
    clientId: 'c',
    scopes: new Set(['read', 'write']),
    impersonatedBy: null,
  },
  classroom: {
    classroomId: 'class-1',
    role: 'ASSISTANT',
    status: 'ACTIVE',
    membership: { id: 'm-2', role: 'ASSISTANT' },
    classroom: { settings: {} },
  },
} as unknown as ToolContext;

/** Every [key, value] in a JSON value, at any depth. */
const entriesOf = (value: unknown): Array<[string, unknown]> =>
  Array.isArray(value)
    ? value.flatMap(entriesOf)
    : value && typeof value === 'object'
      ? Object.entries(value).flatMap(([k, v]) => [[k, v] as [string, unknown], ...entriesOf(v)])
      : [];

describe('regrade_create on a quiz attempt', () => {
  const QUIZ_ARGS = { classroom: 'org/winter-2025', quiz_attempt_id: ATTEMPT_ID, comment: 'Q3' };

  beforeEach(() => {
    mocks.quizzesVisibleOrThrow.mockResolvedValue(true);
    mocks.attemptFindUnique.mockResolvedValue(attemptRow());
    mocks.createForQuizAttempt.mockResolvedValue({
      request: {
        id: REQUEST_ID,
        status: 'IN_REVIEW',
        student_comment: 'Q3',
        previous_grade: ['-1'],
      },
      created: true,
      classroomId: 'class-1',
      quiz: { id: 'quiz-1', name: 'Quiz 1', assignmentTitle: 'Quiz 1' },
    });
  });

  it("asks the service for the caller's own attempt, with no task and no second audit row", async () => {
    const payload = parse(await regradeCreateTool.handler(QUIZ_ARGS, CTX));

    expect(mocks.createForQuizAttempt).toHaveBeenCalledWith({
      attemptId: ATTEMPT_ID,
      comment: 'Q3',
      actorUserId: 'student-1',
      tool: 'regrade_create',
      impersonatedBy: null,
    });
    expect(payload).toEqual({
      success: true,
      created: true,
      regrade_request: {
        id: REQUEST_ID,
        status: 'IN_REVIEW',
        target: 'quiz',
        student_comment: 'Q3',
        previous_grade: ['-1'],
        quiz: { quiz_id: 'quiz-1', quiz_name: 'Quiz 1', attempt_id: ATTEMPT_ID, attempt_number: 2 },
      },
    });
    // The service's in-app notice is the staff email: no request_regrade run.
    expect(mocks.trigger).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("refuses another student's attempt as the service does (not_found)", async () => {
    mocks.createForQuizAttempt.mockRejectedValue(
      new QuizGradeError('not_found', 'Quiz attempt not found', 404)
    );
    await expect(regradeCreateTool.handler(QUIZ_ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
    });
  });

  it('refuses an attempt of another classroom before the service is asked', async () => {
    mocks.attemptFindUnique.mockResolvedValue(attemptRow('other-class'));
    await expect(regradeCreateTool.handler(QUIZ_ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
    });
    mocks.attemptFindUnique.mockResolvedValue(null);
    await expect(regradeCreateTool.handler(QUIZ_ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(mocks.createForQuizAttempt).not.toHaveBeenCalled();
  });

  it('returns the open request, saying so, when the attempt already has one', async () => {
    mocks.createForQuizAttempt.mockResolvedValue({
      request: { id: 'rr-open', status: 'IN_REVIEW', student_comment: 'x', previous_grade: [] },
      created: false,
      classroomId: 'class-1',
      quiz: { id: 'quiz-1', name: 'Quiz 1', assignmentTitle: null },
    });
    const payload = parse(await regradeCreateTool.handler(QUIZ_ARGS, CTX));
    expect(payload.created).toBe(false);
    expect(payload.note).toMatch(/already has an open regrade request/);
    expect(payload.regrade_request.id).toBe('rr-open');
  });

  it('maps a refused attempt (not completed) to invalid_params', async () => {
    mocks.createForQuizAttempt.mockRejectedValue(
      new QuizGradeError('not_completed', 'Only a completed quiz attempt can be adjusted', 409)
    );
    await expect(regradeCreateTool.handler(QUIZ_ARGS, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
      code: 'NOT_COMPLETED',
    });
  });

  it('takes exactly one target', async () => {
    await expect(
      regradeCreateTool.handler({ ...QUIZ_ARGS, git_repo_assignment_id: 'gra-1' }, CTX)
    ).rejects.toMatchObject({ kind: 'invalid_params' });
    await expect(
      regradeCreateTool.handler({ classroom: 'org/winter-2025', comment: 'x' }, CTX)
    ).rejects.toMatchObject({ kind: 'invalid_params' });
    expect(mocks.createForQuizAttempt).not.toHaveBeenCalled();
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  it('is refused where the classroom shows no quizzes', async () => {
    mocks.quizzesVisibleOrThrow.mockResolvedValue(false);
    await expect(regradeCreateTool.handler(QUIZ_ARGS, CTX)).rejects.toMatchObject({
      kind: 'forbidden',
    });
    expect(mocks.createForQuizAttempt).not.toHaveBeenCalled();
  });

  it('stays a student tool with a description under 1,500 bytes', () => {
    expect(regradeCreateTool.roles).toEqual(['STUDENT']);
    expect(Buffer.byteLength(regradeCreateTool.description, 'utf8')).toBeLessThan(1500);
  });
});

describe('regrade_resolve on a quiz request', () => {
  const RESOLVE = { classroom: 'org/winter-2025', regrade_request_id: REQUEST_ID };

  const quizRequest = (over: Record<string, unknown> = {}) => [
    {
      id: REQUEST_ID,
      classroom_id: 'class-1',
      status: 'IN_REVIEW',
      quiz_attempt_id: ATTEMPT_ID,
      quiz_attempt: { id: ATTEMPT_ID, attempt_number: 2 },
      student: { email: 's@example.com' },
      git_repo_assignment: null,
      ...over,
    },
  ];

  const resolved = (status: 'APPROVED' | 'DENIED', alreadyResolved = false) => ({
    request: {
      id: REQUEST_ID,
      status,
      grader_comment: 'Fair point.',
      previous_grade: ['-1'],
    },
    alreadyResolved,
    attempt: { id: ATTEMPT_ID },
    grade: {
      original: { percentage: 62, emoji: '-1', band: null },
      effective:
        status === 'APPROVED'
          ? { percentage: 100, emoji: 'rocket', band: null }
          : { percentage: 62, emoji: '-1', band: null },
      adjusted: status === 'APPROVED',
      adjusted_emoji: status === 'APPROVED' ? 'rocket' : null,
    },
    classroomId: 'class-1',
    quiz: { id: 'quiz-1', name: 'Quiz 1', assignmentTitle: 'Quiz 1' },
    student: { id: 'stu-1', email: 's@example.com', name: 'Ada' },
  });

  beforeEach(() => {
    mocks.findMany.mockResolvedValue(quizRequest());
    mocks.trigger.mockResolvedValue({ id: 'run-email' });
  });

  it('approves with the emoji, then queues only the resolution email', async () => {
    mocks.resolveQuiz.mockResolvedValue(resolved('APPROVED'));

    const payload = parse(
      await regradeResolveTool.handler(
        { ...RESOLVE, resolution: 'APPROVED', emoji: 'rocket', comment: '  Fair point. ' },
        STAFF_CTX
      )
    );

    expect(mocks.resolveQuiz).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      resolution: 'APPROVED',
      emoji: 'rocket',
      comment: 'Fair point.',
      actorUserId: 'ta-1',
      tool: 'regrade_resolve',
      impersonatedBy: null,
    });
    // Not update_regrade_request: resolveQuiz already wrote the status.
    expect(mocks.trigger).toHaveBeenCalledTimes(1);
    expect(mocks.trigger).toHaveBeenCalledWith('quiz_regrade_resolved', {
      request_id: REQUEST_ID,
    });
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(payload).toMatchObject({
      success: true,
      email_queued: true,
      regrade_request: {
        id: REQUEST_ID,
        status: 'APPROVED',
        target: 'quiz',
        grader_comment: 'Fair point.',
        quiz: { quiz_id: 'quiz-1', attempt_id: ATTEMPT_ID, attempt_number: 2 },
      },
      attempt_grade: { grade_emoji: 'rocket', original_emoji: '-1', adjusted: true },
    });
    // No grade as a number (the attempt's ordinal is not a grade).
    for (const [key, value] of entriesOf(payload)) {
      if (key !== 'attempt_number') expect(typeof value, key).not.toBe('number');
    }
  });

  it('denies (keeps the grade) with a reply', async () => {
    mocks.resolveQuiz.mockResolvedValue(resolved('DENIED'));
    const payload = parse(
      await regradeResolveTool.handler(
        { ...RESOLVE, resolution: 'DENIED', comment: 'The rubric holds.' },
        STAFF_CTX
      )
    );
    expect(mocks.resolveQuiz).toHaveBeenCalledWith(
      expect.objectContaining({ resolution: 'DENIED', comment: 'The rubric holds.' })
    );
    expect(mocks.resolveQuiz.mock.calls[0][0]).not.toHaveProperty('emoji');
    expect(payload.attempt_grade).toEqual({
      grade_emoji: '-1',
      original_emoji: '-1',
      adjusted: false,
    });
  });

  it('requires the reply, and the emoji for APPROVED, before anything is written', async () => {
    await expect(
      regradeResolveTool.handler({ ...RESOLVE, resolution: 'DENIED' }, STAFF_CTX)
    ).rejects.toMatchObject({ kind: 'invalid_params' });
    await expect(
      regradeResolveTool.handler({ ...RESOLVE, resolution: 'DENIED', comment: '   ' }, STAFF_CTX)
    ).rejects.toMatchObject({ kind: 'invalid_params' });
    await expect(
      regradeResolveTool.handler({ ...RESOLVE, resolution: 'APPROVED', comment: 'ok' }, STAFF_CTX)
    ).rejects.toMatchObject({ kind: 'invalid_params' });
    await expect(
      regradeResolveTool.handler(
        { ...RESOLVE, resolution: 'DENIED', comment: 'ok', emoji: 'rocket' },
        STAFF_CTX
      )
    ).rejects.toMatchObject({ kind: 'invalid_params' });
    expect(mocks.resolveQuiz).not.toHaveBeenCalled();
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  it('refuses a request of another classroom like an unknown one', async () => {
    mocks.findMany.mockResolvedValue(quizRequest({ classroom_id: 'other-class' }));
    await expect(
      regradeResolveTool.handler(
        { ...RESOLVE, resolution: 'APPROVED', emoji: 'rocket', comment: 'ok' },
        STAFF_CTX
      )
    ).rejects.toMatchObject({ kind: 'not_found' });
    expect(mocks.resolveQuiz).not.toHaveBeenCalled();
  });

  it('maps an emoji off the scale to invalid_params', async () => {
    mocks.resolveQuiz.mockRejectedValue(new QuizGradeError('invalid_emoji', 'not on the scale'));
    await expect(
      regradeResolveTool.handler(
        { ...RESOLVE, resolution: 'APPROVED', emoji: 'tada', comment: 'ok' },
        STAFF_CTX
      )
    ).rejects.toMatchObject({ kind: 'invalid_params', code: 'INVALID_EMOJI' });
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  it('sends no second email for a request already resolved', async () => {
    mocks.resolveQuiz.mockResolvedValue(resolved('DENIED', true));
    const payload = parse(
      await regradeResolveTool.handler(
        { ...RESOLVE, resolution: 'APPROVED', emoji: 'rocket', comment: 'ok' },
        STAFF_CTX
      )
    );
    expect(payload.already_resolved).toBe(true);
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  it('keeps the resolution when the email fails to queue', async () => {
    mocks.resolveQuiz.mockResolvedValue(resolved('APPROVED'));
    mocks.trigger.mockRejectedValue(new Error('trigger down'));
    const payload = parse(
      await regradeResolveTool.handler(
        { ...RESOLVE, resolution: 'APPROVED', emoji: 'rocket', comment: 'ok' },
        STAFF_CTX
      )
    );
    expect(payload).toMatchObject({ success: true, email_queued: false });
  });
});

describe('regrade_resolve on a submission request', () => {
  it('refuses an emoji (grades go through grade_add) and stores a reply when given', async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: 'rr-1',
        classroom_id: 'class-1',
        status: 'IN_REVIEW',
        quiz_attempt_id: null,
        student: { email: 's@example.com' },
        git_repo_assignment: { assignment: { title: 'Lab 1' } },
      },
    ]);
    const args = {
      classroom: 'org/winter-2025',
      regrade_request_id: 'rr-1',
      resolution: 'DENIED' as const,
    };
    await expect(
      regradeResolveTool.handler({ ...args, emoji: 'rocket' }, STAFF_CTX)
    ).rejects.toMatchObject({ kind: 'invalid_params' });

    mocks.trigger.mockResolvedValue({ id: 'run-1' });
    mocks.retrieve.mockResolvedValue({ status: 'COMPLETED', output: {} });
    await regradeResolveTool.handler({ ...args, comment: ' See the rubric. ' }, STAFF_CTX);
    expect(mocks.trigger).toHaveBeenCalledWith(
      'update_regrade_request',
      // Who resolved it: the token's user.
      expect.objectContaining({
        data: { status: 'DENIED', grader_comment: 'See the rubric.', resolved_by_id: 'ta-1' },
      })
    );
    expect(mocks.resolveQuiz).not.toHaveBeenCalled();
  });
});

describe('regrade_resolve hints and description', () => {
  it('emits a destructive, idempotent, closed-world write (it writes a permanent record)', () => {
    expect(toolAnnotations(regradeResolveTool as never)).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it('keeps the comment optional at the schema, so a refused role is refused as such', () => {
    const shape = regradeResolveTool.inputSchema;
    expect((shape.comment as { isOptional: () => boolean }).isOptional()).toBe(true);
    expect((shape.emoji as { isOptional: () => boolean }).isOptional()).toBe(true);
  });

  it('keeps its description under 1,500 bytes', () => {
    expect(Buffer.byteLength(regradeResolveTool.description, 'utf8')).toBeLessThan(1500);
  });
});
