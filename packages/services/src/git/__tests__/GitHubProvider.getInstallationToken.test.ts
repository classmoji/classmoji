import { describe, it, expect, vi, afterEach } from 'vitest';

// The App JWT is signed with GITHUB_PRIVATE_KEY_BASE64, which is captured at
// module load and is absent in tests. Stubbed because the signature is not what
// these tests are about — the request body is. (Hoisted above the import of the
// module under test, which is why the import below is dynamic.)
vi.mock('jsonwebtoken', () => ({
  default: { sign: () => 'test.jwt.token' },
  sign: () => 'test.jwt.token',
}));

const { GitHubProvider } = await import('../GitHubProvider.ts');

/**
 * The mint is the one place in this codebase that decides how much authority a
 * token carries, so these tests pin the request BODY, not just the response.
 *
 * `fetch` is stubbed rather than octokit mocked: this method deliberately does
 * not go through Octokit — it builds an App JWT and posts directly — so the
 * wire request is the unit under test.
 */
function stubFetch(payload: Record<string, unknown>, ok = true) {
  const fetchMock = vi.fn(async () => ({
    ok,
    status: ok ? 201 : 404,
    json: async () => payload,
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('GitHubProvider.getInstallationToken', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends NO body when unscoped, so existing callers are byte-for-byte unchanged', async () => {
    const fetchMock = stubFetch({ token: 'ghs_x', expires_at: '2026-09-03T01:00:00Z' });

    const result = await new GitHubProvider('99', 'org').getInstallationToken();

    expect(result).toEqual({ token: 'ghs_x', expiresAt: '2026-09-03T01:00:00Z' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/app/installations/99/access_tokens');
    expect(init.body).toBeUndefined();
    // No Content-Type either — an unscoped mint is exactly the request it was
    // before scoping existed.
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('narrows the token at the source when a scope is given', async () => {
    const fetchMock = stubFetch({ token: 'ghs_x', expires_at: '2026-09-03T01:00:00Z' });

    await new GitHubProvider('99', 'org').getInstallationToken({
      repositories: ['content-cs101'],
      permissions: { contents: 'read' },
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    // GitHub mints it already limited, so nothing downstream can widen it.
    expect(JSON.parse(init.body as string)).toEqual({
      repositories: ['content-cs101'],
      permissions: { contents: 'read' },
    });
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('ignores an empty scope rather than sending an empty body', async () => {
    const fetchMock = stubFetch({ token: 'ghs_x', expires_at: 'e' });

    await new GitHubProvider('99', 'org').getInstallationToken({ repositories: [] });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBeUndefined();
  });

  it('falls back to a one-hour expiry when GitHub omits expires_at', async () => {
    stubFetch({ token: 'ghs_x' });

    const { expiresAt } = await new GitHubProvider('99', 'org').getInstallationToken();

    const delta = new Date(expiresAt).getTime() - Date.now();
    expect(delta).toBeGreaterThan(55 * 60 * 1000);
    expect(delta).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it('throws, without a token, when GitHub refuses', async () => {
    stubFetch({ message: 'Not Found' }, false);

    await expect(new GitHubProvider('99', 'org').getInstallationToken()).rejects.toThrow(
      /Failed to retrieve GitHub installation token \(404\)/
    );
  });
});

/**
 * The cache in front of the mint.
 *
 * It is static and process-lifetime, exactly as it is in production, so these
 * tests give every case its own installation id rather than reaching in to
 * reset it. That keeps the entries disjoint without adding a test-only escape
 * hatch to a class whose whole job is handing out credentials.
 */
describe('GitHubProvider.getInstallationToken caching', () => {
  const READ_ONE_REPO = {
    repositories: ['content-cs101'],
    permissions: { contents: 'read' },
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function anHourOut(): string {
    return new Date(Date.now() + 60 * 60 * 1000).toISOString();
  }

  /** A fetch that answers each call with the next payload in the list. */
  function stubFetchSequence(payloads: Record<string, unknown>[]) {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      const payload = payloads[Math.min(call++, payloads.length - 1)];
      return { ok: true, status: 201, json: async () => payload };
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('serves a second request for the same scope from cache, without calling GitHub again', async () => {
    const fetchMock = stubFetchSequence([
      { token: 'ghs_first', expires_at: anHourOut() },
      { token: 'ghs_second', expires_at: anHourOut() },
    ]);

    const provider = new GitHubProvider('cache-hit', 'org');
    const first = await provider.getInstallationToken(READ_ONE_REPO);
    const second = await provider.getInstallationToken(READ_ONE_REPO);

    expect(second).toEqual(first);
    expect(second.token).toBe('ghs_first');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shares the entry across provider instances, since the cache is per installation not per object', async () => {
    const fetchMock = stubFetchSequence([{ token: 'ghs_shared', expires_at: anHourOut() }]);

    await new GitHubProvider('cache-shared', 'org').getInstallationToken(READ_ONE_REPO);
    const second = await new GitHubProvider('cache-shared', 'org').getInstallationToken(
      READ_ONE_REPO
    );

    expect(second.token).toBe('ghs_shared');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-mints once the cached token is inside the expiry skew', async () => {
    vi.useFakeTimers();

    const fetchMock = stubFetchSequence([
      { token: 'ghs_first', expires_at: anHourOut() },
      { token: 'ghs_fresh', expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() },
    ]);

    const provider = new GitHubProvider('cache-expiry', 'org');
    expect((await provider.getInstallationToken(READ_ONE_REPO)).token).toBe('ghs_first');

    // Still comfortably inside the window: the same token is still the answer.
    vi.advanceTimersByTime(50 * 60 * 1000);
    expect((await provider.getInstallationToken(READ_ONE_REPO)).token).toBe('ghs_first');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Now within five minutes of expiry. A token handed out here could die
    // mid-use, so it is replaced rather than served.
    vi.advanceTimersByTime(6 * 60 * 1000);
    expect((await provider.getInstallationToken(READ_ONE_REPO)).token).toBe('ghs_fresh');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps a separate entry per repo, so one repo never answers for another', async () => {
    const fetchMock = stubFetchSequence([
      { token: 'ghs_cs101', expires_at: anHourOut() },
      { token: 'ghs_cs200', expires_at: anHourOut() },
    ]);

    const provider = new GitHubProvider('cache-per-repo', 'org');
    const cs101 = await provider.getInstallationToken({
      repositories: ['content-cs101'],
      permissions: { contents: 'read' },
    });
    const cs200 = await provider.getInstallationToken({
      repositories: ['content-cs200'],
      permissions: { contents: 'read' },
    });

    expect(cs101.token).toBe('ghs_cs101');
    expect(cs200.token).toBe('ghs_cs200');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps a separate entry per permission set, so a narrow ask never returns a wider token', async () => {
    const fetchMock = stubFetchSequence([
      { token: 'ghs_read', expires_at: anHourOut() },
      { token: 'ghs_write', expires_at: anHourOut() },
    ]);

    const provider = new GitHubProvider('cache-per-perm', 'org');
    const read = await provider.getInstallationToken({
      repositories: ['content-cs101'],
      permissions: { contents: 'read' },
    });
    const write = await provider.getInstallationToken({
      repositories: ['content-cs101'],
      permissions: { contents: 'write' },
    });

    expect(read.token).toBe('ghs_read');
    expect(write.token).toBe('ghs_write');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent cold requests into ONE mint', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const fetchMock = vi.fn(async () => {
      await gate;
      return {
        ok: true,
        status: 201,
        json: async () => ({ token: 'ghs_only', expires_at: anHourOut() }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new GitHubProvider('cache-concurrent', 'org');
    const inFlight = Promise.all([
      provider.getInstallationToken(READ_ONE_REPO),
      provider.getInstallationToken(READ_ONE_REPO),
      provider.getInstallationToken(READ_ONE_REPO),
    ]);

    release();
    const results = await inFlight;

    expect(results.map(r => r.token)).toEqual(['ghs_only', 'ghs_only', 'ghs_only']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not remember a failed mint - the next call tries again', async () => {
    const failing = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ message: 'Not Found' }),
    }));
    vi.stubGlobal('fetch', failing);

    const provider = new GitHubProvider('cache-rejection', 'org');
    await expect(provider.getInstallationToken(READ_ONE_REPO)).rejects.toThrow(
      /Failed to retrieve GitHub installation token \(404\)/
    );

    const succeeding = stubFetchSequence([{ token: 'ghs_after_retry', expires_at: anHourOut() }]);
    expect((await provider.getInstallationToken(READ_ONE_REPO)).token).toBe('ghs_after_retry');
    expect(succeeding).toHaveBeenCalledTimes(1);
  });

  it('rejects every waiter on a failed mint, and leaves nothing behind', async () => {
    const failing = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ message: 'boom' }),
    }));
    vi.stubGlobal('fetch', failing);

    const provider = new GitHubProvider('cache-concurrent-failure', 'org');
    const results = await Promise.allSettled([
      provider.getInstallationToken(READ_ONE_REPO),
      provider.getInstallationToken(READ_ONE_REPO),
    ]);

    expect(results.map(r => r.status)).toEqual(['rejected', 'rejected']);
    expect(failing).toHaveBeenCalledTimes(1);

    const succeeding = stubFetchSequence([{ token: 'ghs_recovered', expires_at: anHourOut() }]);
    expect((await provider.getInstallationToken(READ_ONE_REPO)).token).toBe('ghs_recovered');
    expect(succeeding).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache unscoped mints, which still carry the full installation authority', async () => {
    const fetchMock = stubFetchSequence([
      { token: 'ghs_unscoped_a', expires_at: anHourOut() },
      { token: 'ghs_unscoped_b', expires_at: anHourOut() },
    ]);

    const provider = new GitHubProvider('cache-unscoped', 'org');
    expect((await provider.getInstallationToken()).token).toBe('ghs_unscoped_a');
    // An empty scope is an unscoped request on the wire, so it is one here too.
    expect((await provider.getInstallationToken({ repositories: [] })).token).toBe(
      'ghs_unscoped_b'
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache a token whose expiry it cannot read', async () => {
    const fetchMock = stubFetchSequence([
      { token: 'ghs_bad_expiry', expires_at: 'not-a-date' },
      { token: 'ghs_bad_expiry_2', expires_at: 'not-a-date' },
    ]);

    const provider = new GitHubProvider('cache-bad-expiry', 'org');
    expect((await provider.getInstallationToken(READ_ONE_REPO)).token).toBe('ghs_bad_expiry');
    expect((await provider.getInstallationToken(READ_ONE_REPO)).token).toBe('ghs_bad_expiry_2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
