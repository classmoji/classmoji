import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The staff attempt drawer resolving the attempt's open quiz
 * regrade/resubmit request (`_action: 'resolve'`, E13), with the queue's
 * rules:
 *
 *   - the teaching team of the classroom in the URL, assistants included
 *     (D5); a student and staff of another classroom are refused by the gate;
 *   - a read-only classroom's refusal comes back as data; a classroom without
 *     quizzes is a 404;
 *   - the request must be this classroom's AND this attempt's: a request on
 *     another attempt (or in another classroom) is a 404, nothing resolved;
 *   - a reply is required; Adjust score needs an emoji;
 *   - the service gets the session user, this surface's tool name and the
 *     View As admin; the student's email is queued as from the queue.
 */

type Role = 'OWNER' | 'TEACHER' | 'ASSISTANT' | 'STUDENT';

const CLASSROOMS: Record<string, { id: string; slug: string; status: string }> = {
  'cs-x': { id: 'class-x', slug: 'cs-x', status: 'ACTIVE' },
  'cs-y': { id: 'class-y', slug: 'cs-y', status: 'ACTIVE' },
  'cs-locked': { id: 'class-locked', slug: 'cs-locked', status: 'LOCKED' },
};
const MEMBERS: Record<string, Record<string, Role>> = {
  'owner-x': { 'class-x': 'OWNER' },
  'teacher-x': { 'class-x': 'TEACHER' },
  'ta-x': { 'class-x': 'ASSISTANT', 'class-locked': 'ASSISTANT' },
  'stu-x': { 'class-x': 'STUDENT' },
  'ta-y': { 'class-y': 'ASSISTANT' },
};
const QUIZZES: Record<string, { id: string; classroom_id: string }> = {
  'quiz-x': { id: 'quiz-x', classroom_id: 'class-x' },
  'quiz-y': { id: 'quiz-y', classroom_id: 'class-y' },
  'quiz-locked': { id: 'quiz-locked', classroom_id: 'class-locked' },
};
const ATTEMPTS: Record<string, { id: string; quiz_id: string; user_id: string }> = {
  'att-x': { id: 'att-x', quiz_id: 'quiz-x', user_id: 'stu-x' },
  'att-x2': { id: 'att-x2', quiz_id: 'quiz-x', user_id: 'stu-x' },
  'att-y': { id: 'att-y', quiz_id: 'quiz-y', user_id: 'stu-y' },
  'att-locked': { id: 'att-locked', quiz_id: 'quiz-locked', user_id: 'stu-l' },
};
/** Requests: one per attempt, plus a repo request in classroom X. */
const REQUESTS = [
  { id: 'req-x', classroom_id: 'class-x', quiz_attempt_id: 'att-x' },
  { id: 'req-x2', classroom_id: 'class-x', quiz_attempt_id: 'att-x2' },
  { id: 'req-x-repo', classroom_id: 'class-x', quiz_attempt_id: null },
  { id: 'req-y', classroom_id: 'class-y', quiz_attempt_id: 'att-y' },
];

const session = vi.hoisted(() => ({ userId: 'ta-x', impersonatedBy: null as string | null }));
const mocks = vi.hoisted(() => ({
  gate: vi.fn(),
  findMany: vi.fn(),
  resolveQuiz: vi.fn(),
  trigger: vi.fn(),
  adjust: vi.fn(),
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

vi.mock('@trigger.dev/sdk', () => ({
  tasks: { trigger: (...a: unknown[]) => mocks.trigger(...a) },
}));
vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomTeachingTeam: (...a: unknown[]) => mocks.gate(...a),
}));
vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: vi.fn(),
  addClassroomAuditLog: vi.fn(),
}));
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
      revert: vi.fn(),
    },
    regradeRequest: {
      findMany: (...a: unknown[]) => mocks.findMany(...a),
      resolveQuiz: (...a: unknown[]) => mocks.resolveQuiz(...a),
    },
  },
  QuizGradeError,
  QuizAttemptNotFoundError: class extends Error {},
}));
vi.mock('~/hooks', () => ({
  useRouteDrawer: () => ({ opened: true }),
  useDarkMode: () => ({ isDarkMode: false }),
}));
vi.mock('~/components', () => ({ QuizAttemptInterface: () => null }));

