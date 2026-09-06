/**
 * The warm-on-save proof.
 *
 * A save mints shas the Worker has never seen, and a sha the Worker has never
 * seen is a cold origin pull — a token mint against the webapp plus a GitHub
 * blob read, measured on staging in seconds rather than milliseconds. Whoever
 * reads first pays it, and after a save that is almost always the person who
 * just hit save.
 *
 * So the save pulls its own files through the Worker on the way out. What has
 * to be true for that to be worth anything is narrow, and it is what this suite
 * asserts:
 *
 *   - the warm covers exactly the files the commit wrote, at the shas it wrote;
 *   - the URL it warms is the URL a reader will ask for, BYTE for byte — a warm
 *     that differed by a tier or a key version would fill a cache entry nobody
 *     ever asks for, and neither side could tell;
 *   - the save does not depend on any of it. A warm that fails, or that is
 *     still in flight, must not reach the caller.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@classmoji/database', () => ({
  default: () => ({ slide: { update: vi.fn() } }),
}));

const getContentMock = vi.fn();
const getMetaMock = vi.fn();
const uploadBatchMock = vi.fn();
vi.mock('../../content/ContentService.ts', () => ({
  ContentService: {
    getContent: (...args: unknown[]) => getContentMock(...args),
    getMeta: (...args: unknown[]) => getMetaMock(...args),
    uploadBatch: (...args: unknown[]) => uploadBatchMock(...args),
    put: vi.fn(),
  },
}));

/** The asset map, in memory — the save writes it and the warm reads it back. */
const rows = new Map<string, { sha: string; type: string; size: number }>();
const key = (classroomId: string, path: string) => `${classroomId}:${path}`;

vi.mock('../contentAssets.service.ts', () => ({
  ensureContentAssets: async () => null,
  recordContentAsset: async (classroomId: string, entry: { path: string; sha: string }) => {
    rows.set(key(classroomId, entry.path), { sha: entry.sha, type: 'blob', size: 0 });
    return true;
  },
  recordContentAssets: async (
    classroomId: string,
    entries: Array<{ path: string; sha: string }>
  ) => {
    for (const entry of entries) {
      rows.set(key(classroomId, entry.path), { sha: entry.sha, type: 'blob', size: 0 });
    }
    return true;
  },
  lookupContentAsset: async (classroomId: string, path: string) =>
    rows.get(key(classroomId, path)) ?? null,
  lookupContentAssets: async () => new Map(),
  lookupContentAssetBySha: async () => null,
  lookupContentTree: async () => null,
  resolveContentBranch: async () => 'main',
}));

const { fetchContentText, warmContentText } = await import('../contentDelivery.service.ts');
const { saveDeck } = await import('../../slides/slideContent.service.ts');

const ORIGIN = 'https://cdn.classmoji.test';
const MASTER = 'test-master-secret';
const CLASSROOM_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const CONTENT_PATH = 'slides/lecture-1';
const DECK_PATH = `${CONTENT_PATH}/deck.json`;
const HTML_PATH = `${CONTENT_PATH}/index.html`;

const NEW_DECK_SHA = 'e'.repeat(40);
const NEW_HTML_SHA = 'd'.repeat(40);

const slide = {
  id: 'slide-1',
  title: 'Lecture 1',
  content_path: CONTENT_PATH,
  classroom: {
    id: CLASSROOM_ID,
    content_repo: 'content-test-org-cs101',
    content_key_version: 3,
    content_delivery_enabled: true,
    git_organization: { provider: 'GITHUB', login: 'test-org' },
  },
};

const readCtx = {
  classroom: {
    id: CLASSROOM_ID,
    content_key_version: 3,
    content_repo: 'content-test-org-cs101',
    content_delivery_enabled: true,
    git_organization: { login: 'test-org' },
  },
};

const deck = {
  version: 1 as const,
  theme: 'white',
  codeTheme: 'github-dark',
  slides: [{ id: 's1', html: '<h1>Take two</h1>' }],
};

/**
 * Every URL the process fetched, in order.
 *
 * The warm is deliberately not awaited by its caller, so the only honest way to
 * observe it is the network it makes — which is also the thing that has to be
 * right.
 */
function stubFetch(handler?: (url: string) => Promise<Response>): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      return handler ? handler(url) : new Response('bytes');
    })
  );
  return calls;
}

/**
 * Wait for the fire-and-forget warm to reach the network.
 *
 * Polling rather than a fixed number of ticks: the warm awaits a map lookup and
 * a real HMAC before it fetches, and how many microtask turns that takes is an
 * implementation detail this suite must not encode.
 */
