/**
 * `/api/operation?action=updateRegradeRequest`: resolving a regrade request.
 *
 * Held here: authorization is on the RECORD's classroom (teaching team); the
 * status must be APPROVED or DENIED; a QUIZ request goes through
 * `regradeRequest.resolveQuiz` (the reply required, the emoji for APPROVED)
 * and then only the `quiz_regrade_resolved` email, never
 * `update_regrade_request` (which would flip the status with no adjustment
 * and clear nothing of a repo grade); a repo request keeps its task, with the
 * reply stored when one is given and the session user as `resolved_by_id`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  resolveQuiz: vi.fn(),
  trigger: vi.fn(),
  waitForRunCompletion: vi.fn(),
  assertClassroomAccess: vi.fn(),
}));

class QuizGradeError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

vi.mock('@classmoji/services', () => ({
  QuizGradeError,
  ClassmojiService: {
    regradeRequest: {
      findMany: (...a: unknown[]) => mocks.findMany(...a),
      resolveQuiz: (...a: unknown[]) => mocks.resolveQuiz(...a),
    },
  },
}));
vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: async () => ({ userId: 'ta-1', session: { session: {} } }),
}));
vi.mock('@trigger.dev/sdk', () => ({
  tasks: { trigger: (...a: unknown[]) => mocks.trigger(...a) },
}));
vi.mock('~/utils/helpers', () => ({
  checkAuth: (handler: unknown) => handler,
  waitForRunCompletion: (...a: unknown[]) => mocks.waitForRunCompletion(...a),
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
}));

const { action } = await import('../route');

const post = (body: unknown) =>
  (action as unknown as (args: unknown) => Promise<unknown>)({
    request: new Request('http://localhost/api/operation/?action=updateRegradeRequest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });

/** A react-router `data()` response's body and status, or a plain object as is. */
const unwrap = (result: unknown) => {
  const r = result as { data?: unknown; init?: { status?: number } | null; type?: string };
  return r && r.type === 'DataWithResponseInit'
    ? { body: r.data as Record<string, unknown>, status: r.init?.status ?? 200 }
    : { body: result as Record<string, unknown>, status: 200 };
};

const quizRequest = {
  id: 'rr-quiz',
  classroom_id: 'class-1',
  quiz_attempt_id: 'att-2',
  student: { email: 'ada@school.edu' },
  git_repo_assignment: null,
};
const repoRequest = {
  id: 'rr-repo',
  classroom_id: 'class-1',
  quiz_attempt_id: null,
  student: { email: 'ada@school.edu' },
  git_repo_assignment: { assignment: { title: 'Lab 1' } },
};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.assertClassroomAccess.mockResolvedValue({ userId: 'ta-1' });
  mocks.trigger.mockResolvedValue({ id: 'run-1' });
  mocks.resolveQuiz.mockResolvedValue({ alreadyResolved: false });
});

describe('updateRegradeRequest', () => {
  it("authorizes the teaching team on the record's own classroom", async () => {
    mocks.findMany.mockResolvedValue([quizRequest]);
    await post({ request: { id: 'rr-quiz' }, status: 'DENIED', comment: 'No.' });
    expect(mocks.findMany).toHaveBeenCalledWith({ id: 'rr-quiz' });
    expect(mocks.assertClassroomAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        classroomId: 'class-1',
        allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT'],
      })
    );
  });

  it('refuses a status other than APPROVED or DENIED', async () => {
    mocks.findMany.mockResolvedValue([repoRequest]);
    const { status } = unwrap(await post({ request: { id: 'rr-repo' }, status: 'IN_REVIEW' }));
    expect(status).toBe(400);
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  it('resolves a quiz request through resolveQuiz, then queues only its email', async () => {
    mocks.findMany.mockResolvedValue([quizRequest]);

    const { body } = unwrap(
      await post({
        request: { id: 'rr-quiz' },
        status: 'APPROVED',
        emoji: 'rocket',
        comment: ' Fair point. ',
      })
    );

    expect(mocks.resolveQuiz).toHaveBeenCalledWith({
      requestId: 'rr-quiz',
      resolution: 'APPROVED',
      emoji: 'rocket',
      comment: 'Fair point.',
      actorUserId: 'ta-1',
      tool: 'web:api.updateRegradeRequest',
      impersonatedBy: null,
    });
    expect(mocks.trigger).toHaveBeenCalledTimes(1);
    expect(mocks.trigger).toHaveBeenCalledWith('quiz_regrade_resolved', { request_id: 'rr-quiz' });
    expect(body.success).toBe('Score adjusted');
  });

  it("passes the service's refusal through (a missing reply or emoji)", async () => {
    mocks.findMany.mockResolvedValue([quizRequest]);
    mocks.resolveQuiz.mockRejectedValue(
      new QuizGradeError('invalid_input', 'A reply to the student is required', 400)
    );
    const { body, status } = unwrap(await post({ request: { id: 'rr-quiz' }, status: 'DENIED' }));
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_input');
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  it('sends no second email for a quiz request already resolved', async () => {
    mocks.findMany.mockResolvedValue([quizRequest]);
    mocks.resolveQuiz.mockResolvedValue({ alreadyResolved: true });
    await post({ request: { id: 'rr-quiz' }, status: 'DENIED', comment: 'No.' });
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  it('keeps the repo path on its task, storing a reply when given', async () => {
    mocks.findMany.mockResolvedValue([repoRequest]);
    await post({ request: { id: 'rr-repo' }, status: 'APPROVED', comment: 'Regraded.' });
    expect(mocks.resolveQuiz).not.toHaveBeenCalled();
    expect(mocks.trigger).toHaveBeenCalledWith('update_regrade_request', {
      request: {
        id: 'rr-repo',
        student: { email: 'ada@school.edu' },
        git_repo_assignment: { assignment: { title: 'Lab 1' } },
      },
      data: { status: 'APPROVED', grader_comment: 'Regraded.' },
      // Who resolved it: the session user the gate admitted, never the body.
      resolved_by_id: 'ta-1',
    });
  });

  it('names the session user as the resolver even when the body names someone else', async () => {
    mocks.findMany.mockResolvedValue([repoRequest]);
    const body = (await post({
      request: { id: 'rr-repo' },
      status: 'DENIED',
      data: { resolved_by_id: 'mallory' },
      resolved_by_id: 'mallory',
    })) as { success?: string };
    expect(mocks.trigger).toHaveBeenCalledWith(
      'update_regrade_request',
      expect.objectContaining({ data: { status: 'DENIED' }, resolved_by_id: 'ta-1' })
    );
    expect(body.success).toBe('Regrade/resubmit request updated');
  });
});
