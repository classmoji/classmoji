import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The staff attempt drawer's action: adjust or revert a quiz attempt's grade.
 *
 * Who may: the teaching team of the classroom in the URL (D5: assistants
 * included), through `requireClassroomTeachingTeam`; the gate below emulates
 * it over a membership table so a student, and staff of another classroom,
 * are refused the way the real gate refuses them. What: only the attempt in
 * the URL, and only once its quiz is bound to that classroom and the attempt
 * to that quiz, so a foreign id is a 404 before the service runs. The service
 * (mocked here; its own scoping and audit rows are covered by
 * packages/services quizGradeAdjust.integration.test.ts) gets the session
 * user as the actor and this surface's tool name.
 */

type Role = 'OWNER' | 'TEACHER' | 'ASSISTANT' | 'STUDENT';

const CLASSROOMS: Record<string, { id: string; slug: string; status: string }> = {
  'cs-x': { id: 'class-x', slug: 'cs-x', status: 'ACTIVE' },
  'cs-y': { id: 'class-y', slug: 'cs-y', status: 'ACTIVE' },
};
const MEMBERS: Record<string, Record<string, Role>> = {
  'owner-x': { 'class-x': 'OWNER' },
  'teacher-x': { 'class-x': 'TEACHER' },
  'ta-x': { 'class-x': 'ASSISTANT' },
  'stu-x': { 'class-x': 'STUDENT' },
  'ta-y': { 'class-y': 'ASSISTANT' },
};
const QUIZZES: Record<string, { id: string; classroom_id: string }> = {
  'quiz-x': { id: 'quiz-x', classroom_id: 'class-x' },
  'quiz-y': { id: 'quiz-y', classroom_id: 'class-y' },
};
const ATTEMPTS: Record<string, { id: string; quiz_id: string; user_id: string }> = {
  'att-x': { id: 'att-x', quiz_id: 'quiz-x', user_id: 'stu-x' },
  'att-y': { id: 'att-y', quiz_id: 'quiz-y', user_id: 'stu-y' },
};

const session = vi.hoisted(() => ({ userId: 'ta-x', impersonatedBy: null as string | null }));
const mocks = vi.hoisted(() => ({
  gate: vi.fn(),
  adjust: vi.fn(),
  revert: vi.fn(),
  quizzesVisible: vi.fn(),
  mutationAllowed: vi.fn(),
}));

class QuizGradeError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomTeachingTeam: (...a: unknown[]) => mocks.gate(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.mutationAllowed(...a),
}));
vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: vi.fn(),
  addClassroomAuditLog: vi.fn(),
}));
// A platform admin's "View As" session, read from the request's session.
vi.mock('~/routes/admin.$class.ask-moji/impersonation.server', () => ({
  impersonatedBy: async () => session.impersonatedBy,
}));
vi.mock('~/utils/classroomProFlag.server', () => ({
  quizzesVisibleOrThrow: (...a: unknown[]) => mocks.quizzesVisible(...a),
}));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    quiz: { findById: async (id: string) => QUIZZES[id] ?? null },
    quizAttempt: {
      findById: async (id: string) => ATTEMPTS[id] ?? null,
      adjust: (...a: unknown[]) => mocks.adjust(...a),
      revert: (...a: unknown[]) => mocks.revert(...a),
    },
  },
  QuizGradeError,
  QuizAttemptNotFoundError: class extends Error {},
}));
// The action is under test; the view layer only needs to import.
vi.mock('~/hooks', () => ({
  useRouteDrawer: () => ({ opened: true }),
  useDarkMode: () => ({ isDarkMode: false }),
}));
vi.mock('~/components', () => ({ QuizAttemptInterface: () => null }));

const route = await import('../route.tsx');
const assistantRoute =
  await import('../../assistant.$class_.quizzes_.$quizId.attempt.$attemptId/route.tsx');
const teacherRoute =
  await import('../../teacher.$class_.quizzes_.$quizId.attempt.$attemptId/route.tsx');

