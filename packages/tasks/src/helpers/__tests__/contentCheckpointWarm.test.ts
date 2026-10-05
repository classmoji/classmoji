/**
 * content-checkpoint warm-ups (`payload.warm`): the renderers are loaded and
 * exercised, and nothing else is touched — no Prisma, no git, no rows, no
 * collab callback. The task body branches before the real deps exist.
 */
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { FRAGMENT, SCHEMA_VERSION } from '@classmoji/page-schema'; // eslint-disable-line import/no-unresolved
// eslint-disable-next-line import/no-unresolved
import { yDocToPageContent } from '@classmoji/page-schema/server';
import { DECK_SCHEMA_VERSION, yDocToDeck } from '@classmoji/collab'; // eslint-disable-line import/no-unresolved

import {
  warmCheckpointWorker,
  type CheckpointDeps,
  type DeckLike,
  type DeckRenderer,
  type PageRenderer,
} from '../contentCheckpointCore.ts';
import { contentCheckpointRun } from '../../workflows/contentCheckpoint.ts';

const quietLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** A Prisma that fails the test on ANY access. */
function untouchablePrisma(): CheckpointDeps['prisma'] {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`warm-up touched prisma.${String(prop)}`);
      },
    }
  ) as CheckpointDeps['prisma'];
}

function pageRendererSpy() {
  const render = vi.fn((doc: Y.Doc) => {
    const content = yDocToPageContent(doc);
    return { blocks: content.blocks, coverImage: content.coverImage ?? null };
  });
  const renderer: PageRenderer = { fragment: FRAGMENT, schemaVersion: SCHEMA_VERSION, render };
  return { render, load: vi.fn(async () => renderer) };
}

function deckRendererSpy() {
  const render = vi.fn((doc: Y.Doc) => yDocToDeck(doc) as unknown as DeckLike);
  const renderer: DeckRenderer = { schemaVersion: DECK_SCHEMA_VERSION, render };
  return { render, load: vi.fn(async () => renderer) };
}

describe('warmCheckpointWorker', () => {
  it('loads both renderers and renders an empty doc through each (real renderers)', async () => {
    const page = pageRendererSpy();
    const deck = deckRendererSpy();
    const report = await warmCheckpointWorker(
      { classroomId: 'class-1' },
      { loadPageRenderer: page.load, loadDeckRenderer: deck.load, log: quietLog() }
    );
    expect(page.load).toHaveBeenCalledTimes(1);
    expect(deck.load).toHaveBeenCalledTimes(1);
    expect(page.render).toHaveBeenCalledTimes(1);
    expect(page.render.mock.calls[0][0]).toBeInstanceOf(Y.Doc);
    expect(deck.render).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({
      warm: true,
      classroomId: 'class-1',
      pageRenderer: true,
      deckRenderer: true,
    });
    expect(report.ms).toBeGreaterThanOrEqual(0);
  });

  it('never throws: a renderer that fails to load is reported, the other still warms', async () => {
    const log = quietLog();
    const deck = deckRendererSpy();
    const report = await warmCheckpointWorker(
      { classroomId: 'class-1' },
      {
        loadPageRenderer: async () => {
          throw new Error('jsdom exploded');
        },
        loadDeckRenderer: deck.load,
        log,
      }
    );
    expect(report).toMatchObject({ pageRenderer: false, deckRenderer: true });
    expect(log.warn).toHaveBeenCalledWith(
      'content-checkpoint: warm-up could not load the page renderer',
      { error: 'jsdom exploded' }
    );
  });

  it('a deck converter that cannot convert an empty deck still counts as loaded', async () => {
    const renderer: DeckRenderer = {
      schemaVersion: 1,
      render: () => {
        throw new Error('no slides');
      },
    };
    const report = await warmCheckpointWorker(
      { classroomId: 'class-1' },
      {
        loadPageRenderer: pageRendererSpy().load,
        loadDeckRenderer: async () => renderer,
        log: quietLog(),
      }
    );
    expect(report).toMatchObject({ pageRenderer: true, deckRenderer: true });
  });

  it('a missing deck converter is reported, not thrown', async () => {
    const report = await warmCheckpointWorker(
      { classroomId: 'class-1' },
      {
        loadPageRenderer: pageRendererSpy().load,
        loadDeckRenderer: async () => null,
        log: quietLog(),
      }
    );
    expect(report).toMatchObject({ pageRenderer: true, deckRenderer: false });
  });
});

describe('contentCheckpointRun with a warm payload', () => {
  it('branches before the real deps exist: no Prisma, no git, no rows, no callbacks', async () => {
    const page = pageRendererSpy();
    const deck = deckRendererSpy();
    const makeDeps = vi.fn(() => {
      throw new Error('a warm-up must not build the checkpoint deps');
    });
    const report = await contentCheckpointRun(
      { classroomId: 'class-1', warm: true },
      { runId: 'run-warm', attemptNumber: 1 },
      { makeDeps, warmLoaders: { loadPageRenderer: page.load, loadDeckRenderer: deck.load } }
    );
    expect(makeDeps).not.toHaveBeenCalled();
    expect(page.load).toHaveBeenCalledTimes(1);
    expect(deck.load).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ warm: true, classroomId: 'class-1' });
  });

  it('even with full deps at hand, a warm-up calls none of them', async () => {
    const page = pageRendererSpy();
    const deck = deckRendererSpy();
    const spies = {
      remote: vi.fn(),
      commitFiles: vi.fn(),
      ensureContentRepo: vi.fn(),
      notifyCheckpointResult: vi.fn(),
      notifyOutsideEdit: vi.fn(),
      audit: vi.fn(),
      repoSizeKb: vi.fn(),
      preparePageContent: vi.fn(),
      recordPageFile: vi.fn(),
      prepareDeckForSave: vi.fn(),
      recordDeckCommit: vi.fn(),
      resolveDeckThemeUrls: vi.fn(),
    };
    const deps = {
      prisma: untouchablePrisma(),
      loadPageRenderer: page.load,
      loadDeckRenderer: deck.load,
      author: { name: 'Classmoji Bot', email: 'bot@example.com' },
      log: quietLog(),
      ...spies,
    } as unknown as CheckpointDeps;
    const report = await contentCheckpointRun(
      { classroomId: 'class-1', warm: true },
      { runId: 'run-warm', attemptNumber: 1 },
      { makeDeps: () => deps, warmLoaders: deps }
    );
    expect(report).toMatchObject({ warm: true });
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
  });

  it('a payload without `warm` still runs the real checkpoint', async () => {
    const makeDeps = vi.fn(() => {
      throw new Error('real path reached');
    });
    await expect(
      contentCheckpointRun(
        { classroomId: 'class-1', reason: 'store' },
        { runId: 'run-real', attemptNumber: 1 },
        { makeDeps }
      )
    ).rejects.toThrow('real path reached');
    expect(makeDeps).toHaveBeenCalledTimes(1);
  });
});
