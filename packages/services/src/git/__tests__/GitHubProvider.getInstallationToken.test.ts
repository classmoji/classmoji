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
