/**
 * The html-block API (`api.slides.$slideId.html-block`): the request handler
 * with stand-in services, and the route's structure.
 *
 * The services' own rules — the edit gate in the slide row's classroom, the
 * compare-and-swap, the size cap, audit rows — are tested in
 * packages/services (htmlBlockFiles.service.test.ts). Pinned here: the slide
 * comes from the URL and the user from the session, whatever the body says;
 * each intent reaches its service with exactly its fields; refusals keep
 * their status (403 non-editor, 409 changed, 413, 404); and the route gates
 * before it reads a byte of the body.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

import {
  handleHtmlBlockRequest,
  type HtmlBlockApiDeps,
} from '../../app/utils/htmlBlockApi.server.ts';

class FakeServiceError extends Error {
  code: string;
  status: number;

  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const REV = 'a'.repeat(40);

/** Stand-in services that record their calls and admit only `editor` on `deck-x`. */
function fakeDeps(overrides: Partial<HtmlBlockApiDeps> = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const gate = (args: { slideId: string; actorUserId: string }) => {
    if (args.slideId !== 'deck-x') throw new FakeServiceError('not-found', 404);
    if (args.actorUserId !== 'editor') throw new FakeServiceError('forbidden', 403);
  };
  const deps: HtmlBlockApiDeps = {
    write: async args => {
      calls.push(['write', args]);
      gate(args);
      return { src: args.src ?? 'blocks/0a0b0c0d.html', rev: REV };
    },
    read: async args => {
      calls.push(['read', args]);
      gate(args);
      return { src: args.src, html: '<p>x</p>', rev: REV, stale: false };
    },
    remove: async args => {
      calls.push(['remove', args]);
      gate(args);
      return { deleted: true };
    },
    list: async args => {
      calls.push(['list', args]);
      gate(args);
      return { path: args.path, deckFolder: 'slides/x', entries: [] };
    },
    isServiceError: (error): error is never => error instanceof FakeServiceError,
    ...overrides,
  };
  return { deps, calls };
}

