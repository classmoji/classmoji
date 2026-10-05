/**
 * When collab triggers the git worker, and how every Save version gets an
 * answer: agent ops vs a person leaving, the lost-trigger watchdog, request
 * ids, the manual reset, outside pushes with no merge base, and the
 * collab_enabled gate on server-side edits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { roomName } from '@classmoji/collab';
import { FRAGMENT } from '@classmoji/page-schema';

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

const PAGE = 'page-1';
const ROOM = roomName('page', PAGE, 1);
const actor = { userId: 'teacher-1', name: 'Ada' };
const agent = { userId: 'teacher-1', name: 'Ada', agentSession: 'sess-1' };

const paragraph = (id: string, text: string) => ({
  id,
  type: 'paragraph',
  props: { textColor: 'default', backgroundColor: 'default', textAlignment: 'left' },
  content: text ? [{ type: 'text', text, styles: {} }] : [],
  children: [],
});

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
  const text = ((found as Y.XmlElement | null)?.get(0) as Y.XmlElement | undefined)?.get(0);
  if (!(text instanceof Y.XmlText)) throw new Error(`no text in ${id}`);
  return text;
}

let server: TestServer;
const clients: TestClient[] = [];
function open(room = ROOM) {
  const client = connect(server, room);
  clients.push(client);
  return client;
}

async function setup(options: Parameters<typeof startServer>[0] = {}) {
  server = await startServer(options);
  server.world.pages.set(PAGE, makePage(PAGE));
  server.world.content.set(PAGE, { blocks: [paragraph('p1', 'One'), paragraph('p2', 'Two')] });
  server.world.roles.set(`teacher-1:${CLASSROOM_ID}`, 'TEACHER');
}

const insertOp = (id: string, text: string) => ({
  op: 'insert',
  blocks: [paragraph(id, text)],
  position: { at: 'end' },
});

beforeEach(async () => {
  await setup();
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await server.close();
});

describe('agent ops vs a person leaving', () => {
  it('agent ops on a doc nobody has open take the normal debounce, never "now"', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await internal(server, 'POST', `/page/${PAGE}/ops`, {
        ops: [insertOp(`n${i}`, `Agent ${i}`)],
        actor: agent,
      });
      expect(res.status).toBe(200);
    }
    await waitFor(() => server.checkpoints.calls.length >= 3, 3000, 'triggers');
    // Give any stray onDisconnect-path trigger time to land.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(server.checkpoints.calls.every(c => !c.now && c.payload.reason === 'store')).toBe(true);
  });

  it('a person leaving still checkpoints now (last-leave)', async () => {
    const a = open();
    await a.synced;
    a.doc.transact(() => textOf(a.doc, 'p1').insert(0, 'x'));
    await waitFor(() => server.runtime.hasUnstoredChanges('page', PAGE), 3000, 'edit');
    a.destroy();
    await waitFor(
      () => server.checkpoints.calls.some(c => c.now && c.payload.reason === 'last-leave'),
      3000,
      'last-leave'
    );
  });

  it('a person who left with a store pending is a last leave even if an agent op lands', async () => {
    await server.close();
    await setup({ storeDebounceMs: 60_000 });
    const a = open();
    await a.synced;
    a.doc.transact(() => textOf(a.doc, 'p1').insert(0, 'x'));
    await waitFor(() => server.runtime.hasUnstoredChanges('page', PAGE), 3000, 'edit');
    a.destroy();
    await waitFor(
      () => server.checkpoints.calls.some(c => c.now && c.payload.reason === 'last-leave'),
      3000,
      'last-leave'
    );
    const before = server.checkpoints.calls.length;
    // Then an agent edits the closed doc: debounced.
    await internal(server, 'POST', `/page/${PAGE}/ops`, {
      ops: [insertOp('n9', 'A')],
      actor: agent,
    });
    await waitFor(() => server.checkpoints.calls.length > before, 3000, 'agent trigger');
    expect(server.checkpoints.calls.slice(before).every(c => !c.now)).toBe(true);
  });
});

describe('lost-trigger watchdog', () => {
  beforeEach(async () => {
    await server.close();
    await setup({
      config: {
        checkpointMaxDelay: '1s',
        checkpointNowMaxDelay: '1s',
        checkpointWatchdogMarginMs: 100,
        checkpointWatchdogRetries: 2,
      },
    });
  });

  it('re-triggers a plain run when no run visited the dirty row, then moves keys', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await internal(server, 'POST', `/page/${PAGE}/ops`, {
        ops: [insertOp('n1', 'A')],
        actor: agent,
      });
      // Nothing runs the worker here: the row stays dirty and unvisited.
      await waitFor(() => server.checkpoints.calls.some(c => c.plain), 4000, 'plain re-trigger');
      const plain = server.checkpoints.calls.find(c => c.plain)!;
      expect(plain).toMatchObject({ now: true, payload: { classroomId: CLASSROOM_ID } });
      expect(warn.mock.calls.some(([m]) => String(m).includes('went missing'))).toBe(true);

      // Later triggers use the next key generation (a stuck run keeps its key).
      await internal(server, 'POST', `/page/${PAGE}/ops`, {
        ops: [insertOp('n2', 'B')],
        actor: agent,
      });
      await waitFor(
        () => server.checkpoints.calls.some(c => !c.plain && (c.generation ?? 0) >= 1),
        3000,
        'generation'
      );

      // Gives up after `checkpointWatchdogRetries` losses in a row (the sweeper's turn).
      await waitFor(
        () => error.mock.calls.some(([m]) => String(m).includes('leaving it to the sweeper')),
        8000,
        'give up'
      );
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('does nothing when a run visited the row in time', async () => {
    await internal(server, 'POST', `/page/${PAGE}/ops`, {
      ops: [insertOp('n1', 'A')],
      actor: agent,
    });
    // The worker ran (it stamps last_checkpoint_at on every row it looked at).
    server.store.rows.get(`page:${PAGE}`)!.last_checkpoint_at = new Date(Date.now() + 60_000);
    await new Promise(resolve => setTimeout(resolve, 1600));
    expect(server.checkpoints.calls.some(c => c.plain)).toBe(false);
  });
});

describe('Save version: every request is answered', () => {
  it('answers alreadySaved at once when the doc has nothing unpushed', async () => {
    const res = await internal(server, 'POST', `/page/${PAGE}/checkpoint`, {
      actor,
      requestId: 'req-clean-1',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: 0, requestId: 'req-clean-1', alreadySaved: true });
    expect(server.checkpoints.calls).toHaveLength(0);
  });

  it('carries the request on the now run, and broadcasts its answer with requestIds', async () => {
    const a = open();
    await a.synced;
    a.doc.transact(() => textOf(a.doc, 'p1').insert(0, 'x'));
    await waitFor(() => server.runtime.hasUnstoredChanges('page', PAGE), 3000, 'edit');

    const res = await internal(server, 'POST', `/page/${PAGE}/checkpoint`, {
      actor,
      message: 'Week 3',
      requestId: 'req-dirty-1',
    });
    expect(res.body).toMatchObject({ requestId: 'req-dirty-1' });
    expect(res.body.alreadySaved).toBeUndefined();
    const call = server.checkpoints.calls.find(c => c.payload.reason === 'save-version');
    expect(call).toMatchObject({
      now: true,
      payload: { message: 'Week 3', requests: [{ id: 'req-dirty-1', kind: 'page', docId: PAGE }] },
    });

    // The worker's answer reaches the room with the id.
    await internal(server, 'POST', '/checkpoint-result', {
      classroomId: CLASSROOM_ID,
      docs: [
        {
          kind: 'page',
          id: PAGE,
          at: new Date().toISOString(),
          commit: 'c1',
          requestIds: ['req-dirty-1'],
          editsSince: true,
        },
      ],
    });
    await waitFor(() => a.stateless.some(m => m.type === 'checkpoint'), 3000, 'broadcast');
    expect(a.stateless.find(m => m.type === 'checkpoint')).toMatchObject({
      commit: 'c1',
      requestIds: ['req-dirty-1'],
      editsSince: true,
    });

    // Answered: a later "now" trigger no longer carries it.
    await server.runtime.triggerCheckpoint(CLASSROOM_ID, 'last-leave', true);
    expect(server.checkpoints.calls.at(-1)!.payload.requests).toBeUndefined();
  });

  it('routine debounced triggers never carry requests', async () => {
    const a = open();
    await a.synced;
    a.doc.transact(() => textOf(a.doc, 'p1').insert(0, 'x'));
    await waitFor(() => server.runtime.hasUnstoredChanges('page', PAGE), 3000, 'edit');
    await internal(server, 'POST', `/page/${PAGE}/checkpoint`, { actor, requestId: 'req-x-0001' });
    a.doc.transact(() => textOf(a.doc, 'p1').insert(0, 'y'));
    await waitFor(
      () => server.checkpoints.calls.some(c => !c.now && c.payload.reason === 'store'),
      3000,
      'store trigger'
    );
    for (const c of server.checkpoints.calls.filter(c => !c.now)) {
      expect(c.payload.requests).toBeUndefined();
    }
  });

  it('mints a request id when none is sent, and refuses a malformed one', async () => {
    const minted = await internal(server, 'POST', `/page/${PAGE}/checkpoint`, { actor });
    expect(minted.body.requestId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    const bad = await internal(server, 'POST', `/page/${PAGE}/checkpoint`, {
      actor,
      requestId: 'no spaces!',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid-request-id');
  });
});

describe('manual reset', () => {
  it('refuses unpushed edits unless discard, then reseeds under a new epoch', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const a = open();
      await a.synced;
      a.doc.transact(() => textOf(a.doc, 'p1').insert(0, 'x'));
      await waitFor(() => server.store.storeCalls > 0, 3000, 'stored');

      const refused = await internal(server, 'POST', `/page/${PAGE}/reset`, { actor });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe('unpushed-edits');

      const reset = await internal(server, 'POST', `/page/${PAGE}/reset`, { actor, discard: true });
      expect(reset.status).toBe(200);
      expect(reset.body).toMatchObject({ epoch: 2, closed: 1, discarded: true });
      await waitFor(() => a.closeCodes.includes(4409), 3000, '4409');
      const row = (await server.store.get('page', PAGE))!;
      expect(row.epoch).toBe(2);
      expect(row.state.byteLength).toBe(0);
      expect(row.version).toBe(row.pushed_version);
    } finally {
      warn.mockRestore();
    }
  });

  it('a clean doc resets without discard', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const a = open();
      await a.synced;
      const reset = await internal(server, 'POST', `/page/${PAGE}/reset`, { actor });
      expect(reset.status).toBe(200);
      expect(reset.body).toMatchObject({ epoch: 2, discarded: false });
    } finally {
      warn.mockRestore();
    }
  });
});

describe('outside pushes without a merge base', () => {
  it('a page seeded blank merges a pushed content.json against an EMPTY base', async () => {
    server.world.content.set(PAGE, 'none');
    const a = open();
    await a.synced;
    expect((await server.store.get('page', PAGE))!.source_sha).toBeNull();
    server.world.contentAt.set(`${PAGE}@c1`, { blocks: [paragraph('gh', 'From GitHub')] });
    const res = await internal(server, 'POST', `/page/${PAGE}/external`, {
      sha: 'c1',
      before: 'b0',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ action: 'merged' });
    await waitFor(
      () => {
        try {
          return textOf(a.doc, 'gh').toString().includes('From GitHub');
        } catch {
          return false;
        }
      },
      3000,
      'theirs merged'
    );
  });

  it('records last_conflict (no-merge-base) when a base existed but is unreadable', async () => {
    server.world.contentAt.set(`${PAGE}@c2`, { blocks: [paragraph('only', 'GitHub')] });
    const a = open();
    await a.synced;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await internal(server, 'POST', `/page/${PAGE}/external`, { sha: 'c2' });
    error.mockRestore();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('no-merge-base');
    expect((await server.store.get('page', PAGE))!.last_conflict).toMatchObject({
      sha: 'c2',
      ids: [],
      reason: 'no-merge-base',
    });
  });
});

describe('collab_enabled gates server-side edits', () => {
  it('ops and cover on a classroom without live editing answer 409 collab-disabled', async () => {
    server.world.pages.set(PAGE, makePage(PAGE, { collab_enabled: false }));
    const ops = await internal(server, 'POST', `/page/${PAGE}/ops`, {
      ops: [insertOp('n1', 'A')],
      actor: agent,
    });
    expect(ops.status).toBe(409);
    expect(ops.body.error).toBe('collab-disabled');
    const cover = await internal(server, 'POST', `/page/${PAGE}/cover`, {
      coverImage: null,
      actor,
    });
    expect(cover.status).toBe(409);
    expect(await server.store.get('page', PAGE)).toBeNull();
  });
});

describe('loadedDocument', () => {
  it('prefers the newest epoch when an old room is still loaded', async () => {
    const a = open();
    await a.synced;
    // Simulate a reseed window: epoch 2 loaded while epoch 1 still is.
    await server.store.markReseed('page', PAGE);
    const b = open(roomName('page', PAGE, 2));
    await b.synced;
    expect(server.runtime.loadedDocument('page', PAGE)?.name).toBe(roomName('page', PAGE, 2));
  });
});
