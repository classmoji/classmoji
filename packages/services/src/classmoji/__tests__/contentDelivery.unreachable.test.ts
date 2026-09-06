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
 * ## Why the cases below are shaped the way they are
 *
 * Making every leg throw would prove nothing about production. In the three
 * headline cases — repo private, repo deleted, Pages never published — the CDN
 * leg answers a perfectly ordinary **404**, while the Worker answers **502**
 * because its own origin pull failed. So the arming rule reads the WORKER leg
 * and ignores the CDN entirely; a rule that waited for both legs to fail armed
 * for none of the cases it was written for.
 *
 * And two things that must NOT arm it, which is most of what is asserted below:
 * a Worker 404, which is a missing file in a readable repo, and OUR OWN
 * deadline expiring, which says only that a cold pull outran a budget we chose.
 * Either one, taken as an outage, blanks every thumbnail in the classroom for
 * five minutes.
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

const { fetchContentText, clearUnreachableClassrooms } = await import(
  '../contentDelivery.service.ts'
);

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

const ok = (body = 'bytes') => new Response(body);
const notFound = () => new Response('not found', { status: 404 });
const badGateway = () => new Response('origin unavailable', { status: 502 });
const refusedSocket = (): never => {
  throw new Error('socket hang up');
};

/** What `AbortSignal.timeout` really rejects with when our own deadline expires. */
const aborted = (): never => {
  throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
};

/**
 * The two legs a thumbnail read makes, answered independently.
 *
 * Split by URL because the whole question here is which LEG failed and how: the
 * Worker is the signed origin, the CDN is `{org}.github.io`. A stub that
 * answered both the same way is exactly the test that would have missed the
 * bug — the CDN's ordinary 404 was drowning out the Worker's 502.
 */
function stubLegs(legs: {
  worker: () => Response | Promise<Response>;
  cdn?: () => Response | Promise<Response>;
}): ReturnType<typeof vi.fn> {
  const stub = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith(ORIGIN)) return legs.worker();
    if (url.includes('github.io')) return (legs.cdn ?? notFound)();
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', stub);
  return stub;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearUnreachableClassrooms();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  ensureContentAssets.mockResolvedValue(null);
  lookupContentAsset.mockResolvedValue({ sha: DECK_SHA, type: 'blob', size: 4096 });
  getContent.mockResolvedValue(null);
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
    stubLegs({ worker: () => ok('cdn-bytes') });

    await fetchContentText(ctx, DECK_PATH, THUMBNAIL);

    // Two seconds, not the default six. Every deadline this read handed out is
    // the caller's — a leg that quietly kept the default would be the whole bug.
    expect(timeout).toHaveBeenCalled();
    for (const call of timeout.mock.calls) expect(call[0]).toBe(2000);
  });

  it('leaves an ordinary read on the default budget', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    stubLegs({ worker: () => ok('worker-bytes') });

    await fetchContentText(ctx, DECK_PATH, { label: 'present' });

    for (const call of timeout.mock.calls) expect(call[0]).toBe(6000);
  });
});

