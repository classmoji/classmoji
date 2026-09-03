import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * POST /api/content/token is a credential vending machine: it hands a GitHub
 * installation token to a caller that presents a shared secret. So these tests
 * are mostly about what it must REFUSE, and about the fact that it refuses
 * before it does anything else.
 *
 * Prisma and the git provider are mocked — neither a database nor GitHub is
 * under test here, the gate is. The env var is manipulated per test on purpose:
 * the route reads it inside the handler precisely so that it can change without
 * a reboot, and a module-level read would make this suite impossible to write.
 */

const findByIdMock = vi.fn();
const getInstallationTokenMock = vi.fn();
const getGitProviderMock = vi.fn();

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroom: { findById: (...a: unknown[]) => findByIdMock(...a) },
  },
  getGitProvider: (...a: unknown[]) => getGitProviderMock(...a),
  describeTokenMintError: (org: string, error: unknown) =>
    `mint failed for ${org}: ${error instanceof Error ? error.message : String(error)}`,
}));

const { action, loader } = await import('../route.ts');

const SECRET = 'a-shared-secret-value';

const post = (body: unknown, headers: Record<string, string> = {}) =>
  ({
    request: new Request('http://localhost/api/content/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  }) as unknown as Parameters<typeof action>[0];

const authed = (body: unknown) => post(body, { Authorization: `Bearer ${SECRET}` });

const CLASSROOM = {
  id: 'class-1',
  content_repo: 'content-cs101',
  git_organization: { id: 'org-1', provider: 'GITHUB', login: 'dartmouth-cs', installationId: '9' },
};

describe('POST /api/content/token', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONTENT_WORKER_SHARED_SECRET = SECRET;
    getGitProviderMock.mockReturnValue({ getInstallationToken: getInstallationTokenMock });
  });

  afterEach(() => {
    delete process.env.CONTENT_WORKER_SHARED_SECRET;
  });

  it('503s when CONTENT_WORKER_SHARED_SECRET is unset, without touching the database', async () => {
    delete process.env.CONTENT_WORKER_SHARED_SECRET;

    const res = await action(authed({ classroomId: 'class-1' }));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'not configured' });
    // The point of the 503 is that an unconfigured deployment does no work and
    // fails nothing else. A lookup here would mean the route had already
    // committed to serving the request.
    expect(findByIdMock).not.toHaveBeenCalled();
  });

  it('401s on a wrong secret', async () => {
    const res = await action(post({ classroomId: 'class-1' }, { Authorization: 'Bearer wrong' }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(findByIdMock).not.toHaveBeenCalled();
    expect(getInstallationTokenMock).not.toHaveBeenCalled();
  });

  it('401s on a missing Authorization header', async () => {
    const res = await action(post({ classroomId: 'class-1' }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(findByIdMock).not.toHaveBeenCalled();
  });

  it('401s on a secret that is a PREFIX of the real one', async () => {
    // Guards the compare itself: a `startsWith`, or a truncated buffer compare,
    // would let this through.
    const res = await action(
      post({ classroomId: 'class-1' }, { Authorization: `Bearer ${SECRET.slice(0, -1)}` })
    );

    expect(res.status).toBe(401);
    expect(findByIdMock).not.toHaveBeenCalled();
  });

  it('404s on an unknown classroom', async () => {
    findByIdMock.mockResolvedValue(null);

    const res = await action(authed({ classroomId: 'nope' }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
    expect(getInstallationTokenMock).not.toHaveBeenCalled();
  });

  it('404s on a classroom with no git organization', async () => {
    findByIdMock.mockResolvedValue({ ...CLASSROOM, git_organization: null });

    const res = await action(authed({ classroomId: 'class-1' }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('200s with org, repo, token and expiresAt', async () => {
    findByIdMock.mockResolvedValue(CLASSROOM);
    getInstallationTokenMock.mockResolvedValue({
      token: 'ghs_installationtoken',
      expiresAt: '2026-09-03T01:00:00Z',
    });

    const res = await action(authed({ classroomId: 'class-1' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      org: 'dartmouth-cs',
      repo: 'content-cs101',
      token: 'ghs_installationtoken',
      expiresAt: '2026-09-03T01:00:00Z',
    });
    // The token is minted through the classroom's OWN git organization —
    // installation access is per-org, so a provider built from anything else
    // would be a token for the wrong repo.
    expect(getGitProviderMock).toHaveBeenCalledWith(CLASSROOM.git_organization);
  });

  it('mints a token narrowed to one repo, read-only', async () => {
    // The whole blast radius of this endpoint. An unscoped installation token
    // carries every permission the app holds on EVERY repo in the org —
    // student assignment repos and staff grading repos included — and this
    // hands it to an edge Worker. Scoped at the mint, a leaked token (or a
    // leaked shared secret) reads one content repo for one hour.
    findByIdMock.mockResolvedValue(CLASSROOM);
    getInstallationTokenMock.mockResolvedValue({ token: 't', expiresAt: 'e' });

    await action(authed({ classroomId: 'class-1' }));

    expect(getInstallationTokenMock).toHaveBeenCalledWith({
      repositories: ['content-cs101'],
      permissions: { contents: 'read' },
    });
  });

  it('never lets a credential-bearing response be cached', async () => {
    findByIdMock.mockResolvedValue(CLASSROOM);
    getInstallationTokenMock.mockResolvedValue({ token: 't', expiresAt: 'e' });

    const res = await action(authed({ classroomId: 'class-1' }));

    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('400s when classroomId is missing', async () => {
    const res = await action(authed({}));

    expect(res.status).toBe(400);
    expect(findByIdMock).not.toHaveBeenCalled();
  });

  it('502s, and does not leak the token or the raw error, when the mint fails', async () => {
    findByIdMock.mockResolvedValue(CLASSROOM);
    getInstallationTokenMock.mockRejectedValue(
      new Error('https://x-access-token:ghs_leaked@github.com/... not found')
    );

    const res = await action(authed({ classroomId: 'class-1' }));
    const body = await res.text();

    expect(res.status).toBe(502);
    expect(JSON.parse(body)).toEqual({ error: 'token mint failed' });
    expect(body).not.toContain('ghs_');
  });

  it('405s on GET', async () => {
    const res = await loader();

    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: 'method not allowed' });
  });

  it('405s on a non-POST method that reaches the action', async () => {
    const res = await action({
      request: new Request('http://localhost/api/content/token', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${SECRET}` },
      }),
    } as unknown as Parameters<typeof action>[0]);

    expect(res.status).toBe(405);
    expect(findByIdMock).not.toHaveBeenCalled();
  });
});
