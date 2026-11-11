/**
 * gitlabFetch in production on Cloudflare Workers vs Node. On Workers,
 * node:https refuses the `lookup` option the Node path pins addresses with,
 * so each hop goes through fetch() (which can't reach private addresses
 * there); https-only, the private-literal refusal and the redirect handling
 * stay. On Node nothing changes: the platform fetch is never used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@classmoji/database', () => ({ default: () => ({}) }));

const { gitlabFetch } = await import('../gitlabInstance.service.ts');

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production');
  fetchMock = vi.fn(async () => new Response('{"version":"17.0"}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('on Workers', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' });
  });

  it('calls fetch for one hop with redirects off and a timeout', async () => {
    const response = await gitlabFetch('https://gitlab.example.edu/api/v4/version', {
      headers: { authorization: 'Bearer t' },
    });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe('https://gitlab.example.edu/api/v4/version');
    expect(init.redirect).toBe('manual');
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ authorization: 'Bearer t' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('follows a redirect itself, dropping Authorization off-origin', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://cdn.example.org/v' } })
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const response = await gitlabFetch('https://gitlab.example.edu/api/v4/version', {
      headers: { authorization: 'Bearer t' },
    });
    expect(await response.text()).toBe('ok');
    const second = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(String(second[0])).toBe('https://cdn.example.org/v');
    expect(second[1].headers).toEqual({});
  });

  it.each([
    ['http://gitlab.example.edu/x', /non-https/],
    ['https://10.0.0.5/x', /private address/],
    ['https://[::1]/x', /private address/],
    ['https://169.254.169.254/x', /private address/],
  ])('refuses %s without fetching', async (url, reason) => {
    await expect(gitlabFetch(url)).rejects.toThrow(reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('on Node', () => {
  it('never uses the platform fetch', async () => {
    // A private literal is refused before any connection, as before.
    await expect(gitlabFetch('https://10.0.0.5/x')).rejects.toThrow(/private address/);
    // A public name goes through node:https (an unresolvable one fails there).
    await expect(gitlabFetch('https://gitlab.invalid/x')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
