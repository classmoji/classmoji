import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// uploadBatch rate-limit retry.
//
// uploadBatch does not pace its own writes — the Octokit throttling plugin
// already sends a process's writes one a second (mocked away here). What it
// owns is the retry: a rate-limit refusal is retried after the wait GitHub
// names, a bounded number of times, and never slept on past two minutes. The
// clock is faked (setTimeout + Date), so a test that waits a minute takes
// milliseconds — and a batch that should NOT wait is caught by never advancing
// the clock at all.

const requestMock = vi.fn();

vi.mock('../../git/index.ts', () => ({
  getGitProvider: () => ({
    getOctokit: async () => ({ request: (...args: unknown[]) => requestMock(...args) }),
  }),
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({ gitOrganization: { findFirst: vi.fn() } }),
}));

const { ContentService } = await import('../ContentService.ts');
const { RepoFileTooLargeError } = await import('../repoLimits.ts');

const gitOrganization = { provider: 'GITHUB', login: 'test-org' };
const BLOB = 'POST /repos/{owner}/{repo}/git/blobs';
const TREE = 'POST /repos/{owner}/{repo}/git/trees';
const GET_REF = 'GET /repos/{owner}/{repo}/git/ref/{ref}';

/** Captured before the clock is faked: the one timer a test can still rely on. */
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

type Params = Record<string, unknown>;
type Handler = (route: string, params: Params) => unknown;

/** Happy-path Git Data answers; `override` sees every call first. */
function github(override?: Handler) {
  requestMock.mockImplementation(async (route: string, params: Params) => {
    const answer = override?.(route, params);
    if (answer !== undefined) return answer;
    switch (route) {
      case BLOB: {
        const decoded = Buffer.from(String(params.content), 'base64').toString('utf-8');
        return { data: { sha: `blob-${decoded}` } };
      }
      case GET_REF:
        return { data: { object: { sha: 'head-commit' } } };
      case 'GET /repos/{owner}/{repo}/git/commits/{commit_sha}':
        return { data: { tree: { sha: 'base-tree' } } };
      case TREE:
        return { data: { sha: 'new-tree' } };
      case 'POST /repos/{owner}/{repo}/git/commits':
        return { data: { sha: 'new-commit' } };
      case 'PATCH /repos/{owner}/{repo}/git/refs/{ref}':
        return { data: {} };
      default:
        throw new Error(`Unexpected route: ${route}`);
    }
  });
}

const callsTo = (route: string) => requestMock.mock.calls.filter(([r]) => r === route).length;

const makeFiles = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ path: `pages/p/f${i}.txt`, content: `c${i}` }));

/** A GitHub-shaped refusal as Octokit's RequestError carries it. */
function refusal(status: number, message: string, headers: Record<string, string> = {}) {
  return Object.assign(new Error(message), { status, response: { headers } });
}

/** Throws `error` for the first `times` calls to `route`, then falls through. */
function failFirst(route: string, times: number, error: () => Error): Handler {
  let left = times;
  return r => {
    if (r === route && left > 0) {
      left -= 1;
      throw error();
    }
    return undefined;
  };
}

/**
 * Settles `promise` WITHOUT moving the fake clock, or fails. A batch that
 * slept anywhere would never settle here.
 */
async function settlesWithoutWaiting<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stuck = new Promise<never>((_, reject) => {
    timer = realSetTimeout(() => reject(new Error('batch waited on the clock')), 1_000);
  });
  try {
    return await Promise.race([promise, stuck]);
  } finally {
    realClearTimeout(timer);
  }
}

/** Settles a promise into its value or error, so a rejection is never unhandled. */
const settle = <T>(promise: Promise<T>) =>
  promise.then(
    value => ({ value, error: undefined as unknown }),
    (error: unknown) => ({ value: undefined, error })
  );

beforeEach(() => {
  requestMock.mockReset();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-09-26T12:00:00Z'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('uploadBatch — writes', () => {
  it('sends a batch larger than a minute of GitHub budget without waiting on its own clock', async () => {
    github();
    const files = makeFiles(130);

    const result = await settlesWithoutWaiting(
      ContentService.uploadBatch({ gitOrganization, repo: 'no-pacer', files })
    );

    expect(callsTo(BLOB)).toBe(130);
    expect(result.files).toEqual(files.map((f, i) => ({ path: f.path, sha: `blob-c${i}` })));
  });

  it('sends every write with the Octokit retry plugin switched off', async () => {
    github();
    await settlesWithoutWaiting(
      ContentService.uploadBatch({ gitOrganization, repo: 'no-plugin', files: makeFiles(1) })
    );
    for (const [route, params] of requestMock.mock.calls) {
      const isWrite = !String(route).startsWith('GET ');
      expect((params as Params).request, String(route)).toEqual(
        isWrite ? { retries: 0 } : undefined
      );
    }
  });

  it('starts no new blobs once the batch has failed', async () => {
    // mapWithConcurrency's guarantee: the blobs already in flight finish, but
    // nothing further is started for a batch that will not be committed.
    github((route, params) => {
      if (route !== BLOB) return undefined;
      const decoded = Buffer.from(String(params.content), 'base64').toString('utf-8');
      if (decoded === 'c3') throw Object.assign(new Error('too large'), { status: 413 });
      return undefined;
    });

    const { error } = await settlesWithoutWaiting(
      settle(ContentService.uploadBatch({ gitOrganization, repo: 'abort', files: makeFiles(70) }))
    );
    expect(error).toBeInstanceOf(RepoFileTooLargeError);
    const sent = callsTo(BLOB);
    expect(sent).toBeLessThan(10);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(callsTo(BLOB)).toBe(sent);
  });
});

