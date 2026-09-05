/**
 * The staleness proof: a save, then a read, with a real map between them.
 *
 * Every other suite mocks one side of this. This one runs both against an
 * in-memory asset map, because the bug being closed lived precisely in the
 * seam: `saveDeck` committed new bytes, the map still held the previous sha,
 * and `/present` faithfully served what the map pointed at.
 *
 * So the assertion is end to end and deliberately literal — save, look at the
 * row, read, and check the URL the read signed names the sha the save returned.
 * If the write-through is ever dropped, or the read stops consulting the map,
 * one of these fails rather than a deck quietly going stale on staging.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const slideUpdateMock = vi.fn();
vi.mock('@classmoji/database', () => ({
  default: () => ({ slide: { update: (...args: unknown[]) => slideUpdateMock(...args) } }),
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

/**
 * The asset map, in memory.
 *
 * Not a spy: the point of this suite is that what the save WRITES is what the
 * read LOOKS UP, and a pair of independent mocks could agree on nothing and
 * still both be "called correctly".
 */
const rows = new Map<string, { sha: string; type: string; size: number }>();
const key = (classroomId: string, path: string) => `${classroomId}:${path}`;

vi.mock('../contentAssets.service.ts', () => ({
  ensureContentAssets: async () => null,
  recordContentAsset: async (
    classroomId: string,
    entry: { path: string; sha: string; size?: number }
  ) => {
    rows.set(key(classroomId, entry.path), {
      sha: entry.sha,
      type: 'blob',
      size: entry.size ?? 0,
    });
    return true;
  },
  recordContentAssets: async (
    classroomId: string,
    entries: Array<{ path: string; sha: string; size?: number }>
  ) => {
    for (const entry of entries) {
      rows.set(key(classroomId, entry.path), {
        sha: entry.sha,
        type: 'blob',
        size: entry.size ?? 0,
      });
    }
    return true;
  },
  lookupContentAsset: async (classroomId: string, path: string) =>
    rows.get(key(classroomId, path)) ?? null,
  lookupContentAssets: async (classroomId: string, paths: string[]) =>
    new Map(
      paths
        .map(path => [path, rows.get(key(classroomId, path))] as const)
        .filter((entry): entry is readonly [string, { sha: string; type: string; size: number }] =>
          Boolean(entry[1])
        )
    ),
  lookupContentAssetBySha: async () => null,
  lookupContentTree: async () => null,
  resolveContentBranch: async () => 'main',
}));

const { fetchContentText } = await import('../contentDelivery.service.ts');
const { saveDeck } = await import('../../slides/slideContent.service.ts');

const ORIGIN = 'https://cdn.classmoji.test';
const MASTER = 'test-master-secret';
const CLASSROOM_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const CONTENT_PATH = 'slides/lecture-1';
const DECK_PATH = `${CONTENT_PATH}/deck.json`;
const HTML_PATH = `${CONTENT_PATH}/index.html`;

/** Real 40-hex shas — the signer refuses anything else. */
const OLD_HTML_SHA = 'a'.repeat(40);
const NEW_HTML_SHA = 'd'.repeat(40);
const NEW_DECK_SHA = 'e'.repeat(40);

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

/** What the Worker would answer, keyed by the sha in the URL it is asked for. */
function stubWorker(bodyBySha: Record<string, string>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const sha = new URL(url).pathname.split('/').pop()?.split('.')[0] ?? '';
      const body = bodyBySha[sha];
      if (body === undefined) return new Response('not found', { status: 404 });
      return new Response(body);
    })
  );
  return calls;
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

describe('a deck save is visible to the next read', () => {
  it('moves the map to the shas the commit returned, and the read follows', async () => {
    // The map starts on the PREVIOUS deck — the state that produced the bug.
    rows.set(key(CLASSROOM_ID, HTML_PATH), { sha: OLD_HTML_SHA, type: 'blob', size: 100 });
    const calls = stubWorker({ [OLD_HTML_SHA]: 'the old deck', [NEW_HTML_SHA]: 'the new deck' });

    const saved = await saveDeck({ slide, deck, message: 'Save deck' });

    // Both files the commit carried, at the shas it reported.
    expect(rows.get(key(CLASSROOM_ID, HTML_PATH))?.sha).toBe(NEW_HTML_SHA);
    expect(rows.get(key(CLASSROOM_ID, DECK_PATH))?.sha).toBe(NEW_DECK_SHA);
    expect(saved.sha).toBe(NEW_DECK_SHA);

    // …and the read that /present makes now signs the new one. No cache to wait
    // out, no Pages build to wait for — the address moved, so the answer did.
    const read = await fetchContentText(readCtx, HTML_PATH, { label: 'present' });

    expect(read).toEqual({ text: 'the new deck', sha: NEW_HTML_SHA, source: 'worker' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`/blob/${NEW_HTML_SHA}.html`);
    // Nothing fell through to GitHub: a save costs one API round trip, a view
    // costs none.
    expect(getContentMock).not.toHaveBeenCalled();
  });

  it('records nothing for a preview-branch save', async () => {
    // Preview branches carry deck.json only and are not in the map. A row here
    // would publish an unaccepted draft to every reader of the live deck.
    getMetaMock.mockResolvedValue({ sha: NEW_DECK_SHA });

    await saveDeck({
      slide,
      deck,
      message: 'Save preview',
      branch: `preview/${CONTENT_PATH}`,
    });

    expect(rows.size).toBe(0);
  });
});
