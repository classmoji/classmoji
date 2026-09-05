/**
 * Reading a repo's TEXT through the delivery layer.
 *
 * The bug this was built for: an instructor saved a deck on staging, opened
 * `/present`, and saw the previous version of their own slides. Images went
 * through the Worker by blob sha; deck HTML did not — it was read CDN-first
 * from `{org}.github.io`, which lags a push by minutes.
 *
 * So what these guard is freshness by ADDRESS. The map holds the sha the last
 * save produced, a signed URL names that sha, and a sha-addressed URL cannot
 * return anything else. The rest is the fallback ladder and its order, which is
 * inverted from what it replaces (API before CDN) precisely because the case
 * that reaches it — a map briefly behind a save — is the case where the CDN is
 * stalest.
 *
 * Prisma, the asset map and ContentService are mocked; `fetch` is stubbed. The
 * signature is real, minted by @classmoji/content-signing and verified here
 * with the same package the Worker uses.
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

const { fetchContentText, textReadBudget } = await import('../contentDelivery.service.ts');
const { verifyContentUrl } = await import('@classmoji/content-signing');

const ORIGIN = 'https://cdn.classmoji.test';
const MASTER = 'test-master-secret';
const CLASSROOM_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const ORG = 'dartmouth-cs52';
const REPO = 'content-dartmouth-cs52-cs52-25s';
const DECK_SHA = 'a'.repeat(40);

const DECK_PATH = 'slides/lecture-1/index.html';
const CDN_URL = `https://${ORG}.github.io/${REPO}/${DECK_PATH}`;

const ctx = {
  classroom: {
    id: CLASSROOM_ID,
    content_key_version: 7,
    content_repo: REPO,
    content_delivery_enabled: true,
    git_organization: { login: ORG },
  },
};

const offCtx = { classroom: { ...ctx.classroom, content_delivery_enabled: false } };

/** Every fetch this module can make, routed by URL. Anything else is a failure. */
function stubFetch(handlers: { worker?: () => Response; cdn?: () => Response }) {
  const calls: string[] = [];
  const stub = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith(ORIGIN)) {
      return handlers.worker?.() ?? new Response('worker-bytes');
    }
    if (url === CDN_URL) {
      return handlers.cdn?.() ?? new Response('cdn-bytes');
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', stub);
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  ensureContentAssets.mockResolvedValue(null);
  lookupContentAsset.mockResolvedValue({ sha: DECK_SHA, type: 'blob', size: 4096 });
  getContent.mockResolvedValue({ content: 'api-bytes', sha: 'b'.repeat(40) });
  process.env.CONTENT_DELIVERY_ORIGIN = ORIGIN;
  process.env.CONTENT_SIGNING_SECRET = MASTER;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.CONTENT_DELIVERY_ORIGIN;
  delete process.env.CONTENT_SIGNING_SECRET;
});

describe('fetchContentText through the Worker', () => {
  it('signs the sha the map holds and returns the bytes behind it', async () => {
    const calls = stubFetch({ worker: () => new Response('<!doctype html>deck') });

    const result = await fetchContentText(ctx, DECK_PATH, { label: 'present' });

    expect(result).toEqual({ text: '<!doctype html>deck', sha: DECK_SHA, source: 'worker' });
    expect(calls).toHaveLength(1);

    // The URL is a real signature, checked by the code the Worker runs.
    const verified = await verifyContentUrl([MASTER], calls[0]);
    expect(verified).toMatchObject({
      ok: true,
      kind: 'blob',
      classroomId: CLASSROOM_ID,
      sha: DECK_SHA,
      ext: 'html',
      keyVersion: 7,
    });

    // Neither fallback was consulted.
    expect(getContent).not.toHaveBeenCalled();
  });

  it('always mints the enrolled tier, whoever is reading', async () => {
    // This is a server-to-server fetch: the bytes go to a loader that has
    // already authorized its viewer, and the URL is never handed to a browser.
    // The tier here picks an expiry bucket and a Cache-Control, nothing else.
    const calls = stubFetch({});
    await fetchContentText(ctx, DECK_PATH);

    expect(new URL(calls[0]).searchParams.get('p')).toBe('enrolled');
  });

  it('follows the sha, so a save is visible the moment its row lands', async () => {
    const NEW_SHA = 'c'.repeat(40);
    stubFetch({ worker: () => new Response('the new deck') });
    lookupContentAsset.mockResolvedValue({ sha: NEW_SHA, type: 'blob', size: 5000 });

    const result = await fetchContentText(ctx, DECK_PATH);

    // No cache to wait out and no rebuild to wait for: the address changed, so
    // the answer changed. This is the whole reason text moved off the CDN.
    expect(result?.sha).toBe(NEW_SHA);
    expect(result?.source).toBe('worker');
  });

  it('refreshes a stale asset map before looking a path up', async () => {
    stubFetch({});
    await fetchContentText(ctx, DECK_PATH);
    expect(ensureContentAssets).toHaveBeenCalledWith(CLASSROOM_ID, expect.anything());
  });
});

