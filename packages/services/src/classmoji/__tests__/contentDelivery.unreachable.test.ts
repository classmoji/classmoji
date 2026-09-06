/**
 * Two bounds on a text read that is never going to succeed.
 *
 * The shape of the problem: the slides index renders every deck as its own
 * iframe, each running the thumbnail read in its own loader. When a classroom's
 * content repo cannot be read at all — access revoked, a repo gone private, a
 * repo deleted but still referenced — each of those reads burns the full
 * `TEXT_FETCH_TIMEOUT_MS` before failing. Nineteen thumbnails at a browser's
 * ~6 concurrent connections is four waves of six seconds, and the page dribbles
 * in over roughly two minutes looking hung.
 *
 * Two things fix it, and both are pinned here:
 *
 *   - a DECORATIVE read may ask for a shorter per-leg budget, because the cost
 *     of giving up on a thumbnail is a grey rectangle;
 *   - the first read to find a classroom's origin unreachable answers for the
 *     rest of the window, because that failure is a property of the classroom
 *     and not of the nineteen files.
 *
 * And two things that must NOT happen, which is most of what is asserted: a
 * read a PERSON is waiting on never consults the window, and a plain 404 never
 * opens one. The first would keep a recovered classroom broken for five minutes
 * after it healed; the second would blank every thumbnail in a classroom whose
 * `index.html` simply has not been generated yet.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ensureContentAssets = vi.fn();
const lookupContentAsset = vi.fn();
const getContent = vi.fn();

vi.mock('@classmoji/database', () => ({ default: () => ({}) }));
vi.mock('../contentAssets.service.ts', () => ({
  ensureContentAssets: (...args: unknown[]) => ensureContentAssets(...args),
  lookupContentAsset: (...args: unknown[]) => lookupContentAsset(...args),
  lookupContentAssetBySha: vi.fn(),
  lookupContentAssets: vi.fn(),
  lookupContentTree: vi.fn(),
}));
vi.mock('../../content/ContentService.ts', () => ({
  ContentService: { getContent: (...args: unknown[]) => getContent(...args) },
}));

const { fetchContentText, clearUnreachableClassrooms } =
  await import('../contentDelivery.service.ts');

const ORIGIN = 'https://cdn.classmoji.test';
const MASTER = 'test-master-secret';
const CLASSROOM_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const OTHER_CLASSROOM_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3302';
const ORG = 'dartmouth-cs52';
const REPO = 'content-dartmouth-cs52-cs52-25s';
const DECK_SHA = 'a'.repeat(40);

const DECK_PATH = 'slides/lecture-1/index.html';

const ctx = {
  classroom: {
    id: CLASSROOM_ID,
    content_key_version: 7,
    content_repo: REPO,
    content_delivery_enabled: true,
    git_organization: { login: ORG },
  },
};

/** How a thumbnail asks: cheap, decorative, CDN-only. Mirrors `readDeckText`. */
const THUMBNAIL = {
  label: 'thumbnail',
  fallback: 'cdn-only',
  deadlineMs: 2000,
  decorative: true,
} as const;

/** A repo the app cannot read at all: every leg hangs and is cut off. */
function stubUnreachable(): ReturnType<typeof vi.fn> {
  const stub = vi.fn(async () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  });
  vi.stubGlobal('fetch', stub);
  getContent.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 403 }));
  return stub;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearUnreachableClassrooms();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  ensureContentAssets.mockResolvedValue(null);
  lookupContentAsset.mockResolvedValue({ sha: DECK_SHA, type: 'blob', size: 4096 });
  process.env.CONTENT_DELIVERY_ORIGIN = ORIGIN;
  process.env.CONTENT_SIGNING_SECRET = MASTER;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  clearUnreachableClassrooms();
  delete process.env.CONTENT_DELIVERY_ORIGIN;
  delete process.env.CONTENT_SIGNING_SECRET;
});

describe('the per-leg deadline', () => {
  it('gives every leg the budget the caller asked for', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('cdn-bytes'))
    );

    await fetchContentText(ctx, DECK_PATH, THUMBNAIL);

    // Two seconds, not the default six. Every deadline this read handed out is
    // the caller's — a leg that quietly kept the default would be the whole bug.
    expect(timeout).toHaveBeenCalled();
    for (const call of timeout.mock.calls) expect(call[0]).toBe(2000);
  });

  it('leaves an ordinary read on the default budget', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('worker-bytes'))
    );

    await fetchContentText(ctx, DECK_PATH, { label: 'present' });

    for (const call of timeout.mock.calls) expect(call[0]).toBe(6000);
  });
});

