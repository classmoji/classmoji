import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setErrorReporter, type ReportContext } from '@classmoji/utils/error-report';

/**
 * Failures the webapp catches and answers with a fallback are also reported
 * (`reportError`), beside the log line they already had: what each call site
 * returns is unchanged, expected outcomes (a student-side Github refusal) are
 * not reported, a config gap is reported once per process, and a failed mint
 * is reported by its laundered text only. With no reporter registered (Sentry
 * off) nothing is sent and the answers are the same.
 */

const mocks = vi.hoisted(() => ({
  quizzesVisibleOrThrow: vi.fn(),
  auditCreate: vi.fn(),
  userFindUnique: vi.fn(),
  collabFindUnique: vi.fn(),
  membershipState: vi.fn(),
  ensureTeam: vi.fn(),
  getUserByLogin: vi.fn(),
  inviteToOrganization: vi.fn(),
  classroomFindById: vi.fn(),
  getInstallationToken: vi.fn(),
  taskTrigger: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    entitlement: { quizzesVisibleOrThrow: (...a: unknown[]) => mocks.quizzesVisibleOrThrow(...a) },
    audit: {
      create: (...a: unknown[]) => mocks.auditCreate(...a),
      record: (...a: unknown[]) => mocks.auditCreate(...a),
    },
    classroomMembership: { updateById: vi.fn() },
    classroom: { findById: (...a: unknown[]) => mocks.classroomFindById(...a) },
    gitlabInstance: { defaultHost: () => 'https://gitlab.com' },
  },
  getGitProvider: () => ({
    orgMembershipState: (...a: unknown[]) => mocks.membershipState(...a),
    addTeamMember: vi.fn(),
    getUserByLogin: (...a: unknown[]) => mocks.getUserByLogin(...a),
    inviteToOrganization: (...a: unknown[]) => mocks.inviteToOrganization(...a),
    getInstallationToken: (...a: unknown[]) => mocks.getInstallationToken(...a),
  }),
  ensureClassroomTeam: (...a: unknown[]) => mocks.ensureTeam(...a),
  describeTokenMintError: (org: string) => `laundered mint failure for ${org}`,
  tokenMintErrorStatus: (error: { status?: number }) =>
    typeof error?.status === 'number' ? error.status : null,
}));

vi.mock('@classmoji/database', async () => ({
  ...(await vi.importActual<typeof import('@classmoji/database/gitIdentity')>(
    '@classmoji/database/gitIdentity'
  )),
  default: () => ({
    user: { findUnique: (...a: unknown[]) => mocks.userFindUnique(...a) },
    collabDoc: { findUnique: (...a: unknown[]) => mocks.collabFindUnique(...a) },
  }),
}));

vi.mock('@trigger.dev/sdk', () => ({
  tasks: { trigger: (...a: unknown[]) => mocks.taskTrigger(...a) },
}));

const { loadQuizzesVisible } = await import('../classroomProFlag.server');
const { notifyCollabFlag, closeLivePageForDelete } = await import('../collab.server');
const { joinGitOrganization } = await import('../joinGitOrganization.server');
const contentToken = await import('../../routes/api.content.token/route');

const capture = vi.fn<(error: unknown, context: ReportContext) => void>();

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  capture.mockReset();
  setErrorReporter({ capture, flush: async () => true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  setErrorReporter(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('loadQuizzesVisible', () => {
  it('still answers false, and reports the failed lookup once', async () => {
    const failure = new Error('database unreachable');
    mocks.quizzesVisibleOrThrow.mockRejectedValue(failure);

    await expect(loadQuizzesVisible('class-1')).resolves.toBe(false);

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(failure, {
      surface: 'quiz.visibility',
      tags: { classroom_id: 'class-1' },
    });
  });

  it('answers the same with no reporter registered', async () => {
    setErrorReporter(null);
    mocks.quizzesVisibleOrThrow.mockRejectedValue(new Error('database unreachable'));
    await expect(loadQuizzesVisible('class-1')).resolves.toBe(false);
    expect(capture).not.toHaveBeenCalled();
  });
});

describe('collab', () => {
  const ENV = { httpUrl: 'http://collab.test', wsUrl: 'ws://collab.test', secret: 's3cret' };

  it('reports a refused flag change with its status, still answering ok: false', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 500 }));
    await expect(notifyCollabFlag('class-1', true, { env: ENV, fetchImpl })).resolves.toEqual({
      ok: false,
    });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0][1]).toEqual({
      surface: 'collab.flag',
      tags: { classroom_id: 'class-1', status: 500 },
    });
  });

  it('does not report the 404 a page close treats as fine', async () => {
    mocks.collabFindUnique.mockResolvedValue({ epoch: 1 });
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 404 }));
    await expect(
      closeLivePageForDelete({ pageId: 'page-1', classroom: {} }, { env: ENV, fetchImpl })
    ).resolves.toEqual({ ok: true });
    expect(capture).not.toHaveBeenCalled();
  });

  it('reports a missing collab server once per process', async () => {
    await notifyCollabFlag('class-1', true, { env: null });
    await notifyCollabFlag('class-2', false, { env: null });
    mocks.collabFindUnique.mockResolvedValue({ epoch: 1 });
    await closeLivePageForDelete({ pageId: 'page-1', classroom: {} }, { env: null });

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0][1]).toEqual({ surface: 'collab.config', level: 'warning' });
  });
});

