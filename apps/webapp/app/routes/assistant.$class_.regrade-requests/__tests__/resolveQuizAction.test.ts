/**
 * The quiz resolve action on the regrade/resubmit requests page (served under
 * /admin, /teacher and /assistant):
 *
 *   - the teaching team, assistants included, may resolve (D5); a student is
 *     refused by the gate and nothing is written;
 *   - the request must belong to the classroom in the URL: a staff member of
 *     classroom Y cannot resolve classroom X's request from Y's page;
 *   - a reply to the student is required, and Adjust score needs an emoji;
 *   - `QuizGradeError` maps to its HTTP status; an already resolved request
 *     sends no email; a repo request is not resolved here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  gate: vi.fn(),
  findMany: vi.fn(),
  resolveQuiz: vi.fn(),
  trigger: vi.fn(),
}));

vi.mock('@trigger.dev/sdk', () => ({
  tasks: { trigger: (...a: unknown[]) => mocks.trigger(...a) },
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomTeachingTeam: (...a: unknown[]) => mocks.gate(...a),
  requireClassroomAdmin: vi.fn(),
  assertClassroomMutationAllowed: () => undefined,
}));

vi.mock('~/routes/admin.$class.ask-moji/impersonation.server', () => ({
  impersonatedBy: async () => null,
}));

vi.mock('@classmoji/services', () => {
  class QuizGradeError extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }
  return {
    QuizGradeError,
    ClassmojiService: {
      regradeRequest: {
        findMany: (...a: unknown[]) => mocks.findMany(...a),
        resolveQuiz: (...a: unknown[]) => mocks.resolveQuiz(...a),
      },
      emojiMapping: { findScaleByClassroomId: vi.fn() },
    },
  };
});

// The page component and the loader's helpers are not under test.
vi.mock('~/components', () => ({ RegradeRequestsTable: () => null }));
vi.mock('~/utils/regradeRequestRows.server', () => ({ loadStaffRegradeRows: vi.fn() }));

const { action } = await import('../route');
const { QuizGradeError } = (await import('@classmoji/services')) as unknown as {
  QuizGradeError: new (code: string, message: string, status: number) => Error;
};

/** Requests in two classrooms. */
const REQUESTS = [
  { id: 'req-x', classroom_id: 'class-x', quiz_attempt_id: 'att-1', git_repo_assignment_id: null },
  { id: 'req-x-repo', classroom_id: 'class-x', quiz_attempt_id: null, git_repo_assignment_id: 'g' },
  { id: 'req-y', classroom_id: 'class-y', quiz_attempt_id: 'att-2', git_repo_assignment_id: null },
];

const CLASSROOMS: Record<string, { id: string; status: string }> = {
  'class-x-slug': { id: 'class-x', status: 'ACTIVE' },
  'class-y-slug': { id: 'class-y', status: 'ACTIVE' },
};

/**
 * The gate as requireClassroomTeachingTeam behaves: OWNER, TEACHER and
 * ASSISTANT pass; anyone else is refused with a 403 Response.
 */
const signInAs = (role: string, userId = 'staff-1') =>
  mocks.gate.mockImplementation(async (_request: Request, slug: string) => {
    if (!['OWNER', 'TEACHER', 'ASSISTANT'].includes(role)) {
      throw new Response('Forbidden', { status: 403 });
    }
    return { userId, classroom: CLASSROOMS[slug], membership: { role } };
  });