const post = (slug: string, quizId: string, attemptId: string, body: Record<string, unknown>) =>
  route.action({
    params: { class: slug, quizId, attemptId },
    request: new Request(`http://localhost/admin/${slug}/quizzes/${quizId}/attempt/${attemptId}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
  } as unknown as Parameters<typeof route.action>[0]);

/** What `data(body, init)` hands back, read without depending on its class. */
const asReply = (value: unknown) =>
  value as { data?: { error?: string }; init?: { status?: number } } & { ok?: boolean };

beforeEach(() => {
  vi.clearAllMocks();
  session.userId = 'ta-x';
  session.impersonatedBy = null;
  mocks.quizzesVisible.mockResolvedValue(true);
  mocks.adjust.mockResolvedValue({ changed: true });
  mocks.revert.mockResolvedValue({ changed: true });
  // The real gate's rule: an OWNER, TEACHER or ASSISTANT membership in the
  // classroom named by the URL; anyone else is refused with a 403.
  mocks.gate.mockImplementation(async (_request: Request, slug: string) => {
    const classroom = CLASSROOMS[slug];
    const role = classroom ? MEMBERS[session.userId]?.[classroom.id] : undefined;
    if (!classroom || !role || !['OWNER', 'TEACHER', 'ASSISTANT'].includes(role)) {
      throw new Response('Forbidden', { status: 403 });
    }
    return { userId: session.userId, classroom, membership: { role } };
  });
});

describe('adjust action — who may', () => {
  it.each(['owner-x', 'teacher-x', 'ta-x'])(
    '%s (teaching team) adjusts, as the actor',
    async user => {
      session.userId = user;

      const result = await post('cs-x', 'quiz-x', 'att-x', {
        _action: 'adjust',
        emoji: '+1',
        comment: 'Q3 has full credit.',
      });

      expect(asReply(result)).toEqual({ ok: true });
      expect(mocks.gate).toHaveBeenCalledWith(expect.any(Request), 'cs-x', expect.anything());
      expect(mocks.adjust).toHaveBeenCalledWith({
        attemptId: 'att-x',
        emoji: '+1',
        comment: 'Q3 has full credit.',
        actorUserId: user,
        tool: 'web:quiz_attempt.adjust',
        impersonatedBy: null,
      });
    }
  );

  it('refuses a student of the classroom', async () => {
    session.userId = 'stu-x';

    const thrown = await post('cs-x', 'quiz-x', 'att-x', { _action: 'adjust', emoji: '+1' }).catch(
      e => e
    );

    expect((thrown as Response).status).toBe(403);
    expect(mocks.adjust).not.toHaveBeenCalled();
  });

  it("refuses a staff member of another classroom at this classroom's URL", async () => {
    session.userId = 'ta-y';

    const thrown = await post('cs-x', 'quiz-x', 'att-x', { _action: 'adjust', emoji: '+1' }).catch(
      e => e
    );

    expect((thrown as Response).status).toBe(403);
    expect(mocks.adjust).not.toHaveBeenCalled();
  });

  it("answers 404 when staff of one classroom name another classroom's quiz or attempt", async () => {
    session.userId = 'ta-y';

    const foreignQuiz = await post('cs-y', 'quiz-x', 'att-x', { _action: 'adjust', emoji: '+1' })
      .then(() => null)
      .catch(e => e);
    const foreignAttempt = await post('cs-y', 'quiz-y', 'att-x', { _action: 'adjust', emoji: '+1' })
      .then(() => null)
      .catch(e => e);

    expect((foreignQuiz as Response).status).toBe(404);
    expect((foreignAttempt as Response).status).toBe(404);
    expect(mocks.adjust).not.toHaveBeenCalled();
    expect(mocks.revert).not.toHaveBeenCalled();
  });

  it('serves the same action under /teacher and /assistant', () => {
    expect(assistantRoute.action).toBe(route.action);
    expect(teacherRoute.action).toBe(route.action);
  });

  it('checks the classroom mutation rule with the role the gate found', async () => {
    await post('cs-x', 'quiz-x', 'att-x', { _action: 'revert' });
    expect(mocks.mutationAllowed).toHaveBeenCalledWith({ status: 'ACTIVE', role: 'ASSISTANT' });
  });

  it('answers 404 where the classroom has no quizzes', async () => {
    mocks.quizzesVisible.mockResolvedValue(false);
    const thrown = await post('cs-x', 'quiz-x', 'att-x', { _action: 'revert' }).catch(e => e);
    expect((thrown as Response).status).toBe(404);
    expect(mocks.revert).not.toHaveBeenCalled();
  });
});

describe('adjust action — what it does', () => {
  it('acts on the attempt in the URL, never one named in the body', async () => {
    await post('cs-x', 'quiz-x', 'att-x', {
      _action: 'adjust',
      attemptId: 'att-y',
      actorUserId: 'someone-else',
      comment: 'Note only',
    });

    expect(mocks.adjust).toHaveBeenCalledWith({
      attemptId: 'att-x',
      comment: 'Note only',
      actorUserId: 'ta-x',
      tool: 'web:quiz_attempt.adjust',
      impersonatedBy: null,
    });
  });

  it('reverts with its own tool name', async () => {
    const result = await post('cs-x', 'quiz-x', 'att-x', { _action: 'revert' });

    expect(asReply(result)).toEqual({ ok: true });
    expect(mocks.revert).toHaveBeenCalledWith({
      attemptId: 'att-x',
      actorUserId: 'ta-x',
      tool: 'web:quiz_attempt.revert',
      impersonatedBy: null,
    });
    expect(mocks.adjust).not.toHaveBeenCalled();
  });

  it('names the platform admin behind a View As session on adjust and revert', async () => {
    session.impersonatedBy = 'admin-1';
    await post('cs-x', 'quiz-x', 'att-x', { _action: 'adjust', emoji: '+1' });
    await post('cs-x', 'quiz-x', 'att-x', { _action: 'revert' });
    expect(mocks.adjust).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: 'ta-x', impersonatedBy: 'admin-1' })
    );
    expect(mocks.revert).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: 'ta-x', impersonatedBy: 'admin-1' })
    );
  });

  it("answers a service refusal with its status and message (a staff preview can't be adjusted)", async () => {
    mocks.adjust.mockRejectedValue(
      new QuizGradeError(
        'not_student_attempt',
        409,
        'Only a current student’s quiz attempt can be adjusted'
      )
    );

    const result = asReply(
      await post('cs-x', 'quiz-x', 'att-x', { _action: 'adjust', emoji: '+1' })
    );

    expect(result.init?.status).toBe(409);
    expect(result.data?.error).toBe('Only a current student’s quiz attempt can be adjusted');
  });

  it('refuses an unknown action without writing', async () => {
    const result = asReply(await post('cs-x', 'quiz-x', 'att-x', { _action: 'delete' }));

    expect(result.init?.status).toBe(400);
    expect(mocks.adjust).not.toHaveBeenCalled();
    expect(mocks.revert).not.toHaveBeenCalled();
  });

  it('lets an unexpected failure surface', async () => {
    const failure = new Error('database down');
    mocks.adjust.mockRejectedValue(failure);

    await expect(post('cs-x', 'quiz-x', 'att-x', { _action: 'adjust', emoji: '+1' })).rejects.toBe(
      failure
    );
  });
});