describe('joinGitOrganization (Github)', () => {
  const run = () =>
    joinGitOrganization({
      userId: 'user-a',
      membership: { id: 'mem-a', role: 'STUDENT' },
      classroom: {
        id: 'class-x',
        slug: 'cs10',
        name: 'CS 10',
        git_organization: { id: 'org-1', provider: 'GITHUB', login: 'cs10-org' } as never,
      },
      tool: 'web:roster.join_link',
    });

  beforeEach(() => {
    mocks.userFindUnique.mockResolvedValue({
      accounts: [
        { provider_id: 'github', account_id: '42', username: 'ada', gitlab_instance_id: '' },
      ],
    });
    mocks.auditCreate.mockResolvedValue(undefined);
    mocks.membershipState.mockResolvedValue('none');
    mocks.ensureTeam.mockResolvedValue({ id: 7, slug: 'cs10-students' });
    mocks.getUserByLogin.mockResolvedValue({ id: 42 });
  });

  it('reports a Github failure on our side (5xx) and answers as before', async () => {
    const failure = Object.assign(new Error('Server Error'), { status: 502 });
    mocks.inviteToOrganization.mockRejectedValue(failure);

    const result = await run();

    expect(result).toMatchObject({ ok: false, reason: 'failed' });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(failure, {
      surface: 'join.github.invite',
      tags: { classroom_id: 'class-x', tool: 'web:roster.join_link', status: 502 },
    });
  });

  it('does not report a refusal the student acts on (422 already a member)', async () => {
    mocks.inviteToOrganization.mockRejectedValue(
      Object.assign(new Error('Validation Failed'), {
        status: 422,
        response: {
          data: { errors: [{ message: 'Invitee is already a part of this organization' }] },
        },
      })
    );

    const result = await run();

    expect(result).toMatchObject({ ok: false, reason: 'failed' });
    expect(capture).not.toHaveBeenCalled();
  });
});

describe('api.content.token', () => {
  const post = (body: unknown) =>
    contentToken.action({
      request: new Request('https://app.example.test/api/content/token', {
        method: 'POST',
        headers: { Authorization: 'Bearer worker-secret' },
        body: JSON.stringify(body),
      }),
    } as never);

  it('reports an unset secret once per process, still answering 503', async () => {
    vi.stubEnv('CONTENT_WORKER_SHARED_SECRET', '');
    expect((await post({})).status).toBe(503);
    expect((await post({})).status).toBe(503);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0][1]).toEqual({
      surface: 'content_token.config',
      level: 'warning',
    });
  });

  const mintFailure = async (raw: unknown, provider: 'GITHUB' | 'GITLAB') => {
    vi.stubEnv('CONTENT_WORKER_SHARED_SECRET', 'worker-secret');
    const classroomId = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
    mocks.classroomFindById.mockResolvedValue({
      content_repo: 'content',
      git_organization: { provider, login: 'cs10-org' },
    });
    mocks.getInstallationToken.mockRejectedValue(raw);
    expect((await post({ classroomId })).status).toBe(502);
    expect(capture).toHaveBeenCalledTimes(1);
    return { classroomId, reported: capture.mock.calls[0][0], context: capture.mock.calls[0][1] };
  };

  it('reports a failed mint by its status only, never the raw error or its text', async () => {
    const raw = Object.assign(
      new Error('fatal: https://x-access-token:ghs_abcdefghijklmnop1234@github.com'),
      { status: 404 }
    );
    const { classroomId, reported, context } = await mintFailure(raw, 'GITHUB');
    expect(reported).not.toBe(raw);
    expect((reported as Error).message).toBe('Token mint failed (404)');
    expect(context).toEqual({
      surface: 'content_token.mint',
      tags: { classroom_id: classroomId, status: 404, provider: 'GITHUB' },
    });
  });

  it('a Gitlab failure with no status sends none of its message', async () => {
    const raw = new Error('Gitlab said: group jane-doe-projects/hw1 for jane@school.edu refused');
    const { classroomId, reported, context } = await mintFailure(raw, 'GITLAB');
    expect((reported as Error).message).toBe('Token mint failed (no status)');
    expect(JSON.stringify(context)).not.toContain('jane');
    expect(context).toEqual({
      surface: 'content_token.mint',
      tags: { classroom_id: classroomId, status: undefined, provider: 'GITLAB' },
    });
  });
});