async function waitForCalls(calls: string[], n: number): Promise<void> {
  for (let i = 0; i < 500 && calls.length < n; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  rows.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  uploadBatchMock.mockImplementation(async ({ files }: { files: Array<{ path: string }> }) => ({
    commit: 'commit-1',
    filesUploaded: files.length,
    files: files.map(file => ({
      path: file.path,
      sha: file.path === DECK_PATH ? NEW_DECK_SHA : NEW_HTML_SHA,
    })),
  }));
  process.env.CONTENT_DELIVERY_ORIGIN = ORIGIN;
  process.env.CONTENT_SIGNING_SECRET = MASTER;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.CONTENT_DELIVERY_ORIGIN;
  delete process.env.CONTENT_SIGNING_SECRET;
});

describe('a deck save warms the files it wrote', () => {
  it('pulls both committed files through the Worker at the shas it recorded', async () => {
    const calls = stubFetch();

    await saveDeck({ slide, deck, message: 'Save deck' });
    await waitForCalls(calls, 2);

    expect(calls).toHaveLength(2);
    // Exactly the commit's two files, at the commit's two shas — no third
    // request, and nothing warmed at a sha the save did not produce.
    expect(calls.some(url => url.includes(`/blob/${NEW_DECK_SHA}.json`))).toBe(true);
    expect(calls.some(url => url.includes(`/blob/${NEW_HTML_SHA}.html`))).toBe(true);
  });

  it('warms the exact URL the reader will ask for', async () => {
    const calls = stubFetch();

    await saveDeck({ slide, deck, message: 'Save deck' });
    await waitForCalls(calls, 2);
    const warmed = calls.filter(url => url.includes(`/blob/${NEW_HTML_SHA}.html`));
    expect(warmed).toHaveLength(1);

    // The read the presenter makes, against the same map the save just wrote.
    const readCalls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        readCalls.push(String(input));
        return new Response('the new deck');
      })
    );
    const read = await fetchContentText(readCtx, HTML_PATH, { label: 'present' });

    expect(read).toEqual({ text: 'the new deck', sha: NEW_HTML_SHA, source: 'worker' });
    // Byte for byte. The Worker's edge entry is keyed by URL, so anything less
    // than equality here is a cache filled for a request nobody makes.
    expect(readCalls).toEqual(warmed);
  });

  it('does not reject the save when every warm fails', async () => {
    const calls = stubFetch(async () => {
      throw new Error('origin unavailable');
    });

    await expect(saveDeck({ slide, deck, message: 'Save deck' })).resolves.toMatchObject({
      sha: NEW_DECK_SHA,
    });
    await waitForCalls(calls, 2);

    // The rows still landed: a failed warm costs a cold read, never a lost save.
    expect(rows.get(key(CLASSROOM_ID, DECK_PATH))?.sha).toBe(NEW_DECK_SHA);
    expect(rows.get(key(CLASSROOM_ID, HTML_PATH))?.sha).toBe(NEW_HTML_SHA);
  });

  it('records nothing and warms nothing for a preview-branch save', async () => {
    getMetaMock.mockResolvedValue({ sha: NEW_DECK_SHA });
    const calls = stubFetch();

    await saveDeck({ slide, deck, message: 'Save preview', branch: `preview/${CONTENT_PATH}` });
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(rows.size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe('warmContentText', () => {
  it('is a no-op for a classroom that is not on the delivery layer', async () => {
    rows.set(key(CLASSROOM_ID, HTML_PATH), { sha: NEW_HTML_SHA, type: 'blob', size: 0 });
    const calls = stubFetch();

    await warmContentText(
      { classroom: { ...readCtx.classroom, content_delivery_enabled: false } },
      [HTML_PATH]
    );

    expect(calls).toHaveLength(0);
  });

  it('is a no-op when the deployment cannot sign', async () => {
    delete process.env.CONTENT_SIGNING_SECRET;
    rows.set(key(CLASSROOM_ID, HTML_PATH), { sha: NEW_HTML_SHA, type: 'blob', size: 0 });
    const calls = stubFetch();

    await warmContentText(readCtx, [HTML_PATH]);

    expect(calls).toHaveLength(0);
  });

  it('skips a path the map has no blob row for rather than guessing a sha', async () => {
    const calls = stubFetch();

    await warmContentText(readCtx, [HTML_PATH]);

    expect(calls).toHaveLength(0);
  });

  it('pulls a duplicated path once', async () => {
    rows.set(key(CLASSROOM_ID, HTML_PATH), { sha: NEW_HTML_SHA, type: 'blob', size: 0 });
    const calls = stubFetch();

    await warmContentText(readCtx, [HTML_PATH, `./${HTML_PATH}`, HTML_PATH]);

    expect(calls).toHaveLength(1);
  });

  it('never rejects, whatever the origin does', async () => {
    rows.set(key(CLASSROOM_ID, HTML_PATH), { sha: NEW_HTML_SHA, type: 'blob', size: 0 });
    stubFetch(async () => {
      throw new Error('socket hang up');
    });

    await expect(warmContentText(readCtx, [HTML_PATH])).resolves.toBeUndefined();
  });
});
