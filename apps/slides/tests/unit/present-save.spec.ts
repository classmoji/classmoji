/**
 * Save before presenting: the 20-s budget of the Present button, what the
 * presenter is sent to when the save did not finish in time (`?saving=1` and
 * its notice), and the live leave guard's predicate, which never treats
 * Reveal's hash-only navigation as leaving. The collab call, the row read and
 * the clock are injected.
 */
import { test, expect } from '@playwright/test';

import {
  PRESENT_LOAD_SAVE_TIMEOUT_MS,
  PRESENT_SAVE_TIMEOUT_MS,
  checkpointBeforePresenting,
  deckHasUnpushedEdits,
  type PresentCheckpointDeps,
  type PresentRow,
} from '../../app/utils/collab/collab.server.ts';
import {
  PRESENT_SAVING_NOTICE,
  leavesLiveEditor,
  presentNoticeFor,
  presentUrlAfterSave,
} from '../../app/utils/collab/collab.ts';

const actor = { userId: 'u1', name: 'Ada Lovelace' };
const liveSlide = { id: 'deck-1', classroom: { collab_enabled: true } };

const saved: Record<string, string | undefined> = {};
test.beforeAll(() => {
  for (const key of ['COLLAB_URL', 'COLLAB_INTERNAL_SECRET']) saved[key] = process.env[key];
  process.env.COLLAB_URL = 'http://collab.test';
  process.env.COLLAB_INTERNAL_SECRET = 'secret';
});
test.afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A fake clock that `sleep` advances; rows come from `rows(n)` per read. */
function fakeDeps(
  reply: Awaited<ReturnType<PresentCheckpointDeps['request']>> | Error,
  rows: (read: number, at: number) => PresentRow | null | undefined
) {
  let clock = 1_000_000;
  let reads = 0;
  const deps: PresentCheckpointDeps = {
    request: async () => {
      if (reply instanceof Error) throw reply;
      return reply;
    },
    readRow: async () => rows(reads++, clock),
    now: () => clock,
    sleep: async ms => {
      clock += ms;
    },
  };
  return { deps, elapsed: () => clock - 1_000_000, reads: () => reads };
}

const row = (version: number, pushed: number, extra: Partial<PresentRow> = {}): PresentRow => ({
  version,
  pushed_version: pushed,
  last_checkpoint_at: null,
  last_checkpoint_error: null,
  ...extra,
});

test.describe('checkpointBeforePresenting', () => {
  test('the Present button waits 20 s; a direct link 10 s', () => {
    expect(PRESENT_SAVE_TIMEOUT_MS).toBe(20_000);
    expect(PRESENT_LOAD_SAVE_TIMEOUT_MS).toBe(10_000);
  });

  test('nothing unpushed (alreadySaved): saved at once, no row read', async () => {
    const f = fakeDeps({ version: 4, alreadySaved: true }, () => {
      throw new Error('must not read');
    });
    expect(await checkpointBeforePresenting(liveSlide, actor, { deps: f.deps })).toBe('saved');
    expect(f.reads()).toBe(0);
    expect(f.elapsed()).toBe(0);
  });

  test('saved once the row reaches the flushed version', async () => {
    const f = fakeDeps({ version: 5 }, read => (read < 4 ? row(5, 4) : row(6, 5)));
    expect(await checkpointBeforePresenting(liveSlide, actor, { deps: f.deps })).toBe('saved');
    expect(f.reads()).toBe(5);
  });

  test('gives up as `timeout` at the 20-s budget, not before', async () => {
    const f = fakeDeps({ version: 5 }, () => row(5, 4));
    expect(await checkpointBeforePresenting(liveSlide, actor, { deps: f.deps })).toBe('timeout');
    expect(f.elapsed()).toBeLessThanOrEqual(PRESENT_SAVE_TIMEOUT_MS);
    expect(f.elapsed()).toBeGreaterThan(PRESENT_SAVE_TIMEOUT_MS - 2 * 750);
  });

  test('a run that failed since the request: `error` at the deadline', async () => {
    const f = fakeDeps({ version: 5 }, (_read, at) =>
      row(5, 4, { last_checkpoint_at: new Date(at), last_checkpoint_error: 'push rejected' })
    );
    expect(await checkpointBeforePresenting(liveSlide, actor, { deps: f.deps })).toBe('error');
    expect(f.elapsed()).toBeGreaterThan(PRESENT_SAVE_TIMEOUT_MS - 2 * 750);
  });

  test('collab unreachable or the row unreadable: `error`, presented at once', async () => {
    const down = fakeDeps(new Error('collab down'), () => row(1, 1));
    expect(await checkpointBeforePresenting(liveSlide, actor, { deps: down.deps })).toBe('error');
    const unreadable = fakeDeps({ version: 2 }, () => undefined);
    expect(await checkpointBeforePresenting(liveSlide, actor, { deps: unreadable.deps })).toBe(
      'error'
    );
    expect(unreadable.elapsed()).toBe(0);
  });

  test('a classroom that does not edit live: `not-live`, nothing asked', async () => {
    const f = fakeDeps(new Error('must not be called'), () => {
      throw new Error('must not read');
    });
    expect(
      await checkpointBeforePresenting(
        { id: 'deck-1', classroom: { collab_enabled: false } },
        actor,
        { deps: f.deps }
      )
    ).toBe('not-live');
  });
});