const route = await import('../route.tsx');

const post = (slug: string, quizId: string, attemptId: string, body: Record<string, unknown>) =>
  route.action({
    params: { class: slug, quizId, attemptId },
    request: new Request(`http://localhost/admin/${slug}/quizzes/${quizId}/attempt/${attemptId}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
  } as unknown as Parameters<typeof route.action>[0]);

const resolve = (over: Record<string, unknown> = {}) => ({
  _action: 'resolve',
  requestId: 'req-x',
  resolution: 'APPROVED',
  emoji: '+1',
  comment: 'Q3 now has full credit.',
  ...over,
});

const asReply = (value: unknown) =>
  value as { data?: { error?: string; code?: string }; init?: { status?: number } } & {
    success?: string;
    info?: string;
  };

beforeEach(() => {
  vi.clearAllMocks();
  session.userId = 'ta-x';
  session.impersonatedBy = null;
  mocks.quizzesVisible.mockResolvedValue(true);
  mocks.findMany.mockImplementation(async (where: { id: string; classroom_id: string }) =>
    REQUESTS.filter(r => r.id === where.id && r.classroom_id === where.classroom_id)
  );
  mocks.resolveQuiz.mockResolvedValue({ request: { id: 'req-x' }, alreadyResolved: false });
  mocks.trigger.mockResolvedValue({ id: 'run-1' });
  mocks.gate.mockImplementation(async (_request: Request, slug: string) => {
    const classroom = CLASSROOMS[slug];
    const role = classroom ? MEMBERS[session.userId]?.[classroom.id] : undefined;
    if (!classroom || !role || !['OWNER', 'TEACHER', 'ASSISTANT'].includes(role)) {
      throw new Response('Forbidden', { status: 403 });
    }
    return { userId: session.userId, classroom, membership: { role } };
  });
});

describe('drawer resolve action — who may', () => {
  it.each(['owner-x', 'teacher-x', 'ta-x'])(
    '%s (teaching team, assistants included) resolves, as the actor, and the student is emailed',
    async user => {
      session.userId = user;

      const result = asReply(await post('cs-x', 'quiz-x', 'att-x', resolve()));

      expect(result.success).toBe('Score adjusted');
      // Scoped by the URL's classroom, never by an id from the body.
      expect(mocks.findMany).toHaveBeenCalledWith({ id: 'req-x', classroom_id: 'class-x' });
      expect(mocks.resolveQuiz).toHaveBeenCalledWith({
        requestId: 'req-x',
        resolution: 'APPROVED',
        emoji: '+1',
        comment: 'Q3 now has full credit.',
        actorUserId: user,
        tool: 'web:quiz_attempt.resolve_regrade',
        impersonatedBy: null,
      });
      expect(mocks.trigger).toHaveBeenCalledWith('quiz_regrade_resolved', { request_id: 'req-x' });
      expect(mocks.adjust).not.toHaveBeenCalled();
    }
  );

  it('keeps the score (DENIED) without an emoji', async () => {
    const result = asReply(
      await post('cs-x', 'quiz-x', 'att-x', resolve({ resolution: 'DENIED', emoji: null }))
    );
    expect(result.success).toBe('Score kept');
    expect(mocks.resolveQuiz).toHaveBeenCalledWith(
      expect.objectContaining({ resolution: 'DENIED', emoji: undefined })
    );
  });

  it('refuses a student of the classroom: the gate throws, nothing is resolved', async () => {
    session.userId = 'stu-x';
    const thrown = await post('cs-x', 'quiz-x', 'att-x', resolve()).catch(e => e);
    expect((thrown as Response).status).toBe(403);
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.resolveQuiz).not.toHaveBeenCalled();
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  it("refuses staff of classroom Y at classroom X's URL, and X's ids at Y's URL", async () => {
    session.userId = 'ta-y';
    const atX = await post('cs-x', 'quiz-x', 'att-x', resolve()).catch(e => e);
    expect((atX as Response).status).toBe(403);

    // At their own classroom's URL, naming X's quiz or attempt: 404.
    const foreignQuiz = await post('cs-y', 'quiz-x', 'att-x', resolve()).catch(e => e);
    const foreignAttempt = await post('cs-y', 'quiz-y', 'att-x', resolve()).catch(e => e);
    expect((foreignQuiz as Response).status).toBe(404);
    expect((foreignAttempt as Response).status).toBe(404);

    // Their own attempt, naming X's request: not this classroom's, 404.
    const foreignRequest = asReply(await post('cs-y', 'quiz-y', 'att-y', resolve()));
    expect(foreignRequest.init?.status).toBe(404);
    expect(mocks.findMany).toHaveBeenCalledWith({ id: 'req-x', classroom_id: 'class-y' });
    expect(mocks.resolveQuiz).not.toHaveBeenCalled();
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  it("returns a read-only classroom's refusal as data, resolving nothing", async () => {
    const result = asReply(await post('cs-locked', 'quiz-locked', 'att-locked', resolve()));
    expect(result.init?.status).toBe(403);
    expect(result.data).toMatchObject({ code: 'CLASSROOM_LOCKED' });
    expect(mocks.resolveQuiz).not.toHaveBeenCalled();
  });

  it('answers 404 where the classroom has no quizzes', async () => {
    mocks.quizzesVisible.mockResolvedValue(false);
    const thrown = await post('cs-x', 'quiz-x', 'att-x', resolve()).catch(e => e);
    expect((thrown as Response).status).toBe(404);
    expect(mocks.resolveQuiz).not.toHaveBeenCalled();
  });
});

describe('drawer resolve action — what it resolves', () => {
  it("refuses a request on another attempt of the same quiz (404): only this attempt's", async () => {
    const result = asReply(await post('cs-x', 'quiz-x', 'att-x', resolve({ requestId: 'req-x2' })));
    expect(result.init?.status).toBe(404);
    expect(mocks.resolveQuiz).not.toHaveBeenCalled();
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  it('refuses a repo request (not this attempt’s)', async () => {
    const result = asReply(
      await post('cs-x', 'quiz-x', 'att-x', resolve({ requestId: 'req-x-repo' }))
    );
    expect(result.init?.status).toBe(404);
    expect(mocks.resolveQuiz).not.toHaveBeenCalled();
  });

  it('requires a reply, and an emoji to adjust', async () => {
    for (const comment of [undefined, '', '   ']) {
      const result = asReply(await post('cs-x', 'quiz-x', 'att-x', resolve({ comment })));
      expect(result.init?.status).toBe(400);
      expect(result.data?.error).toMatch(/reply/i);
    }
    const noEmoji = asReply(await post('cs-x', 'quiz-x', 'att-x', resolve({ emoji: null })));
    expect(noEmoji.init?.status).toBe(400);
    expect(mocks.resolveQuiz).not.toHaveBeenCalled();
  });

  it('names the View As admin, and maps a service refusal to its status', async () => {
    session.impersonatedBy = 'admin-1';
    mocks.resolveQuiz.mockRejectedValueOnce(
      new QuizGradeError('invalid_emoji', 400, '"heart" is not in this classroom\'s grading scale')
    );
    const result = asReply(await post('cs-x', 'quiz-x', 'att-x', resolve({ emoji: 'heart' })));
    expect(result.init?.status).toBe(400);
    expect(result.data?.error).toMatch(/grading scale/);
    expect(mocks.resolveQuiz).toHaveBeenCalledWith(
      expect.objectContaining({ impersonatedBy: 'admin-1' })
    );
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  it('sends no email for a request already resolved', async () => {
    mocks.resolveQuiz.mockResolvedValue({ request: { id: 'req-x' }, alreadyResolved: true });
    const result = asReply(await post('cs-x', 'quiz-x', 'att-x', resolve()));
    expect(result.info).toBe('This request was already resolved');
    expect(mocks.trigger).not.toHaveBeenCalled();
  });
});
