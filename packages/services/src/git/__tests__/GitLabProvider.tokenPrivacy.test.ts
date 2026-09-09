import { describe, it, expect, vi, afterEach } from 'vitest';
import { GitLabProvider } from '../GitLabProvider.ts';

/**
 * The access token is a live credential. It has to reach the Authorization
 * header and nowhere else — not onto a public field, not into the inherited
 * `credentials` bag, and so not into any log line, error dump, or serialised
 * copy of the provider that happens to walk its properties.
 */
const PAT = 'glpat-SUPER-SECRET-TOKEN';

function res(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
    headers: new Headers(),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('GitLabProvider token privacy', () => {
  it('does not leak the token through JSON.stringify', () => {
    const provider = new GitLabProvider('g', 'g', PAT);
    expect(JSON.stringify(provider)).not.toContain(PAT);
  });

  it('does not expose a token-bearing own property', () => {
    const provider = new GitLabProvider('g', 'g', PAT);
    const keys = Object.keys(provider);

    expect(keys).not.toContain('token');
    for (const key of keys) {
      const value = (provider as unknown as Record<string, unknown>)[key];
      expect(JSON.stringify(value) ?? '').not.toContain(PAT);
    }
  });

  it('keeps the token out of the inherited credentials field', () => {
    const provider = new GitLabProvider('g', 'g', PAT);
    expect(JSON.stringify(provider.credentials)).not.toContain(PAT);
  });

  it('still sends the token as a Bearer credential', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(res(200, [{ id: 1, username: 'ada' }]));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new GitLabProvider('g', 'g', PAT);
    await provider.getUserByLogin('ada');

    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe(`Bearer ${PAT}`);
  });
});