test.describe('html-block API handler', () => {
  test('save: passes the code, the block file and its rev; answers { src, rev }', async () => {
    const { deps, calls } = fakeDeps();
    const answer = await handleHtmlBlockRequest(
      {
        slideId: 'deck-x',
        userId: 'editor',
        body: {
          intent: 'save',
          html: '<p>hi</p>',
          src: 'blocks/0a0b0c0d.html',
          rev: REV,
          blockId: 'b1',
        },
      },
      deps
    );
    expect(answer).toEqual({ status: 200, body: { src: 'blocks/0a0b0c0d.html', rev: REV } });
    expect(calls).toEqual([
      [
        'write',
        {
          slideId: 'deck-x',
          actorUserId: 'editor',
          html: '<p>hi</p>',
          src: 'blocks/0a0b0c0d.html',
          expectedRev: REV,
          blockId: 'b1',
          surface: 'slides',
        },
      ],
    ]);
  });

  test('user A vs B, classroom X vs Y: the body cannot name another user or slide', async () => {
    const { deps, calls } = fakeDeps();
    const body = {
      intent: 'save',
      html: 'x',
      slideId: 'deck-x',
      actorUserId: 'editor',
      userId: 'editor',
    };
    // Another user on the right deck: refused as that user.
    const asOther = await handleHtmlBlockRequest(
      { slideId: 'deck-x', userId: 'other', body },
      deps
    );
    expect(asOther.status).toBe(403);
    // The editor on a deck of another classroom: refused for that deck.
    const otherDeck = await handleHtmlBlockRequest(
      { slideId: 'deck-y', userId: 'editor', body },
      deps
    );
    expect(otherDeck.status).toBe(404);
    expect(calls.map(([, args]) => [args.slideId, args.actorUserId])).toEqual([
      ['deck-x', 'other'],
      ['deck-y', 'editor'],
    ]);
  });

  test('a non-editor is refused with 403 on every intent', async () => {
    const { deps } = fakeDeps();
    for (const body of [
      { intent: 'save', html: 'x' },
      { intent: 'read', src: 'blocks/0a0b0c0d.html' },
      { intent: 'delete', src: 'blocks/0a0b0c0d.html' },
      { intent: 'list', path: '' },
    ]) {
      const answer = await handleHtmlBlockRequest(
        { slideId: 'deck-x', userId: 'student', body },
        deps
      );
      expect(answer).toEqual({ status: 403, body: { error: 'forbidden', code: 'forbidden' } });
    }
  });

  test('a compare-and-swap conflict is 409 changed; too large is 413', async () => {
    const changed = fakeDeps({
      write: async () => {
        throw new FakeServiceError('changed', 409);
      },
    });
    const conflict = await handleHtmlBlockRequest(
      {
        slideId: 'deck-x',
        userId: 'editor',
        body: { intent: 'save', html: 'x', src: 'blocks/0a0b0c0d.html', rev: REV },
      },
      changed.deps
    );
    expect(conflict).toEqual({ status: 409, body: { error: 'changed', code: 'changed' } });
    const big = fakeDeps({
      write: async () => {
        throw new FakeServiceError('too-large', 413);
      },
    });
    const tooLarge = await handleHtmlBlockRequest(
      { slideId: 'deck-x', userId: 'editor', body: { intent: 'save', html: 'x' } },
      big.deps
    );
    expect(tooLarge.status).toBe(413);
  });

  test('read, delete and list answer their shapes', async () => {
    const { deps, calls } = fakeDeps();
    const ask = (body: unknown) =>
      handleHtmlBlockRequest({ slideId: 'deck-x', userId: 'editor', body }, deps);
    expect(await ask({ intent: 'read', src: 'blocks/0a0b0c0d.html', rev: REV })).toEqual({
      status: 200,
      body: { src: 'blocks/0a0b0c0d.html', html: '<p>x</p>', rev: REV, stale: false },
    });
    expect(await ask({ intent: 'delete', src: 'blocks/0a0b0c0d.html' })).toEqual({
      status: 200,
      body: { deleted: true },
    });
    expect(await ask({ intent: 'list' })).toEqual({
      status: 200,
      body: { path: '', deckFolder: 'slides/x', entries: [] },
    });
    expect(calls.map(([name]) => name)).toEqual(['read', 'remove', 'list']);
  });

  test('bodies that fit no intent are 400 and reach no service', async () => {
    const { deps, calls } = fakeDeps();
    for (const body of [
      null,
      [],
      'save',
      { intent: 'nope' },
      { intent: 'save' },
      { intent: 'save', html: 1 },
      { intent: 'save', html: 'x', fork: 'yes' },
      { intent: 'read' },
      { intent: 'delete', src: 3 },
      { intent: 'list', path: 5 },
    ]) {
      const answer = await handleHtmlBlockRequest(
        { slideId: 'deck-x', userId: 'editor', body },
        deps
      );
      expect(answer.status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  test('anything but a service refusal is thrown, not answered', async () => {
    const { deps } = fakeDeps({
      write: async () => {
        throw new Error('GitHub is down');
      },
    });
    await expect(
      handleHtmlBlockRequest(
        { slideId: 'deck-x', userId: 'editor', body: { intent: 'save', html: 'x' } },
        deps
      )
    ).rejects.toThrow('GitHub is down');
  });
});

test.describe('html-block route', () => {
  const source = readFileSync(
    fileURLToPath(
      new URL('../../app/routes/api.slides.$slideId.html-block/route.ts', import.meta.url)
    ),
    'utf8'
  );

  test('gates as an editor before reading the body, with the slide from the URL', () => {
    const gate = source.indexOf("accessType: 'edit'");
    const read = source.indexOf('readLimitedBody(');
    expect(gate).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(gate);
    expect(source).toContain('where: { id: slideId }');
    expect(source).toContain('{ slideId: slide.id, userId, body }');
    expect(source).toContain("'Cache-Control': 'no-store'");
  });
});
