/**
 * Ops vocabulary, write guards, reseeds, close codes, refusal reasons,
 * merge-preview, outside pushes and ephemeral (lock-only) changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { roomName } from '@classmoji/collab';
import { ClassmojiService } from '@classmoji/services';
import { FRAGMENT } from '@classmoji/page-schema';
import { pageContentToYDoc, yDocToBlocks } from '@classmoji/page-schema/server';

import type { CollabAdapter } from '../src/adapters/types.ts';
import {
  CLASSROOM_ID,
  connect,
  internal,
  makePage,
  startServer,
  waitFor,
  type TestClient,
  type TestServer,
} from './helpers.ts';

const pc = ClassmojiService.pageContent;
const PAGE = 'page-1';
const ROOM = roomName('page', PAGE, 1);
const actor = { userId: 'teacher-1', name: 'Ada' };

const paragraph = (id: string, text: string, children: unknown[] = []) => ({
  id,
  type: 'paragraph',
  props: { textColor: 'default', backgroundColor: 'default', textAlignment: 'left' },
  content: text ? [{ type: 'text', text, styles: {} }] : [],
  children,
});

const columns = (id: string, ...cols: [string, unknown[]][]) => ({
  id,
  type: 'columnList',
  props: {},
  children: cols.map(([colId, kids]) => ({
    id: colId,
    type: 'column',
    props: { width: 1 },
    children: kids,
  })),
});

const INITIAL = [
  paragraph('p1', 'One'),
  paragraph('p2', 'Two', [paragraph('p2a', 'Nested A'), paragraph('p2b', 'Nested B')]),
  columns('cols', ['c1', [paragraph('in1', 'Left')]], ['c2', [paragraph('in2', 'Right')]]),
  paragraph('p3', 'Three'),
];

/** What a doc holding `blocks` reads back as (the schema's full shape). */
function rendered(blocks: unknown[]): unknown[] {
  return yDocToBlocks(pageContentToYDoc({ blocks }));
}

function textOf(doc: Y.Doc, id: string): Y.XmlText {
  let found: Y.XmlElement | null = null;
  const walk = (node: Y.XmlElement | Y.XmlFragment) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.getAttribute('id') === id) found = child;
      else walk(child);
    }
  };
  walk(doc.getXmlFragment(FRAGMENT));
  const content = (found as Y.XmlElement | null)?.get(0) as Y.XmlElement | undefined;
  const text = content?.get(0);
  if (!(text instanceof Y.XmlText)) throw new Error(`no text in ${id}`);
  return text as Y.XmlText;
}

const plain = (doc: Y.Doc, id: string) =>
  textOf(doc, id)
    .toDelta()
    .map((d: { insert: string }) => d.insert)
    .join('');

let server: TestServer;
const clients: TestClient[] = [];
function open(room = ROOM, options: Parameters<typeof connect>[2] = {}) {
  const client = connect(server, room, options);
  clients.push(client);
  return client;
}

async function setup(options: Parameters<typeof startServer>[0] = {}) {
  server = await startServer(options);
  server.world.pages.set(PAGE, makePage(PAGE));
  server.world.content.set(PAGE, { blocks: structuredClone(INITIAL) });
  server.world.roles.set(`teacher-1:${CLASSROOM_ID}`, 'TEACHER');
  server.world.roles.set(`teacher-2:${CLASSROOM_ID}`, 'OWNER');
}

async function snapshotBlocks() {
  const res = await internal(server, 'GET', `/page/${PAGE}/snapshot`);
  expect(res.status).toBe(200);
  return (res.body.content as { blocks: { id: string }[] }).blocks;
}

beforeEach(async () => {
  await setup();
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await server.close();
});