describe('fetchContentText fallbacks', () => {
  it('reads the API, then the CDN, when the classroom gate is off', async () => {
    const calls = stubFetch({});

    const result = await fetchContentText(offCtx, DECK_PATH);

    expect(result).toEqual({ text: 'api-bytes', sha: 'b'.repeat(40), source: 'api' });
    // The map was never touched — the gate is checked before anything else.
    expect(lookupContentAsset).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('falls back when the deployment cannot sign', async () => {
    delete process.env.CONTENT_SIGNING_SECRET;
    stubFetch({});

    const result = await fetchContentText(ctx, DECK_PATH);

    expect(result?.source).toBe('api');
  });

  it('falls back when the map has no row for the path', async () => {
    lookupContentAsset.mockResolvedValue(null);
    stubFetch({});

    const result = await fetchContentText(ctx, DECK_PATH);

    expect(result?.source).toBe('api');
  });

  it('refuses to sign a TREE row as a blob', async () => {
    // A directory is not a file. Signing its tree sha as a blob would mint a
    // confidently-wrong URL the Worker cannot serve.
    lookupContentAsset.mockResolvedValue({ sha: DECK_SHA, type: 'tree', size: 0 });
    stubFetch({});

    const result = await fetchContentText(ctx, 'slides/lecture-1');

    expect(result?.source).toBe('api');
  });

  it('prefers the API over the CDN — the inverted order', async () => {
    // The old read was CDN-first, which is exactly what showed an instructor
    // their previous slides. The case that reaches this ladder is a map briefly
    // behind a save, and that is when the CDN is stalest, so the authenticated
    // read that always sees the current commit goes first.
    const calls = stubFetch({});

    const result = await fetchContentText(offCtx, DECK_PATH);

    expect(result?.source).toBe('api');
    expect(calls).not.toContain(CDN_URL);
  });

  it('reaches the CDN only when the API has nothing', async () => {
    getContent.mockResolvedValue(null);
    const calls = stubFetch({});

    const result = await fetchContentText(offCtx, DECK_PATH);

    expect(result).toEqual({ text: 'cdn-bytes', sha: null, source: 'cdn' });
    expect(calls).toEqual([CDN_URL]);
  });

  it('falls back rather than failing when the Worker refuses', async () => {
    const calls = stubFetch({ worker: () => new Response('nope', { status: 403 }) });

    const result = await fetchContentText(ctx, DECK_PATH);

    expect(result?.source).toBe('api');
    expect(calls).toHaveLength(1);
  });

  it('falls back rather than failing when the Worker cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).startsWith(ORIGIN)) throw new Error('ECONNRESET');
        return new Response('cdn-bytes');
      })
    );

    const result = await fetchContentText(ctx, DECK_PATH);

    expect(result?.source).toBe('api');
  });

  it('never throws, whatever the map does', async () => {
    // It sits on the render path of every deck and page. A database hiccup must
    // cost a tier, not a 500.
    lookupContentAsset.mockRejectedValue(new Error('connection terminated'));
    stubFetch({});

    await expect(fetchContentText(ctx, DECK_PATH)).resolves.toMatchObject({ source: 'api' });
  });

  it('returns null when nothing can answer', async () => {
    getContent.mockResolvedValue(null);
    stubFetch({
      worker: () => new Response('', { status: 502 }),
      cdn: () => new Response('', { status: 404 }),
    });

    await expect(fetchContentText(ctx, DECK_PATH)).resolves.toBeNull();
  });
});

