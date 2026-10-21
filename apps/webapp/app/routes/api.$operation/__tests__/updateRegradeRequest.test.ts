/**
 * `/api/operation?action=updateRegradeRequest`: resolving a REPO regrade request.
 *
 * Held here: authorization is on the RECORD's classroom (teaching team); the
 * status must be APPROVED or DENIED; a QUIZ request is refused (400): quiz
 * requests resolve only on the Regrade/Resubmit Requests page or through the
 * MCP, which write the adjustment with the status; a read-only classroom's
 * refusal comes back as data; a repo request keeps its task, with the reply
 * stored when one is given, the session user as `resolved_by_id` and this
 * surface as the audit `tool`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  trigger: vi.fn(),
  waitForRunCompletion: vi.fn(),
  assertClassroomAccess: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    regradeRequest: {
      findMany: (...a: unknown[]) => mocks.findMany(...a),
    },
  },
}));
vi.mock('@classmoji/auth/server', async () => {
  const predicates = await vi.importActual<typeof import('@classmoji/auth/predicates')>(
    '@classmoji/auth/predicates'
  );
  return {
    ...predicates,
    getAuthSession: async () => ({ userId: 'ta-1', session: { session: {} } }),
  };
});
vi.mock('~/routes/admin.$class.ask-moji/impersonation.server', () => ({
  impersonatedBy: async () => null,
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
  mocks.assertClassroomAccess.mockResolvedValue({
    userId: 'ta-1',
    classroom: { id: 'class-1', status: 'ACTIVE' },
    membership: { role: 'ASSISTANT' },
  });
  mocks.trigger.mockResolvedValue({ id: 'run-1' });
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

  it('refuses a quiz request: it resolves on the queue page or through the MCP', async () => {
    mocks.findMany.mockResolvedValue([quizRequest]);
    const { body, status } = unwrap(
      await post({
        request: { id: 'rr-quiz' },
        status: 'APPROVED',
        emoji: 'rocket',
        comment: 'Fair point.',
      })
    );
    expect(status).toBe(400);
    expect(body.code).toBe('not_repo_request');
    expect(String(body.error)).toContain('Regrade/Resubmit Requests');
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  it("returns a read-only classroom's refusal as data, writing nothing", async () => {
    mocks.findMany.mockResolvedValue([repoRequest]);
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: 'ta-1',
      classroom: { id: 'class-1', status: 'LOCKED' },
      membership: { role: 'ASSISTANT' },
    });
    const { body, status } = unwrap(await post({ request: { id: 'rr-repo' }, status: 'APPROVED' }));
    expect(status).toBe(403);
    expect(body.code).toBe('CLASSROOM_LOCKED');
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  it('keeps the repo path on its task, storing a reply when given', async () => {
    mocks.findMany.mockResolvedValue([repoRequest]);
    await post({ request: { id: 'rr-repo' }, status: 'APPROVED', comment: 'Regraded.' });
    expect(mocks.trigger).toHaveBeenCalledWith('update_regrade_request', {
      request: {
        id: 'rr-repo',
        student: { email: 'ada@school.edu' },
        git_repo_assignment: { assignment: { title: 'Lab 1' } },
      },
      data: { status: 'APPROVED', grader_comment: 'Regraded.' },
      // Who resolved it: the session user the gate admitted, never the body,
      // and this surface for the audit row.
      resolved_by_id: 'ta-1',
      tool: 'web:api.updateRegradeRequest',
      impersonated_by: null,
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