describe('ops vocabulary (id-aware, matches applyBlockOps)', () => {
  const cases: [string, unknown[]][] = [
    [
      'insert at start / after / end',
      [
        { op: 'insert', blocks: [paragraph('n1', 'First')], position: { at: 'start' } },
        { op: 'insert', blocks: [paragraph('n2', 'After one')], position: { after: 'p1' } },
        { op: 'insert', blocks: [paragraph('n3', 'Last')], position: { at: 'end' } },
      ],
    ],
    [
      'move to the end and after a block',
      [
        { op: 'move', id: 'p1', position: { at: 'end' } },
        { op: 'move', id: 'p3', position: { after: 'p2' } },
      ],
    ],
    [
      'delete a top-level and a nested block',
      [
        { op: 'delete', id: 'p3' },
        { op: 'delete', id: 'p2a' },
      ],
    ],
    [
      'replace_all keeping some ids',
      [{ op: 'replace_all', blocks: [paragraph('p3', 'Three, kept'), paragraph('fresh', 'New')] }],
    ],
    [
      'nested insert and update',
      [
        { op: 'insert', blocks: [paragraph('p2c', 'Nested C')], position: { after: 'p2b' } },
        {
          op: 'update',
          id: 'p2a',
          block: { type: 'heading', props: { level: 2 }, content: 'Now a heading' },
        },
      ],
    ],
    [
      'multi-column: add inside a column, delete a column (unwraps)',
      [
        { op: 'insert', blocks: [paragraph('in1b', 'Left 2')], position: { after: 'in1' } },
        { op: 'delete', id: 'c2' },
      ],
    ],
  ];

  it.each(cases)('%s', async (_label, ops) => {
    const before = await snapshotBlocks();
    const res = await internal(server, 'POST', `/page/${PAGE}/ops`, { actor, ops });
    expect(res.status).toBe(200);
    const expected = rendered(pc.ensureBlockIds(pc.applyBlockOps(before, ops as never)));
    expect(await snapshotBlocks()).toEqual(expected);
  });

  it('keeps one blank paragraph when every block is deleted', async () => {
    const res = await internal(server, 'POST', `/page/${PAGE}/ops`, {
      actor,
      ops: ['p1', 'p2', 'cols', 'p3'].map(id => ({ op: 'delete', id })),
    });
    expect(res.status).toBe(200);
    const blocks = (await snapshotBlocks()) as unknown as { type: string; content: unknown[] }[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'paragraph', content: [] });
  });
});

