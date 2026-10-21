import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The student's regrade/resubmit request on a quiz attempt (E4, D7).
 *
 * Who may: a STUDENT of the classroom in the URL (`requireStudentAccess`,
 * emulated below over a membership table, so staff are refused as the real
 * gate refuses them). What: only the attempt in the URL, bound to that
 * classroom's quiz before the service runs. The service decides ownership
 * from the session user it is handed: here it is emulated by the attempt's
 * owner (the real rule, with its audit row, is covered by packages/services
 * quizGradeAdjust.integration.test.ts), so the test pins that the action
 * hands it the session user and never anything from the body.
 */

type Role = 'OWNER' | 'TEACHER' | 'ASSISTANT' | 'STUDENT';

const CLASSROOMS: Record<string, { id: string; slug: string; status: string }> = {
  'cs-x': { id: 'class-x', slug: 'cs-x', status: 'ACTIVE' },
  'cs-y': { id: 'class-y', slug: 'cs-y', status: 'ACTIVE' },
  'cs-locked': { id: 'class-locked', slug: 'cs-locked', status: 'LOCKED' },
};
const MEMBERS: Record<string, Record<string, Role>> = {
  'stu-a': { 'class-x': 'STUDENT', 'class-locked': 'STUDENT' },
  'stu-b': { 'class-x': 'STUDENT' },
  'stu-y': { 'class-y': 'STUDENT' },
  'ta-x': { 'class-x': 'ASSISTANT' },
};
const QUIZZES: Record<string, { id: string; classroom_id: string }> = {
  'quiz-x': { id: 'quiz-x', classroom_id: 'class-x' },
  'quiz-y': { id: 'quiz-y', classroom_id: 'class-y' },
};
const ATTEMPTS: Record<string, { id: string; quiz_id: string; user_id: string }> = {
  'att-a': { id: 'att-a', quiz_id: 'quiz-x', user_id: 'stu-a' },
  'att-y': { id: 'att-y', quiz_id: 'quiz-y', user_id: 'stu-y' },
};