test.describe('presenting after a save that did not finish', () => {
  test('the Present button sends the presenter to the right URL', () => {
    expect(presentUrlAfterSave('d1', 'saved')).toBe('/d1/present?saved=1');
    expect(presentUrlAfterSave('d1', 'timeout')).toBe('/d1/present?saving=1');
    expect(presentUrlAfterSave('d1', 'error')).toBe('/d1/present?saving=1');
    // No answer at all (the button's give-up timer).
    expect(presentUrlAfterSave('d1', undefined)).toBe('/d1/present?saving=1');
    expect(presentUrlAfterSave('d1', 'not-live')).toBe('/d1/present');
  });

  test("the presenter's notice: only for a save that did not finish", () => {
    expect(PRESENT_SAVING_NOTICE).toBe(
      'Your latest edits are still saving. Refresh in a moment to see them.'
    );
    expect(presentNoticeFor('timeout')).toBe(PRESENT_SAVING_NOTICE);
    expect(presentNoticeFor('error')).toBe(PRESENT_SAVING_NOTICE);
    expect(presentNoticeFor('saved')).toBeNull();
    expect(presentNoticeFor('not-live')).toBeNull();
    expect(presentNoticeFor(null)).toBeNull();
  });

  test('`?saving=1` shows the notice only while the deck still holds unpushed edits', async () => {
    expect(await deckHasUnpushedEdits('d1', async () => row(7, 6))).toBe(true);
    // Refreshed after the push landed: no notice.
    expect(await deckHasUnpushedEdits('d1', async () => row(7, 7))).toBe(false);
    expect(await deckHasUnpushedEdits('d1', async () => null)).toBe(false);
    expect(await deckHasUnpushedEdits('d1', async () => undefined)).toBe(false);
  });
});

test.describe('the live leave guard', () => {
  const at = (pathname: string, search = '', hash = '') => ({ pathname, search, hash });

  test("Reveal's hash-only navigation never leaves the editor", () => {
    expect(
      leavesLiveEditor(at('/deck-1', '?mode=edit', '#/1'), at('/deck-1', '?mode=edit', '#/2'))
    ).toBe(false);
    expect(leavesLiveEditor(at('/deck-1', '', ''), at('/deck-1', '', '#/3/1'))).toBe(false);
  });

  test('a search-only change (View preview) keeps the editor', () => {
    expect(leavesLiveEditor(at('/deck-1'), at('/deck-1', '?preview=1'))).toBe(false);
  });

  test('another page leaves it', () => {
    expect(leavesLiveEditor(at('/deck-1', '', '#/2'), at('/deck-1/present'))).toBe(true);
    expect(leavesLiveEditor(at('/deck-1'), at('/'))).toBe(true);
  });
});