describe('write guards', () => {
  it('H1: an invalid block is a 422 with nothing written (no partial write)', async () => {
    const a = open();
    await a.synced;
    const before = await snapshotBlocks();
    const res = await internal(server, 'POST', `/page/${PAGE}/ops`, {
      actor,
      ops: [
        { op: 'update', id: 'p1', block: { type: 'paragraph', content: 'Changed' } },
        { op: 'insert', blocks: [{ id: 'bad', type: 'bogusType' }], position: { at: 'end' } },
      ],
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('invalid-block');
    expect(await snapshotBlocks()).toEqual(before);
    expect(plain(a.doc, 'p1')).toBe('One');
    expect(server.store.storeCalls).toBe(0);
  });

  it('M3: refuses to write when the clone read drops a live block', async () => {
    const a = open();
    await a.synced;
    a.doc.transact(() => {
      const group = a.doc.getXmlFragment(FRAGMENT).get(0) as Y.XmlElement;
      const container = new Y.XmlElement('blockContainer');
      group.insert(0, [container]);
      container.setAttribute('id', 'unreadable');
      container.insert(0, [new Y.XmlElement('bogusNode')]);
    });
    await waitFor(
      () => server.runtime.hasUnstoredChanges('page', PAGE) || server.store.storeCalls > 0,
      3000,
      'bogus block on server'
    );
    const res = await internal(server, 'POST', `/page/${PAGE}/ops`, {
      actor,
      ops: [{ op: 'delete', id: 'p3' }],
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'unreadable-live-doc', ids: ['unreadable'] });
    expect(plain(a.doc, 'p3')).toBe('Three');
  });
});

describe('reseeds and close codes', () => {
  it('H2: a clean row whose git file moved is reseeded and refused with stale-epoch', async () => {
    const a = open();
    await a.synced;
    a.destroy();
    await waitFor(() => !server.runtime.loadedDocument('page', PAGE), 3000, 'unload');

    server.world.headSha.set(PAGE, 'pushed-from-github');
    server.world.content.set(PAGE, { blocks: [paragraph('gh', 'From GitHub')] });
    const stale = open(ROOM);
    await waitFor(() => stale.authFailures.length > 0, 3000, 'refusal');
    expect(stale.authFailures[0]).toBe('stale-epoch');
    expect((await server.store.get('page', PAGE))!.epoch).toBe(2);

    const fresh = open(roomName('page', PAGE, 2));
    await fresh.synced;
    expect(plain(fresh.doc, 'gh')).toBe('From GitHub');
  });

  it('H2: a dirty row is served, not reseeded', async () => {
    await server.close();
    await setup({ storeDebounceMs: 30 });
    const a = open();
    await a.synced;
    a.doc.transact(() => textOf(a.doc, 'p1').insert(0, 'x'));
    await waitFor(() => server.store.storeCalls > 0, 3000, 'store');
    a.destroy();
    await waitFor(() => !server.runtime.loadedDocument('page', PAGE), 3000, 'unload');
    server.world.headSha.set(PAGE, 'moved');
    const b = open(ROOM);
    await b.synced;
    expect(plain(b.doc, 'p1')).toBe('xOne');
  });

  it('M2: a store refused for a bumped epoch closes the room (4409 stale-epoch)', async () => {
    await server.close();
    await setup({ storeDebounceMs: 60_000 });
    const a = open();
    await a.synced;
    a.doc.transact(() => textOf(a.doc, 'p1').insert(0, 'x'));
    await waitFor(() => server.runtime.hasUnstoredChanges('page', PAGE), 3000, 'change');
    server.store.rows.get(`page:${PAGE}`)!.epoch = 2; // reseeded underneath
    await server.runtime.flush('page', PAGE);
    await waitFor(() => a.closeCodes.includes(4409), 3000, '4409 close');
  });

  it('flag flip: closes open rooms (4409) and reseeds clean rows', async () => {
    const a = open();
    await a.synced;
    const res = await internal(server, 'POST', `/classroom/${CLASSROOM_ID}/flag`, {
      enabled: false,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ closed: 1, reseeded: 1 });
    await waitFor(() => a.closeCodes.includes(4409), 3000, '4409 close');
    expect((await server.store.get('page', PAGE))!.epoch).toBe(2);
    expect(server.checkpoints.calls.some(c => c.payload.reason === 'flag-off' && c.now)).toBe(true);
  });
});

describe('refusal reasons', () => {
  it("an unexpected auth error is 'unavailable', not forbidden", async () => {
    server.world.fail.role = true;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = open();
    await waitFor(() => a.authFailures.length > 0, 3000, 'refusal');
    expect(a.authFailures[0]).toBe('unavailable');
    error.mockRestore();
  });

  it("an unexpected load error is 'unavailable'", async () => {
    server.world.fail.content = true;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = open();
    await waitFor(() => a.authFailures.length > 0, 3000, 'refusal');
    expect(a.authFailures[0]).toBe('unavailable');
    error.mockRestore();
  });

  it("a legacy HTML page is refused with 'legacy-html'", async () => {
    server.world.content.set(PAGE, 'html');
    const a = open();
    await waitFor(() => a.authFailures.length > 0, 3000, 'refusal');
    expect(a.authFailures[0]).toBe('legacy-html');
  });
});

describe('merge-preview', () => {
  const base = { blocks: structuredClone(INITIAL), coverImage: null };

  it('merges a clean preview into the live doc, keeping live typing', async () => {
    const a = open();
    await a.synced;
    a.doc.transact(() => textOf(a.doc, 'p1').insert(3, ' (live)'));
    await waitFor(
      () => server.runtime.hasUnstoredChanges('page', PAGE) || server.store.storeCalls > 0,
      3000,
      'live edit'
    );

    const theirs = {
      blocks: structuredClone(INITIAL).map(b =>
        b.id === 'p3' ? paragraph('p3', 'Three, from the preview') : b
      ),
      coverImage: { url: 'assets/new.png', position: 50 },
    };
    const res = await internal(server, 'POST', `/page/${PAGE}/merge-preview`, {
      base,
      theirs,
      actor,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applied: true });
    await waitFor(() => plain(a.doc, 'p3') === 'Three, from the preview', 3000, 'theirs');
    expect(plain(a.doc, 'p1')).toBe('One (live)');
    const snap = await internal(server, 'GET', `/page/${PAGE}/snapshot`);
    expect((snap.body.content as { coverImage: unknown }).coverImage).toEqual(theirs.coverImage);
  });

  it('answers 409 conflicts and applies nothing, then applies with resolutions', async () => {
    const a = open();
    await a.synced;
    a.doc.transact(() => textOf(a.doc, 'p1').insert(3, ' live'));
    await waitFor(
      () => server.runtime.hasUnstoredChanges('page', PAGE) || server.store.storeCalls > 0,
      3000,
      'live edit'
    );

    const theirs = {
      blocks: structuredClone(INITIAL).map(b =>
        b.id === 'p1' ? paragraph('p1', 'One preview') : b
      ),
      coverImage: null,
    };
    const conflict = await internal(server, 'POST', `/page/${PAGE}/merge-preview`, {
      base,
      theirs,
      actor,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('conflicts');
    const conflicts = conflict.body.conflicts as { id: string }[];
    expect(conflicts.map(c => c.id)).toEqual(['p1']);
    expect(plain(a.doc, 'p1')).toBe('One live');

    const resolved = await internal(server, 'POST', `/page/${PAGE}/merge-preview`, {
      base,
      theirs,
      resolutions: [{ id: 'p1', choose: 'theirs' }],
      actor,
    });
    expect(resolved.status).toBe(200);
    await waitFor(() => plain(a.doc, 'p1') === 'One preview', 3000, 'theirs chosen');
  });

  it('answers 501 for a kind whose adapter has no mergePreview', async () => {
    await server.close();
    await setup({ deck: fakeDeckAdapter() });
    const res = await internal(server, 'POST', `/deck/deck-1/merge-preview`, {
      base: {},
      theirs: {},
      actor,
    });
    expect(res.status).toBe(501);
  });
});

describe('outside pushes', () => {
  it('uses the file at `before` as the base', async () => {
    server.world.contentAt.set(`${PAGE}@b1`, { blocks: structuredClone(INITIAL) });
    server.world.contentAt.set(`${PAGE}@c2`, {
      blocks: structuredClone(INITIAL).map(b =>
        b.id === 'p3' ? paragraph('p3', 'Three, GitHub') : b
      ),
    });
    const a = open();
    await a.synced;
    a.doc.transact(() => textOf(a.doc, 'p1').insert(0, 'Live '));
    await waitFor(
      () => server.runtime.hasUnstoredChanges('page', PAGE) || server.store.storeCalls > 0,
      3000,
      'live edit'
    );

    const res = await internal(server, 'POST', `/page/${PAGE}/external`, {
      sha: 'c2',
      before: 'b1',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ action: 'merged', conflicts: 0 });
    await waitFor(() => plain(a.doc, 'p3') === 'Three, GitHub', 3000, 'theirs');
    expect(plain(a.doc, 'p1')).toBe('Live One');
  });

  it('keeps the live doc and answers 409 when no base is readable', async () => {
    server.world.contentAt.set(`${PAGE}@c2`, { blocks: [paragraph('only', 'GitHub wholesale')] });
    const a = open();
    await a.synced;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await internal(server, 'POST', `/page/${PAGE}/external`, { sha: 'c2' });
    error.mockRestore();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('no-merge-base');
    expect(plain(a.doc, 'p1')).toBe('One');
  });

  it('ignores our own push and a push whose file we already descend from', async () => {
    const a = open();
    await a.synced;
    server.store.rows.get(`page:${PAGE}`)!.pushed_commit = 'ours-1';
    const own = await internal(server, 'POST', `/page/${PAGE}/external`, { sha: 'ours-1' });
    expect(own.body).toMatchObject({ action: 'none', reason: 'own-push' });

    server.world.contentAt.set(`${PAGE}@old`, { blocks: [paragraph('x', 'stale')] });
    server.store.rows.get(`page:${PAGE}`)!.source_sha = 'blob-old';
    const replay = await internal(server, 'POST', `/page/${PAGE}/external`, { sha: 'old' });
    expect(replay.body).toMatchObject({ action: 'none', reason: 'already-merged' });
    expect(plain(a.doc, 'p1')).toBe('One');
  });
});

describe('snapshot / ops versions', () => {
  it('a snapshot of a loaded doc stores pending edits first, so version covers content', async () => {
    await server.close();
    await setup({ storeDebounceMs: 60_000 });
    const a = open();
    await a.synced;
    a.doc.transact(() => textOf(a.doc, 'p1').insert(0, 'x'));
    await waitFor(() => server.runtime.hasUnstoredChanges('page', PAGE), 3000, 'change');
    expect(server.store.storeCalls).toBe(0);

    const res = await internal(server, 'GET', `/page/${PAGE}/snapshot`);
    expect(res.body).toMatchObject({ epoch: 1, version: 1, live: true });
    const p1 = (res.body.content as { blocks: { id: string; content: { text: string }[] }[] })
      .blocks[0];
    expect(p1.content[0].text).toBe('xOne');
  });

  it('ops return the version that includes them, with a browser connected', async () => {
    await server.close();
    await setup({ storeDebounceMs: 60_000 });
    const a = open();
    await a.synced;
    const res = await internal(server, 'POST', `/page/${PAGE}/ops`, {
      actor,
      ops: [{ op: 'delete', id: 'p3' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe((await server.store.get('page', PAGE))!.version);
    expect(res.body.version).toBeGreaterThanOrEqual(1);
  });
});

describe('checkpoint payloads', () => {
  it('a last-leave trigger within the window keeps the Save-version message', async () => {
    await server.runtime.triggerCheckpoint(CLASSROOM_ID, 'save-version', true, 'Week 3');
    await server.runtime.triggerCheckpoint(CLASSROOM_ID, 'last-leave', true);
    expect(server.checkpoints.calls.at(-1)!.payload).toMatchObject({
      reason: 'save-version',
      message: 'Week 3',
    });
  });
});

describe('agent presence', () => {
  it('shows one awareness entry per concurrent agent', async () => {
    const a = open();
    await a.synced;
    await Promise.all([
      internal(server, 'POST', `/page/${PAGE}/ops`, { actor, ops: [{ op: 'delete', id: 'p3' }] }),
      internal(server, 'POST', `/page/${PAGE}/ops`, {
        actor: { userId: 'teacher-2', name: 'Grace' },
        ops: [{ op: 'delete', id: 'p1' }],
      }),
    ]);
    const names = () =>
      [...a.provider.awareness!.getStates().values()].map(
        s => (s as { user?: { name?: string } }).user?.name
      );
    await waitFor(
      () => names().includes('Ada (agent)') && names().includes('Grace (agent)'),
      3000,
      'both agents'
    );
  });
});

// ─── Ephemeral (lock-only) changes ─────────────────────────────────────────

function fakeDeckAdapter(attach = vi.fn()): CollabAdapter<'deck'> {
  return {
    kind: 'deck',
    schemaVersion: 1,
    async authorize() {
      return { ok: true, classroomId: CLASSROOM_ID };
    },
    async locate() {
      return { classroomId: CLASSROOM_ID };
    },
    async seed() {
      return { doc: new Y.Doc(), sourceSha: null, classroomId: CLASSROOM_ID };
    },
    snapshot() {
      return {} as never;
    },
    parseOps: raw => raw as unknown[],
    applyOps() {},
    async mergeExternal() {
      return { sourceSha: null, conflicts: 0 };
    },
    attach,
  };
}

describe('ephemeral changes (deck locks)', () => {
  it('a lock-only transaction is not an edit; attach runs on load', async () => {
    const attach = vi.fn();
    await server.close();
    await setup({ deck: fakeDeckAdapter(attach) });
    const a = open(roomName('deck', 'deck-1', 1), { schemaVersion: 1 });
    await a.synced;
    await waitFor(() => attach.mock.calls.length === 1, 3000, 'attach');

    a.doc.transact(() => a.doc.getMap('locks').set('s1', { userId: 'teacher-1', since: 1 }));
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(server.store.storeCalls).toBe(0);
    expect(server.checkpoints.calls).toHaveLength(0);

    a.doc.transact(() => a.doc.getMap('slides').set('s1', 'edited'));
    await waitFor(() => server.store.storeCalls === 1, 3000, 'real edit stored');
    await waitFor(() => server.checkpoints.calls.length > 0, 3000, 'trigger');
    const editors = server.checkpoints.calls.at(-1)!.payload.editors ?? [];
    expect(editors.map(e => e.docId)).toEqual(['deck-1']);
  });
});