const call = (body: Record<string, unknown>, slug = 'class-x-slug') =>
  action({
    params: { class: slug },
    request: new Request(`http://localhost/assistant/${slug}/regrade-requests`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
  } as unknown as Parameters<typeof action>[0]);

const adjust = (over: Record<string, unknown> = {}) => ({
  intent: 'resolve-quiz',
  requestId: 'req-x',
  resolution: 'APPROVED',
  emoji: 'score-90',
  comment: 'Q2 now has full credit.',
  ...over,
});

type DataResult = { data: { error?: string }; init?: { status?: number } };

beforeEach(() => {
  vi.clearAllMocks();
  signInAs('ASSISTANT');
  mocks.findMany.mockImplementation(async (where: { id: string; classroom_id: string }) =>
    REQUESTS.filter(r => r.id === where.id && r.classroom_id === where.classroom_id)
  );
  mocks.resolveQuiz.mockResolvedValue({
    request: { id: 'req-x', status: 'APPROVED' },
    alreadyResolved: false,
    classroomId: 'class-x',
    quiz: { id: 'quiz-1', name: 'Recursion check-in', assignmentTitle: 'Recursion' },
    student: { id: 'student-1', email: 'ada@example.test', name: 'Ada' },
  });
  mocks.trigger.mockResolvedValue({ id: 'run-1' });
});

describe('quiz regrade resolve action', () => {
  it('lets an assistant adjust the score, with the reply, and emails the student', async () => {
    const result = await call(adjust());

    expect(mocks.gate).toHaveBeenCalledWith(expect.any(Request), 'class-x-slug', {
      resourceType: 'REGRADE_REQUEST',
      action: 'resolve_regrade_request',
    });
    // Scoped by the URL's classroom, never by an id from the body.
    expect(mocks.findMany).toHaveBeenCalledWith({ id: 'req-x', classroom_id: 'class-x' });
    expect(mocks.resolveQuiz).toHaveBeenCalledWith({
      requestId: 'req-x',
      resolution: 'APPROVED',
      emoji: 'score-90',
      comment: 'Q2 now has full credit.',
      actorUserId: 'staff-1',
      tool: 'web:regrade_requests.resolve_quiz',
      impersonatedBy: null,
    });
    // The quiz resolution email, by request id only (it re-reads the request).
    expect(mocks.trigger).toHaveBeenCalledWith('quiz_regrade_resolved', { request_id: 'req-x' });
    // Never the task whose run writes the status: resolveQuiz already did.
    expect(mocks.trigger).not.toHaveBeenCalledWith('update_regrade_request', expect.anything());
    expect(result).toMatchObject({ success: 'Score adjusted' });
  });

  it('lets a teacher keep the score (DENIED) without an emoji', async () => {
    signInAs('TEACHER');
    const result = await call(adjust({ resolution: 'DENIED', emoji: undefined }));

    expect(mocks.resolveQuiz).toHaveBeenCalledWith(
      expect.objectContaining({ resolution: 'DENIED', emoji: undefined })
    );
    expect(result).toMatchObject({ success: 'Score kept' });
  });

  it('refuses a student: the gate throws and nothing is resolved', async () => {
    signInAs('STUDENT', 'student-1');

    await expect(call(adjust())).rejects.toMatchObject({ status: 403 });
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.resolveQuiz).not.toHaveBeenCalled();
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  it("refuses a staff member of classroom Y resolving classroom X's request", async () => {
    signInAs('OWNER', 'owner-of-y');

    const result = (await call(adjust({ requestId: 'req-x' }), 'class-y-slug')) as DataResult;

    expect(result.init?.status).toBe(404);
    expect(mocks.findMany).toHaveBeenCalledWith({ id: 'req-x', classroom_id: 'class-y' });
    expect(mocks.resolveQuiz).not.toHaveBeenCalled();
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  it('refuses a missing or blank reply', async () => {
    for (const comment of [undefined, '', '   ']) {
      const result = (await call(adjust({ comment }))) as DataResult;
      expect(result.init?.status).toBe(400);
      expect(result.data.error).toMatch(/reply/i);
    }
    expect(mocks.resolveQuiz).not.toHaveBeenCalled();
  });

  it('refuses Adjust score with no emoji, and an unknown resolution', async () => {
    expect(((await call(adjust({ emoji: undefined }))) as DataResult).init?.status).toBe(400);
    expect(((await call(adjust({ resolution: 'MAYBE' }))) as DataResult).init?.status).toBe(400);
    expect(mocks.resolveQuiz).not.toHaveBeenCalled();
  });

  it('does not resolve a repo request here', async () => {
    const result = (await call(adjust({ requestId: 'req-x-repo' }))) as DataResult;

    expect(result.init?.status).toBe(400);
    expect(mocks.resolveQuiz).not.toHaveBeenCalled();
  });

  it("maps the service's QuizGradeError to its status", async () => {
    mocks.resolveQuiz.mockRejectedValue(
      new QuizGradeError('invalid_emoji', 'That emoji is not on the scale', 400)
    );

    const result = (await call(adjust({ emoji: 'not-on-scale' }))) as DataResult;

    expect(result.init?.status).toBe(400);
    expect(result.data.error).toBe('That emoji is not on the scale');
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  it('sends no email for a request that was already resolved', async () => {
    mocks.resolveQuiz.mockResolvedValue({
      request: { id: 'req-x', status: 'DENIED' },
      alreadyResolved: true,
      classroomId: 'class-x',
      quiz: { id: 'quiz-1', name: 'Recursion check-in', assignmentTitle: null },
      student: { id: 'student-1', email: 'ada@example.test', name: 'Ada' },
    });

    const result = await call(adjust());

    expect(result).toMatchObject({ alreadyResolved: true });
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  it('is the action the /teacher and /admin requests pages serve', async () => {
    const teacher = await import('../../teacher.$class_.regrade-requests/route');
    const admin = await import('../../admin.$class.regrade-requests/route');
    expect(teacher.action).toBe(action);
    expect(admin.action).toBe(action);
  });
});