describe('remembering an unreachable classroom', () => {
  it('spends the wait once, then answers instantly for the rest of the window', async () => {
    const stub = stubUnreachable();

    expect(await fetchContentText(ctx, DECK_PATH, THUMBNAIL)).toBeNull();
    const afterFirst = stub.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    // The eighteen thumbnails behind the first one. Not a shorter wait — no
    // wait, and no socket: the classroom already answered.
    for (let i = 0; i < 18; i += 1) {
      expect(await fetchContentText(ctx, `slides/lecture-${i}/index.html`, THUMBNAIL)).toBeNull();
    }
    expect(stub.mock.calls).toHaveLength(afterFirst);
    expect(getContent).not.toHaveBeenCalled();
  });

  it('logs the write-off once per window, not once per file', async () => {
    stubUnreachable();
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    await fetchContentText(ctx, DECK_PATH, THUMBNAIL);
    await fetchContentText(ctx, 'slides/lecture-2/index.html', THUMBNAIL);
    await fetchContentText(ctx, 'slides/lecture-3/index.html', THUMBNAIL);

    const written = debug.mock.calls
      .map(call => String(call[0]))
      .filter(line => line.includes('content origin unreachable'));
    expect(written).toHaveLength(1);
    expect(written[0]).toContain(CLASSROOM_ID);
  });

  it('does not write off a classroom on behalf of another', async () => {
    const stub = stubUnreachable();
    await fetchContentText(ctx, DECK_PATH, THUMBNAIL);
    const afterFirst = stub.mock.calls.length;

    const other = { classroom: { ...ctx.classroom, id: OTHER_CLASSROOM_ID } };
    await fetchContentText(other, DECK_PATH, THUMBNAIL);

    expect(stub.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('still tries for a read someone is waiting on', async () => {
    // A person opening the deck gets the attempt whatever the window says.
    // "Unreachable four minutes ago" is not an answer to "show me my slides",
    // and this is also what lets a recovered classroom work again immediately.
    stubUnreachable();
    await fetchContentText(ctx, DECK_PATH, THUMBNAIL);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('worker-bytes'))
    );
    const read = await fetchContentText(ctx, DECK_PATH, { label: 'present' });

    expect(read).toMatchObject({ text: 'worker-bytes', source: 'worker' });
  });

  it('forgets the classroom once the window has passed', async () => {
    stubUnreachable();
    await fetchContentText(ctx, DECK_PATH, THUMBNAIL);

    // Only the clock is faked; the read below still uses real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);

    const stub = vi.fn(async () => new Response('cdn-bytes'));
    vi.stubGlobal('fetch', stub);
    const read = await fetchContentText(ctx, DECK_PATH, THUMBNAIL);

    // The window closed, so the read went back out to the network and answered.
    expect(read).toMatchObject({ text: 'cdn-bytes' });
    expect(stub).toHaveBeenCalled();
  });

  it('treats a 404 as an answer, not an outage', async () => {
    // A deck whose index.html has not been generated is a MISSING FILE. Writing
    // the classroom off for it would blank every other thumbnail in the class.
    const stub = vi.fn(async () => new Response('not found', { status: 404 }));
    vi.stubGlobal('fetch', stub);

    expect(await fetchContentText(ctx, DECK_PATH, THUMBNAIL)).toBeNull();
    const afterFirst = stub.mock.calls.length;

    expect(await fetchContentText(ctx, 'slides/lecture-2/index.html', THUMBNAIL)).toBeNull();
    expect(stub.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('does not write off a classroom whose read succeeded through a fallback', async () => {
    // The Worker was unreachable but the CDN answered, so the classroom is
    // demonstrably readable. Only a read that got NOTHING may condemn it.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).startsWith(ORIGIN)) throw new Error('socket hang up');
        return new Response('cdn-bytes');
      })
    );

    expect(await fetchContentText(ctx, DECK_PATH, THUMBNAIL)).toMatchObject({ source: 'cdn' });

    const stub = vi.fn(async () => new Response('cdn-bytes'));
    vi.stubGlobal('fetch', stub);
    expect(await fetchContentText(ctx, DECK_PATH, THUMBNAIL)).not.toBeNull();
    expect(stub).toHaveBeenCalled();
  });
});
