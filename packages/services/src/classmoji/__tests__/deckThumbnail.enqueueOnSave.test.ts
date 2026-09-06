/**
 * The enqueue-on-save proof.
 *
 * A deck's card is a picture taken by a headless browser some time after the
 * save that changed it. Nothing in the save path reads the result, nothing
 * waits for it, and nothing downstream may assume it happened — which makes the
 * enqueue very easy to get subtly wrong in ways no other test would notice.
 *
 * What has to be true is narrow, and it is what this suite asserts:
 *
 *   - the run is enqueued AFTER the asset rows land. The task's first act is to
 *     read `index.html`'s sha out of the map to decide whether the deck has
 *     moved at all; enqueue before the rows and it reads the PREVIOUS save's
 *     sha, concludes nothing changed, and skips;
 *   - it is never awaited, and a Trigger.dev outage cannot fail a save that has
 *     already committed. A thumbnail is cosmetic; a save is not;
 *   - N saves of one deck inside the debounce window are ONE run — the delay
 *     and the idempotency key are what bound how many WebPs land in a
 *     classroom's git history, and a WebP does not delta-compress;
 *   - a preview-branch save enqueues nothing, because there is nothing
 *     published to take a picture of.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const slideFindMany = vi.fn();
vi.mock('@classmoji/database', () => ({
  default: () => ({
    slide: { update: vi.fn(), findMany: (...a: unknown[]) => slideFindMany(...a) },
  }),
}));

const triggerMock = vi.fn();
vi.mock('@trigger.dev/sdk', () => ({
  tasks: {
    trigger: (...args: unknown[]) => triggerMock(...args),
    batchTrigger: vi.fn(),
  },
}));

const getMetaMock = vi.fn();
const uploadBatchMock = vi.fn();
vi.mock('../../content/ContentService.ts', () => ({
  ContentService: {
    getContent: vi.fn(),
    getMeta: (...args: unknown[]) => getMetaMock(...args),
    uploadBatch: (...args: unknown[]) => uploadBatchMock(...args),
    put: vi.fn(),
  },
}));

/** The asset map, in memory. The order it is written in is the point below. */
const rows = new Map<string, { sha: string; type: string; size: number }>();
const key = (classroomId: string, path: string) => `${classroomId}:${path}`;

/** Everything the save did, in the order it did it. */
const events: string[] = [];