describe('uploadBatch — rate-limit retry', () => {
  it('waits out Retry-After on a 403 secondary limit, then succeeds', async () => {
    github(
      failFirst(BLOB, 1, () =>
        refusal(403, 'You have exceeded a secondary rate limit', { 'retry-after': '30' })
      )
    );
    const upload = settle(
      ContentService.uploadBatch({ gitOrganization, repo: 'rl-403', files: makeFiles(1) })
    );

    await vi.advanceTimersByTimeAsync(29_999);
    expect(callsTo(BLOB)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    const { value, error } = await upload;
    expect(error).toBeUndefined();
    expect(callsTo(BLOB)).toBe(2);
    expect(value!.commit).toBe('new-commit');
  });

  it('retries a 429 after its Retry-After', async () => {
    github(failFirst(BLOB, 1, () => refusal(429, 'Too Many Requests', { 'retry-after': '5' })));
    const upload = settle(
      ContentService.uploadBatch({ gitOrganization, repo: 'rl-429', files: makeFiles(1) })
    );

    await vi.advanceTimersByTimeAsync(4_999);
    expect(callsTo(BLOB)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    expect((await upload).error).toBeUndefined();
    expect(callsTo(BLOB)).toBe(2);
  });

  it('waits until x-ratelimit-reset (plus a second) when that is all GitHub gives', async () => {
    const resetEpoch = Math.floor(Date.now() / 1000) + 10;
    github(
      failFirst(BLOB, 1, () =>
        refusal(403, 'API rate limit exceeded', {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(resetEpoch),
        })
      )
    );
    const upload = settle(
      ContentService.uploadBatch({ gitOrganization, repo: 'rl-reset', files: makeFiles(1) })
    );

    await vi.advanceTimersByTimeAsync(10_999);
    expect(callsTo(BLOB)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    expect((await upload).error).toBeUndefined();
    expect(callsTo(BLOB)).toBe(2);
  });

  it('backs off a minute when the refusal names no wait', async () => {
    github(failFirst(BLOB, 1, () => refusal(403, 'You have exceeded a secondary rate limit')));
    const upload = settle(
      ContentService.uploadBatch({ gitOrganization, repo: 'rl-backoff', files: makeFiles(1) })
    );

    await vi.advanceTimersByTimeAsync(59_999);
    expect(callsTo(BLOB)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    expect((await upload).error).toBeUndefined();
    expect(callsTo(BLOB)).toBe(2);
  });

  it('does not retry a 403 that is not a rate limit', async () => {
    github(failFirst(BLOB, 1, () => refusal(403, 'Resource not accessible by integration')));

    const { error } = await settlesWithoutWaiting(
      settle(ContentService.uploadBatch({ gitOrganization, repo: 'rl-perm', files: makeFiles(1) }))
    );

    expect(error).toMatchObject({ status: 403, message: 'Resource not accessible by integration' });
    expect(callsTo(BLOB)).toBe(1);
  });

  it('gives up after three retries and throws the refusal', async () => {
    github(failFirst(BLOB, 99, () => refusal(429, 'Too Many Requests', { 'retry-after': '1' })));
    const upload = settle(
      ContentService.uploadBatch({ gitOrganization, repo: 'rl-bounded', files: makeFiles(1) })
    );

    await vi.advanceTimersByTimeAsync(60_000);
    const { error } = await upload;

    expect(error).toMatchObject({ status: 429 });
    expect(callsTo(BLOB)).toBe(4);
  });

  it('throws at once, without sleeping, when Retry-After is longer than two minutes', async () => {
    github(
      failFirst(BLOB, 1, () =>
        refusal(403, 'You have exceeded a secondary rate limit', { 'retry-after': '600' })
      )
    );

    const { error } = await settlesWithoutWaiting(
      settle(ContentService.uploadBatch({ gitOrganization, repo: 'rl-cap', files: makeFiles(1) }))
    );

    expect(error).toMatchObject({ status: 403 });
    expect(callsTo(BLOB)).toBe(1);
  });

  it('retries the tree step on its own, without re-running the ref read', async () => {
    github(failFirst(TREE, 1, () => refusal(429, 'Too Many Requests', { 'retry-after': '2' })));
    const upload = settle(
      ContentService.uploadBatch({ gitOrganization, repo: 'rl-tree', files: makeFiles(2) })
    );

    await vi.advanceTimersByTimeAsync(2_000);

    const { value, error } = await upload;
    expect(error).toBeUndefined();
    expect(value!.commit).toBe('new-commit');
    expect(callsTo(TREE)).toBe(2);
    // A rate-limit retry is one request, not #withGitRetry's whole sequence.
    expect(callsTo(GET_REF)).toBe(1);
  });

  it('keeps retrying a 5xx the way the Octokit retry plugin did', async () => {
    github(failFirst(BLOB, 1, () => refusal(502, 'Bad Gateway')));
    const upload = settle(
      ContentService.uploadBatch({ gitOrganization, repo: 'rl-5xx', files: makeFiles(1) })
    );

    await vi.advanceTimersByTimeAsync(1_000);

    expect((await upload).error).toBeUndefined();
    expect(callsTo(BLOB)).toBe(2);
  });
});