const session = vi.hoisted(() => ({ userId: 'stu-a', impersonatedBy: null as string | null }));
const mocks = vi.hoisted(() => ({
  gate: vi.fn(),
  create: vi.fn(),
  quizzesVisible: vi.fn(),
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

vi.mock('~/utils/helpers', () => ({
  requireStudentAccess: (...a: unknown[]) => mocks.gate(...a),
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
    quizAttempt: { findById: async (id: string) => ATTEMPTS[id] ?? null },
    regradeRequest: { createForQuizAttempt: (...a: unknown[]) => mocks.create(...a) },
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

const post = (slug: string, quizId: string, attemptId: string, body: Record<string, unknown>) =>
  route.action({
    params: { class: slug, quizId, attemptId },
    request: new Request(
      `http://localhost/student/${slug}/quizzes/${quizId}/attempt/${attemptId}`,
      {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      }
    ),
  } as unknown as Parameters<typeof route.action>[0]);

const asReply = (value: unknown) =>
  value as { data?: { error?: string }; init?: { status?: number } } & {
    ok?: boolean;
    created?: boolean;
  };

beforeEach(() => {
  vi.clearAllMocks();
  session.userId = 'stu-a';
  session.impersonatedBy = null;
  mocks.quizzesVisible.mockResolvedValue(true);
  // The real gate: a STUDENT membership in the URL's classroom, else 403.
  mocks.gate.mockImplementation(async (_request: Request, slug: string) => {
    const classroom = CLASSROOMS[slug];
    const role = classroom ? MEMBERS[session.userId]?.[classroom.id] : undefined;
    if (!classroom || role !== 'STUDENT') throw new Response('Forbidden', { status: 403 });
    return { userId: session.userId, classroom, membership: { role } };
  });
  // The service's ownership rule, keyed on the actor it is given.
  mocks.create.mockImplementation(
    async ({ attemptId, actorUserId, comment }: Record<string, string>) => {
      if (ATTEMPTS[attemptId]?.user_id !== actorUserId) {
        throw new QuizGradeError('not_found', 404, 'Quiz attempt not found');
      }
      if (!comment?.trim()) {
        throw new QuizGradeError('invalid_input', 400, 'Say why the attempt should be regraded');
      }
      return { request: { id: 'rr-1' }, created: true };
    }
  );
});

describe('quiz regrade request action', () => {
  it('opens a request on the student’s own attempt, as the session user', async () => {
    const result = await post('cs-x', 'quiz-x', 'att-a', {
      _action: 'requestRegrade',
      comment: 'Q2 handled n < 0.',
    });

    expect(asReply(result)).toEqual({ ok: true, created: true });
    expect(mocks.gate).toHaveBeenCalledWith(expect.any(Request), 'cs-x', expect.anything());
    expect(mocks.create).toHaveBeenCalledWith({
      attemptId: 'att-a',
      comment: 'Q2 handled n < 0.',
      actorUserId: 'stu-a',
      tool: 'web:quiz_attempt.request_regrade',
      impersonatedBy: null,
    });
  });

  it("returns a read-only classroom's refusal as data, so the drawer stays", async () => {
    const result = asReply(
      await post('cs-locked', 'quiz-x', 'att-a', { _action: 'requestRegrade', comment: 'Q2.' })
    ) as { init?: { status?: number }; data?: { code?: string } };
    expect(result.init?.status).toBe(403);
    expect(result.data?.code).toBe('CLASSROOM_LOCKED');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('names the platform admin behind a View As session', async () => {
    session.impersonatedBy = 'admin-1';
    await post('cs-x', 'quiz-x', 'att-a', { _action: 'requestRegrade', comment: 'Q2.' });
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: 'stu-a', impersonatedBy: 'admin-1' })
    );
  });

  it("refuses another student's attempt, whatever the body claims", async () => {
    session.userId = 'stu-b';

    const result = asReply(
      await post('cs-x', 'quiz-x', 'att-a', {
        _action: 'requestRegrade',
        comment: 'Mine now.',
        actorUserId: 'stu-a',
        student_id: 'stu-a',
      })
    );

    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: 'stu-b' }));
    expect(result.init?.status).toBe(404);
    expect(result.data?.error).toBe('Quiz attempt not found');
  });

  it("answers 404 for an attempt on another classroom's quiz, before the service runs", async () => {
    const foreignQuiz = await post('cs-x', 'quiz-y', 'att-y', {
      _action: 'requestRegrade',
      comment: 'x',
    }).catch(e => e);
    const foreignAttempt = await post('cs-x', 'quiz-x', 'att-y', {
      _action: 'requestRegrade',
      comment: 'x',
    }).catch(e => e);

    expect((foreignQuiz as Response).status).toBe(404);
    expect((foreignAttempt as Response).status).toBe(404);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('refuses staff: only a student asks for a regrade', async () => {
    session.userId = 'ta-x';

    const thrown = await post('cs-x', 'quiz-x', 'att-a', {
      _action: 'requestRegrade',
      comment: 'x',
    }).catch(e => e);

    expect((thrown as Response).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('requires a comment (the service says so)', async () => {
    const result = asReply(
      await post('cs-x', 'quiz-x', 'att-a', { _action: 'requestRegrade', comment: '   ' })
    );

    expect(result.init?.status).toBe(400);
    expect(result.data?.error).toBe('Say why the attempt should be regraded');
  });

  it('returns the open request when there already is one (D7)', async () => {
    mocks.create.mockResolvedValue({ request: { id: 'rr-open' }, created: false });

    const result = await post('cs-x', 'quiz-x', 'att-a', {
      _action: 'requestRegrade',
      comment: 'Again',
    });

    expect(asReply(result)).toEqual({ ok: true, created: false });
  });

  it('refuses an unknown action without writing', async () => {
    const result = asReply(await post('cs-x', 'quiz-x', 'att-a', { _action: 'adjust' }));

    expect(result.init?.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