vi.mock('../contentAssets.service.ts', () => ({
  ensureContentAssets: async () => null,
  recordContentAsset: async (classroomId: string, entry: { path: string; sha: string }) => {
    events.push(`record:${entry.path}`);
    rows.set(key(classroomId, entry.path), { sha: entry.sha, type: 'blob', size: 0 });
    return true;
  },
  recordContentAssets: async (
    classroomId: string,
    entries: Array<{ path: string; sha: string }>
  ) => {
    for (const entry of entries) {
      events.push(`record:${entry.path}`);
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

const { enqueueClassroomThumbnails, enqueueDeckThumbnail } =
  await import('../deckThumbnail.service.ts');
const { saveDeck } = await import('../../slides/slideContent.service.ts');

const CLASSROOM_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const SLIDE_ID = 'slide-1';
const CONTENT_PATH = 'slides/lecture-1';
const DECK_PATH = `${CONTENT_PATH}/deck.json`;
const HTML_PATH = `${CONTENT_PATH}/index.html`;

const NEW_DECK_SHA = 'e'.repeat(40);
const NEW_HTML_SHA = 'd'.repeat(40);

const slide = {
  id: SLIDE_ID,
  title: 'Lecture 1',
  content_path: CONTENT_PATH,
  classroom: {
    id: CLASSROOM_ID,
    content_repo: 'content-test-org-cs101',
    content_key_version: 3,
    // Deliberately OFF for most of these: a thumbnail is committed into the
    // content repo and fetched through the legacy proxy for a classroom that is
    // not on the delivery layer, so the enqueue must not be gated on it.
    content_delivery_enabled: false,
    git_organization: { provider: 'GITHUB', login: 'test-org' },
  },
};

const deck = {
  version: 1 as const,
  theme: 'white',
  codeTheme: 'github-dark',
  slides: [{ id: 's1', html: '<h1>Take two</h1>' }],
};

/**
 * Wait for the fire-and-forget enqueue to reach the (mocked) client.
 *
 * Polled rather than counted in ticks: how many microtask turns the save's tail
 * takes is an implementation detail this suite must not encode.
 */
async function waitForTriggers(n: number): Promise<void> {
  for (let i = 0; i < 500 && triggerMock.mock.calls.length < n; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  rows.clear();
  events.length = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  triggerMock.mockImplementation(async () => {
    events.push('enqueue');
    return { id: 'run_1' };
  });
  uploadBatchMock.mockImplementation(async ({ files }: { files: Array<{ path: string }> }) => ({
    commit: 'commit-1',
    filesUploaded: files.length,
    files: files.map(file => ({
      path: file.path,
      sha: file.path === DECK_PATH ? NEW_DECK_SHA : NEW_HTML_SHA,
    })),
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a deck save asks for a new thumbnail', () => {
  it('enqueues one render for the deck it just wrote', async () => {
    await saveDeck({ slide, deck, message: 'Save deck' });
    await waitForTriggers(1);

    expect(triggerMock).toHaveBeenCalledTimes(1);
    const [taskId, payload] = triggerMock.mock.calls[0];
    expect(taskId).toBe('deck-thumbnail-render');
    // The id and nothing else. A payload carrying a content path or a sha would
    // be a snapshot taken a debounce window before the render.
    expect(payload).toEqual({ slideId: SLIDE_ID });
  });

  it('enqueues AFTER the asset rows, which is what the task reads to decide', async () => {
    await saveDeck({ slide, deck, message: 'Save deck' });
    await waitForTriggers(1);

    expect(events).toEqual([`record:${DECK_PATH}`, `record:${HTML_PATH}`, 'enqueue']);
  });

  it('debounces and dedupes, so a burst of saves is one render', async () => {
    await saveDeck({ slide, deck, message: 'Save deck' });
    await waitForTriggers(1);

    const [, , options] = triggerMock.mock.calls[0] as [string, unknown, Record<string, unknown>];
    expect(options).toMatchObject({
      delay: '60s',
      idempotencyKey: `deck-thumb:${SLIDE_ID}`,
      // Longer than the delay on purpose: an equal TTL would expire exactly as
      // the first run starts, and a save a tick later would enqueue a duplicate
      // of the render already in flight.
      idempotencyKeyTTL: '90s',
      // So one classroom importing forty decks cannot hold the task's browser
      // slots against every other classroom's saves.
      concurrencyKey: CLASSROOM_ID,
    });
  });

  it('does not fail the save when the enqueue throws', async () => {
    triggerMock.mockRejectedValue(new Error('trigger.dev is down'));

    await expect(saveDeck({ slide, deck, message: 'Save deck' })).resolves.toMatchObject({
      sha: NEW_DECK_SHA,
    });

    // The commit and the rows still landed: a missed render costs a stale card
    // until the next save, never a lost save.
    expect(rows.get(key(CLASSROOM_ID, DECK_PATH))?.sha).toBe(NEW_DECK_SHA);
    expect(rows.get(key(CLASSROOM_ID, HTML_PATH))?.sha).toBe(NEW_HTML_SHA);
  });

  it('does not wait for the enqueue', async () => {
    // Never resolves. An awaited enqueue would hang the save — and this test.
    triggerMock.mockImplementation(() => new Promise(() => {}));

    await expect(saveDeck({ slide, deck, message: 'Save deck' })).resolves.toMatchObject({
      sha: NEW_DECK_SHA,
    });
  });

  it('enqueues for a classroom that is not on the delivery layer', async () => {
    // The fixture above already has the switch off. Stated as its own case
    // because gating this on `deckWarmContext` — which DOES refuse those
    // classrooms — is the obvious mistake, and it would leave exactly the
    // gate-off classrooms with no cards at all.
    await saveDeck({ slide, deck, message: 'Save deck' });
    await waitForTriggers(1);

    expect(triggerMock).toHaveBeenCalledTimes(1);
  });

  it('enqueues nothing for a preview-branch save', async () => {
    getMetaMock.mockResolvedValue({ sha: NEW_DECK_SHA });

    await saveDeck({ slide, deck, message: 'Save preview', branch: `preview/${CONTENT_PATH}` });
    await new Promise(resolve => setTimeout(resolve, 20));

    // Nothing is published, so there is nothing to photograph — and the rows
    // the task would read were never written either.
    expect(rows.size).toBe(0);
    expect(triggerMock).not.toHaveBeenCalled();
  });
});

describe('enqueueDeckThumbnail', () => {
  it('never rejects, whatever the trigger client does', async () => {
    triggerMock.mockRejectedValue(new Error('socket hang up'));
    await expect(enqueueDeckThumbnail(SLIDE_ID, CLASSROOM_ID)).resolves.toBeUndefined();
  });

  it('does nothing without a slide id', async () => {
    await enqueueDeckThumbnail(null, CLASSROOM_ID);
    await enqueueDeckThumbnail(undefined);
    expect(triggerMock).not.toHaveBeenCalled();
  });

  it('omits the concurrency key rather than sending an empty one', async () => {
    // A missing classroom costs fair queueing, not correctness, and is not a
    // reason to skip the render — but an empty string would be its own queue
    // shared by every deck that lost its classroom.
    await enqueueDeckThumbnail(SLIDE_ID, null);

    const [, , options] = triggerMock.mock.calls[0] as [string, unknown, Record<string, unknown>];
    expect(options).not.toHaveProperty('concurrencyKey');
  });

  it('sends `force` only when it is asked for', async () => {
    await enqueueDeckThumbnail(SLIDE_ID, CLASSROOM_ID);
    expect(triggerMock.mock.calls[0][1]).toEqual({ slideId: SLIDE_ID });

    await enqueueDeckThumbnail(SLIDE_ID, CLASSROOM_ID, { force: true });
    expect(triggerMock.mock.calls[1][1]).toEqual({ slideId: SLIDE_ID, force: true });
  });
});

/**
 * A THEME edit is the one case the render task's idempotence check gets wrong.
 *
 * It asks "has this deck's `index.html` moved?" — and a theme edit moves no byte
 * inside any deck while changing how all of them look. Left alone, every deck in
 * the classroom would answer "unchanged" and keep a card of the old theme until
 * somebody happened to edit it.
 */
describe('enqueueClassroomThumbnails', () => {
  const DECK_IDS = ['deck-a', 'deck-b', 'deck-c'];

  beforeEach(() => {
    slideFindMany.mockResolvedValue(DECK_IDS.map(id => ({ id })));
  });

  it('asks for every deck in the classroom, with force', async () => {
    await enqueueClassroomThumbnails(CLASSROOM_ID, { themeName: 'dartmouth', force: true });

    expect(triggerMock).toHaveBeenCalledTimes(3);
    for (const [index, id] of DECK_IDS.entries()) {
      expect(triggerMock.mock.calls[index][1]).toEqual({ slideId: id, force: true });
    }
    expect(slideFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { classroom_id: CLASSROOM_ID } })
    );
  });

  it('reuses the per-deck idempotency key, so a save and a theme edit collapse', async () => {
    await enqueueClassroomThumbnails(CLASSROOM_ID, { force: true });

    const [, , options] = triggerMock.mock.calls[0] as [string, unknown, Record<string, unknown>];
    expect(options).toMatchObject({
      idempotencyKey: 'deck-thumb:deck-a',
      idempotencyKeyTTL: '90s',
      concurrencyKey: CLASSROOM_ID,
    });
  });

  it('never rejects — a theme save is finished before this runs', async () => {
    slideFindMany.mockRejectedValue(new Error('database is having a moment'));
    await expect(
      enqueueClassroomThumbnails(CLASSROOM_ID, { force: true })
    ).resolves.toBeUndefined();

    triggerMock.mockRejectedValue(new Error('trigger.dev is down'));
    slideFindMany.mockResolvedValue([{ id: 'deck-a' }]);
    await expect(
      enqueueClassroomThumbnails(CLASSROOM_ID, { force: true })
    ).resolves.toBeUndefined();
  });

  it('does nothing at all without a classroom', async () => {
    await enqueueClassroomThumbnails(null, { force: true });
    await enqueueClassroomThumbnails(undefined);
    expect(slideFindMany).not.toHaveBeenCalled();
    expect(triggerMock).not.toHaveBeenCalled();
  });
});