describe('remembering an unreachable classroom', () => {
  it('arms on a Worker 502 even though the CDN answered 404', async () => {
    // THE realistic shape, and the one the old rule missed. A private, deleted
    // or never-published repo serves an ordinary 404 from `{org}.github.io`,
    // which the old rule read as "a file is missing" — so it armed for none of
    // the three cases the window exists for.
    const stub = stubLegs({ worker: badGateway, cdn: notFound });

    expect(await fetchContentText(ctx, DECK_PATH, THUMBNAIL)).toBeNull();
    expect(stub.mock.calls.length).toBeGreaterThan(0);

    // The eighteen thumbnails behind the first one. Not a shorter wait — no
    // wait and no socket at all, and not even a map lookup: the classroom has
    // already answered.
    stub.mockClear();
    lookupContentAsset.mockClear();
    for (let i = 0; i < 18; i += 1) {
      expect(await fetchContentText(ctx, `slides/lecture-${i}/index.html`, THUMBNAIL)).toBeNull();
    }
    expect(stub).not.toHaveBeenCalled();
    expect(lookupContentAsset).not.toHaveBeenCalled();
  });

  it('arms on a Worker 403, which is the repo refusing to be read', async () => {
    const stub = stubLegs({ worker: () => new Response('forbidden', { status: 403 }) });

    await fetchContentText(ctx, DECK_PATH, THUMBNAIL);
    stub.mockClear();

    await fetchContentText(ctx, 'slides/lecture-2/index.html', THUMBNAIL);
    expect(stub).not.toHaveBeenCalled();
  });

  it('arms when the Worker connection is refused outright', async () => {
    const stub = stubLegs({ worker: refusedSocket, cdn: notFound });

    await fetchContentText(ctx, DECK_PATH, THUMBNAIL);
    stub.mockClear();

    await fetchContentText(ctx, 'slides/lecture-2/index.html', THUMBNAIL);
    expect(stub).not.toHaveBeenCalled();
  });

  it('does not arm when the Worker itself answered 404', async () => {
    // A deck whose index.html has not been generated is a MISSING FILE in a
    // perfectly readable repo. Writing the classroom off for it would blank
    // every other thumbnail in the class.
    const stub = stubLegs({ worker: notFound, cdn: notFound });

    expect(await fetchContentText(ctx, DECK_PATH, THUMBNAIL)).toBeNull();
    stub.mockClear();

    expect(await fetchContentText(ctx, 'slides/lecture-2/index.html', THUMBNAIL)).toBeNull();
    expect(stub).toHaveBeenCalled();
  });

  it('does not arm when it was our own deadline that expired', async () => {
    // An abort says a pull outran a budget WE chose, not that anything upstream
    // is broken — a cold origin pull legitimately takes longer than two
    // seconds. Five minutes of blanked thumbnails is far too much to conclude
    // from our own impatience.
    const stub = stubLegs({ worker: aborted, cdn: refusedSocket });

    expect(await fetchContentText(ctx, DECK_PATH, THUMBNAIL)).toBeNull();
    stub.mockClear();

    expect(await fetchContentText(ctx, 'slides/lecture-2/index.html', THUMBNAIL)).toBeNull();
    expect(stub).toHaveBeenCalled();
  });

  it('does not arm when the read succeeded through a fallback', async () => {
    // The Worker was unreachable but the CDN answered, so the classroom is
    // demonstrably readable. Only a read that got NOTHING may condemn it.
    const stub = stubLegs({ worker: refusedSocket, cdn: () => ok('cdn-bytes') });

    expect(await fetchContentText(ctx, DECK_PATH, THUMBNAIL)).toMatchObject({ source: 'cdn' });
    stub.mockClear();

    expect(await fetchContentText(ctx, DECK_PATH, THUMBNAIL)).not.toBeNull();
    expect(stub).toHaveBeenCalled();
  });

  it('logs the write-off once per window, not once per file', async () => {
    stubLegs({ worker: badGateway, cdn: notFound });
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
    const stub = stubLegs({ worker: badGateway, cdn: notFound });
    await fetchContentText(ctx, DECK_PATH, THUMBNAIL);
    stub.mockClear();

    const other = { classroom: { ...ctx.classroom, id: OTHER_CLASSROOM_ID } };
    await fetchContentText(other, DECK_PATH, THUMBNAIL);

    expect(stub).toHaveBeenCalled();
  });

  it('still tries for a read someone is waiting on', async () => {
    // A person opening the deck gets the attempt whatever the window says.
    // "Unreachable four minutes ago" is not an answer to "show me my slides",
    // and this is also what lets a recovered classroom work again immediately.
    stubLegs({ worker: badGateway, cdn: notFound });
    await fetchContentText(ctx, DECK_PATH, THUMBNAIL);

    stubLegs({ worker: () => ok('worker-bytes') });
    const read = await fetchContentText(ctx, DECK_PATH, { label: 'present' });

    expect(read).toMatchObject({ text: 'worker-bytes', source: 'worker' });
  });

  it('forgets the classroom once the window has passed', async () => {
    stubLegs({ worker: badGateway, cdn: notFound });
    await fetchContentText(ctx, DECK_PATH, THUMBNAIL);

    // Only the clock is faked; the read below still uses real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);

    const stub = stubLegs({ worker: () => ok('worker-bytes') });
    const read = await fetchContentText(ctx, DECK_PATH, THUMBNAIL);

    // The window closed, so the read went back out to the network and answered.
    expect(read).toMatchObject({ text: 'worker-bytes' });
    expect(stub).toHaveBeenCalled();
  });
});