describe("fetchContentText fallback: 'none'", () => {
  it('answers from the map and nothing else', async () => {
    const calls = stubFetch({ worker: () => new Response('worker-bytes') });

    const result = await fetchContentText(ctx, DECK_PATH, { fallback: 'none' });

    expect(result?.source).toBe('worker');
    expect(calls).toHaveLength(1);
    expect(getContent).not.toHaveBeenCalled();
  });

  it('returns null rather than falling back, so the caller can tell why', async () => {
    // The class site needs "no content.json" and "GitHub is down" to be
    // different answers — one is an empty page, the other a 503 — and the
    // ordinary fallback collapses both into null. So the map gets out of the
    // way and the caller runs its own typed read.
    lookupContentAsset.mockResolvedValue(null);
    const calls = stubFetch({});

    const result = await fetchContentText(ctx, DECK_PATH, { fallback: 'none' });

    expect(result).toBeNull();
    expect(getContent).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

describe("fetchContentText fallback: 'cdn-only'", () => {
  it('skips the API leg entirely on a map miss', async () => {
    // The thumbnail rule. A staff landing page renders ~20 decks at once, and
    // twenty authenticated reads against the org installation's shared limit in
    // one page load is the amplification the CDN pinning existed to prevent.
    // Three minutes stale is invisible on a thumbnail; a rate limit is not.
    lookupContentAsset.mockResolvedValue(null);
    const calls = stubFetch({});

    const result = await fetchContentText(ctx, DECK_PATH, { fallback: 'cdn-only' });

    expect(result).toEqual({ text: 'cdn-bytes', sha: null, source: 'cdn' });
    expect(getContent).not.toHaveBeenCalled();
    expect(calls).toEqual([CDN_URL]);
  });

  it('still prefers the map when it has the row', async () => {
    const calls = stubFetch({ worker: () => new Response('the current deck') });

    const result = await fetchContentText(ctx, DECK_PATH, { fallback: 'cdn-only' });

    expect(result?.source).toBe('worker');
    expect(calls).not.toContain(CDN_URL);
  });
});

describe('fetchContentText transport circuit', () => {
  it('stops probing the Worker for this render once it is unreachable', async () => {
    // A page probes content.json then index.html. A dead origin is about the
    // ORIGIN, not the file, so paying the timeout twice only turns one stalled
    // render into two.
    const attempts: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith(ORIGIN)) {
          attempts.push(url);
          throw new Error('ETIMEDOUT');
        }
        return new Response('cdn-bytes');
      })
    );

    const budget = textReadBudget();
    await fetchContentText(ctx, DECK_PATH, { budget });
    await fetchContentText(ctx, 'slides/lecture-1/deck.json', { budget });

    expect(attempts).toHaveLength(1);
    expect(budget.workerUnavailable).toBe(true);
  });

  it('does NOT trip on a plain map miss', async () => {
    // This path having no row says nothing about the next path.
    lookupContentAsset.mockResolvedValue(null);
    stubFetch({});

    const budget = textReadBudget();
    await fetchContentText(ctx, DECK_PATH, { budget });

    expect(budget.workerUnavailable).toBe(false);
  });

  it('does NOT trip on a Worker refusal — that is an answer, not a dead origin', async () => {
    stubFetch({ worker: () => new Response('nope', { status: 403 }) });

    const budget = textReadBudget();
    await fetchContentText(ctx, DECK_PATH, { budget });

    expect(budget.workerUnavailable).toBe(false);
  });
});

describe('fetchContentText path handling', () => {
  it('collapses a relative path to the form the map is keyed by', async () => {
    stubFetch({});
    await fetchContentText(ctx, './slides//lecture-1/index.html');
    expect(lookupContentAsset).toHaveBeenCalledWith(CLASSROOM_ID, DECK_PATH);
  });

  it('refuses a path that escapes the repo', async () => {
    stubFetch({});
    await expect(fetchContentText(ctx, '../secrets/.env')).resolves.toBeNull();
    expect(lookupContentAsset).not.toHaveBeenCalled();
    expect(getContent).not.toHaveBeenCalled();
  });

  it('reports the source it used, for the staging log', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    stubFetch({});

    await fetchContentText(ctx, DECK_PATH, { label: 'present' });

    expect(debug).toHaveBeenCalledWith(expect.stringContaining('source=worker'));
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('present'));
  });
});
