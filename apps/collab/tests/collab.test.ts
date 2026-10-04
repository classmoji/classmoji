import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { roomName } from '@classmoji/collab';
import { FRAGMENT, SCHEMA_VERSION } from '@classmoji/page-schema';
import { yDocToBlocks } from '@classmoji/page-schema/server';

import { checkpointTriggerOptions } from '../src/checkpoint.ts';
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

const paragraph = (id: string, text: string) => ({
  id,
  type: 'paragraph',
  props: { textColor: 'default', backgroundColor: 'default', textAlignment: 'left' },
  content: text ? [{ type: 'text', text, styles: {} }] : [],
  children: [],
});

const twoColumns = {
  id: 'cols',
  type: 'columnList',
  props: {},
  children: [
    { id: 'col-a', type: 'column', props: { width: 1 }, children: [paragraph('in-a', 'Left')] },
    { id: 'col-b', type: 'column', props: { width: 1 }, children: [paragraph('in-b', 'Right')] },
  ],
};

/** The blockContainer element with this id, anywhere in the doc. */
function findBlock(doc: Y.Doc, id: string): Y.XmlElement | null {
  let found: Y.XmlElement | null = null;
  const walk = (node: Y.XmlElement | Y.XmlFragment) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.getAttribute('id') === id) found = child;
      else walk(child);
    }
  };
  walk(doc.getXmlFragment(FRAGMENT));
  return found;
}

/** The Y.XmlText of a paragraph block. */
function textOf(doc: Y.Doc, id: string): Y.XmlText {
  const container = findBlock(doc, id);
  const content = container?.get(0) as Y.XmlElement | undefined;
  const text = content?.get(0);
  if (!(text instanceof Y.XmlText)) throw new Error(`no text in block ${id}`);
  return text;
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

beforeEach(async () => {
  server = await startServer();
  const { world } = server;
  world.pages.set(PAGE, makePage(PAGE));
  world.content.set(PAGE, { blocks: [paragraph('p1', 'Hello world'), paragraph('p2', 'Second')] });
  world.roles.set(`teacher-1:${CLASSROOM_ID}`, 'TEACHER');
  world.roles.set(`teacher-2:${CLASSROOM_ID}`, 'OWNER');
  world.roles.set(`student-1:${CLASSROOM_ID}`, 'STUDENT');
  server.sessions.names.set('teacher-1', 'Ada');
  server.sessions.names.set('teacher-2', 'Grace');
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await server.close();
});

describe('joining a room', () => {
  it('seeds from content.json and inserts the row before serving', async () => {
    const a = open();
    await a.synced;
    expect(plain(a.doc, 'p1')).toBe('Hello world');
    const row = await server.store.get('page', PAGE);
    expect(row?.epoch).toBe(1);
    expect(row?.source_sha).toBe('seed-sha');
    expect(row?.schema_version).toBe(SCHEMA_VERSION);
    expect(row?.state.byteLength).toBeGreaterThan(0);
  });

  it('seeds a page with no files as a blank page', async () => {
    server.world.content.set(PAGE, 'none');
    const a = open();
    await a.synced;
    const blocks = yDocToBlocks(a.doc) as { type: string }[];
    expect(blocks.map(b => b.type)).toEqual(['paragraph']);
  });

  it('refuses a stale epoch', async () => {
    const a = open();
    await a.synced;
    a.destroy();
    await server.store.markReseed('page', PAGE);
    const stale = open(ROOM);
    await waitFor(() => stale.authFailures.length > 0, 3000, 'auth failure');
    expect(stale.authFailures[0]).toBe('stale-epoch');
    const fresh = open(roomName('page', PAGE, 2));
    await fresh.synced;
    expect(plain(fresh.doc, 'p1')).toBe('Hello world');
  });

  it('refuses a different schema version', async () => {
    const a = open(ROOM, { schemaVersion: SCHEMA_VERSION + 1 });
    await waitFor(() => a.authFailures.length > 0, 3000, 'auth failure');
    expect(a.authFailures[0]).toBe('schema-mismatch');
  });

  it.each([
    ['a foreign origin', { origin: 'https://evil.example' }],
    ['no session', { userId: null }],
    ['a student', { userId: 'student-1' }],
  ])('refuses %s', async (_label, options) => {
    const a = open(ROOM, options);
    await waitFor(() => a.authFailures.length > 0, 3000, 'auth failure');
    expect(a.authFailures[0]).toBe('forbidden');
  });

  it('refuses a classroom without collab, and a locked classroom for a teacher', async () => {
    server.world.pages.set(PAGE, makePage(PAGE, { collab_enabled: false }));
    const a = open();
    await waitFor(() => a.authFailures.length > 0, 3000, 'auth failure');
    expect(a.authFailures[0]).toBe('forbidden');

    server.world.pages.set(PAGE, makePage(PAGE, { status: 'LOCKED' }));
    const b = open();
    await waitFor(() => b.authFailures.length > 0, 3000, 'auth failure');
    expect(b.authFailures[0]).toBe('forbidden');
    const owner = open(ROOM, { userId: 'teacher-2' });
    await owner.synced;
  });

  it('refuses deck rooms while no deck adapter is registered', async () => {
    const a = open(roomName('deck', 'deck-1', 1));
    await waitFor(() => a.authFailures.length > 0, 3000, 'auth failure');
    expect(a.authFailures[0]).toBe('forbidden');
  });
});

describe('editing together', () => {
  it('converges when two people type in the same paragraph', async () => {
    const a = open();
    const b = open(ROOM, { userId: 'teacher-2' });
    await Promise.all([a.synced, b.synced]);

    a.doc.transact(() => textOf(a.doc, 'p1').insert(0, 'AAA '));
    b.doc.transact(() => textOf(b.doc, 'p1').insert(11, ' BBB'));

    await waitFor(
      () => plain(a.doc, 'p1') === plain(b.doc, 'p1') && plain(a.doc, 'p1').length === 19,
      3000,
      'convergence'
    );
    expect(plain(a.doc, 'p1')).toBe('AAA Hello world BBB');
  });

  it('stores with version + 1 and triggers the worker with the editors', async () => {
    const a = open();
    const b = open(ROOM, { userId: 'teacher-2' });
    await Promise.all([a.synced, b.synced]);
    a.doc.transact(() => textOf(a.doc, 'p1').insert(0, 'x'));
    b.doc.transact(() => textOf(b.doc, 'p2').insert(0, 'y'));

    await waitFor(() => server.checkpoints.calls.length > 0, 3000, 'trigger');
    await waitFor(
      () =>
        server.checkpoints.calls.some(
          call => (call.payload.editors?.[0]?.editors.length ?? 0) === 2
        ),
      3000,
      'both editors'
    );
    const row = await server.store.get('page', PAGE);
    expect(row!.version).toBeGreaterThanOrEqual(1);
    expect(row!.dirty_since).toBeInstanceOf(Date);

    const call = server.checkpoints.calls.at(-1)!;
    expect(call.now).toBe(false);
    expect(call.payload).toMatchObject({ classroomId: CLASSROOM_ID, reason: 'store' });
    const editors = call.payload.editors![0];
    expect(editors).toMatchObject({ kind: 'page', docId: PAGE });
    expect(editors.editors.map(e => e.name).sort()).toEqual(['Ada', 'Grace']);
  });

  it('writes nothing for a connection that changed nothing', async () => {
    const a = open();
    await a.synced;
    a.destroy();
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(server.store.storeCalls).toBe(0);
    expect(server.checkpoints.calls).toHaveLength(0);
  });

  it('triggers immediately (last-leave) when the last editor leaves', async () => {
    const a = open();
    await a.synced;
    a.doc.transact(() => textOf(a.doc, 'p1').insert(0, 'x'));
    await waitFor(() => server.store.storeCalls > 0, 3000, 'store');
    a.destroy();
    await waitFor(
      () => server.checkpoints.calls.some(c => c.payload.reason === 'last-leave' && c.now),
      3000,
      'last-leave trigger'
    );
  });
});

describe('re-checking access', () => {
  it('closes the socket of a revoked session with 4403, then refuses it', async () => {
    const a = open();
    const b = open(ROOM, { userId: 'teacher-2' });
    await Promise.all([a.synced, b.synced]);
    expect(server.runtime.rechecker.size).toBe(2);

    server.sessions.revoked.add('teacher-1');
    await server.runtime.rechecker.sweep();

    await waitFor(() => a.closeCodes.includes(4403), 3000, '4403 close');
    await waitFor(() => a.authFailures.includes('forbidden'), 3000, 'refused on reconnect');
    expect(b.closeCodes).not.toContain(4403);
  });

  it('closes the socket of someone who lost the role', async () => {
    const a = open();
    await a.synced;
    server.world.roles.set(`teacher-1:${CLASSROOM_ID}`, 'ASSISTANT');
    await server.runtime.rechecker.sweep();
    await waitFor(() => a.closeCodes.includes(4403), 3000, '4403 close');
  });
});

describe('column repair', () => {
  it('unwraps a columnList left with one column after a store', async () => {
    server.world.content.set(PAGE, { blocks: [paragraph('p1', 'Top'), twoColumns] });
    const a = open();
    await a.synced;

    const list = findBlock(a.doc, 'cols')!;
    a.doc.transact(() => list.delete(1, 1)); // drop col-b: one column left

    await waitFor(() => !findBlock(a.doc, 'cols'), 3000, 'repair');
    const blocks = yDocToBlocks(a.doc) as { id: string }[];
    expect(blocks.map(b => b.id)).toEqual(['p1', 'in-a']);
  });
});

describe('internal API', () => {
  const actor = { userId: 'teacher-1', name: 'Ada' };

  it('requires the shared secret', async () => {
    const res = await internal(server, 'GET', `/page/${PAGE}/snapshot`, undefined, 'wrong');
    expect(res.status).toBe(401);
  });

  it('snapshots a page nobody has open without storing it', async () => {
    const res = await internal(server, 'GET', `/page/${PAGE}/snapshot`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ epoch: 1, version: 0, live: false });
    const content = res.body.content as { blocks: { id: string }[]; coverImage: unknown };
    expect(content.blocks.map(b => b.id)).toEqual(['p1', 'p2']);
    expect(content.coverImage).toBeNull();
    expect(await server.store.get('page', PAGE)).toBeNull();
  });

  it('refuses to seed a legacy HTML page', async () => {
    server.world.content.set(PAGE, 'html');
    const res = await internal(server, 'GET', `/page/${PAGE}/snapshot`);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('legacy-html');
  });

  it('snapshots a live page from a clone, leaving the live doc untouched', async () => {
    const a = open();
    await a.synced;
    // An element the schema rejects: converting the LIVE doc would delete it.
    a.doc.transact(() => {
      const group = a.doc.getXmlFragment(FRAGMENT).get(0) as Y.XmlElement;
      const container = new Y.XmlElement('blockContainer');
      group.insert(1, [container]);
      container.setAttribute('id', 'bogus');
      container.insert(0, [new Y.XmlElement('bogusNode')]);
    });
    const live = () => server.runtime.loadedDocument('page', PAGE)!;
    await waitFor(() => !!findBlock(live(), 'bogus'), 3000, 'bogus block on server');
    const before = Y.encodeStateAsUpdate(live());

    const res = await internal(server, 'GET', `/page/${PAGE}/snapshot`);
    expect(res.status).toBe(200);
    expect(res.body.live).toBe(true);
    const ids = (res.body.content as { blocks: { id: string }[] }).blocks.map(b => b.id);
    expect(ids).toEqual(['p1', 'p2']);

    expect(Buffer.compare(Buffer.from(before), Buffer.from(Y.encodeStateAsUpdate(live())))).toBe(0);
    expect(findBlock(live(), 'bogus')).not.toBeNull();
  });

  it('applies ops id-aware, keeping a concurrent edit in the same block', async () => {
    const a = open();
    await a.synced;
    // Y item id (client, clock) of the untouched block: stable across reloads.
    const itemId = (doc: Y.Doc, id: string) => {
      const item = (
        findBlock(doc, id) as unknown as { _item: { id: { client: number; clock: number } } }
      )._item;
      return `${item.id.client}:${item.id.clock}`;
    };
    const p2Item = itemId(server.runtime.loadedDocument('page', PAGE)!, 'p2');

    // Take the client offline, type at the start of p1 …
    a.socket.disconnect();
    a.doc.transact(() => textOf(a.doc, 'p1').insert(0, 'XYZ '));

    // … while the agent updates the same block and inserts one after it.
    const res = await internal(server, 'POST', `/page/${PAGE}/ops`, {
      actor,
      ops: [
        {
          op: 'update',
          id: 'p1',
          block: { type: 'paragraph', props: { textColor: 'red' }, content: 'Hello world!' },
        },
        { op: 'insert', blocks: [paragraph('p-new', 'Inserted')], position: { after: 'p1' } },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.version).toBeGreaterThanOrEqual(1);

    // Back online: the offline typing and the agent's edit merge.
    a.socket.connect();
    await waitFor(() => plain(a.doc, 'p1') === 'XYZ Hello world!', 10_000, 'merged text');
    const blocks = yDocToBlocks(a.doc) as { id: string; props: { textColor: string } }[];
    expect(blocks.map(b => b.id)).toEqual(['p1', 'p-new', 'p2']);
    expect(blocks[0].props.textColor).toBe('red');

    // The untouched block is the same Y element (not rewritten).
    expect(itemId(a.doc, 'p2')).toBe(p2Item);
  });

  it('shows the agent in awareness while it edits', async () => {
    const a = open();
    await a.synced;
    await internal(server, 'POST', `/page/${PAGE}/ops`, {
      actor,
      ops: [{ op: 'delete', id: 'p2' }],
    });
    await waitFor(
      () =>
        [...a.provider.awareness!.getStates().values()].some(
          state => (state as { user?: { name?: string } }).user?.name === 'Ada (agent)'
        ),
      3000,
      'agent presence'
    );
  });

  it('answers 422 for an op naming an unknown block, writing nothing', async () => {
    const res = await internal(server, 'POST', `/page/${PAGE}/ops`, {
      actor,
      ops: [{ op: 'delete', id: 'nope' }],
    });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: 'invalid-op', code: 'UNKNOWN_BLOCK_ID' });
    expect(server.store.storeCalls).toBe(0);
  });

  it('answers 400 for malformed ops', async () => {
    const res = await internal(server, 'POST', `/page/${PAGE}/ops`, {
      actor,
      ops: [{ op: 'zap' }],
    });
    expect(res.status).toBe(400);
  });

  it('sets the cover inside the live doc', async () => {
    const cover = { url: 'assets/cover.png', position: 40 };
    const res = await internal(server, 'POST', `/page/${PAGE}/cover`, { actor, coverImage: cover });
    expect(res.status).toBe(200);
    const snap = await internal(server, 'GET', `/page/${PAGE}/snapshot`);
    expect((snap.body.content as { coverImage: unknown }).coverImage).toEqual(cover);
    expect(snap.body.version).toBeGreaterThanOrEqual(1);
  });

  it('checkpoint flushes the pending store and triggers now', async () => {
    // A long store debounce, so only the flush can have stored the edit.
    await server.close();
    server = await startServer({ storeDebounceMs: 60_000 });
    server.world.pages.set(PAGE, makePage(PAGE));
    server.world.content.set(PAGE, { blocks: [paragraph('p1', 'Hello world')] });
    server.world.roles.set(`teacher-1:${CLASSROOM_ID}`, 'TEACHER');

    const a = open();
    await a.synced;
    a.doc.transact(() => textOf(a.doc, 'p1').insert(0, 'x'));
    await waitFor(() => server.runtime.hasUnstoredChanges('page', PAGE), 3000, 'change on server');
    expect(server.store.storeCalls).toBe(0);

    const res = await internal(server, 'POST', `/page/${PAGE}/checkpoint`, {
      actor,
      message: 'Week 3 ready',
    });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(1);
    const call = server.checkpoints.calls.find(c => c.payload.reason === 'save-version');
    expect(call).toMatchObject({
      now: true,
      payload: { classroomId: CLASSROOM_ID, message: 'Week 3 ready' },
    });
  });

  it('close checkpoints and closes every socket with 4409 reload', async () => {
    const a = open();
    await a.synced;
    server.world.pages.set(PAGE, makePage(PAGE, { collab_enabled: false }));
    const res = await internal(server, 'POST', `/page/${PAGE}/close`, { reason: 'flag-off' });
    expect(res.body).toEqual({ closed: 1 });
    expect(server.checkpoints.calls.some(c => c.payload.reason === 'flag-off' && c.now)).toBe(true);
    await waitFor(() => a.closeCodes.includes(4409), 3000, '4409 close');
    expect(a.closeCodes).not.toContain(4403);
  });

  it('external: reseeds a clean doc nobody has open under a new epoch', async () => {
    const a = open();
    await a.synced;
    a.destroy();
    await waitFor(() => !server.runtime.loadedDocument('page', PAGE), 3000, 'unload');

    const res = await internal(server, 'POST', `/page/${PAGE}/external`, { sha: 'c2' });
    expect(res.body).toEqual({ action: 'reseeded', epoch: 2 });
    server.world.content.set(PAGE, { blocks: [paragraph('p9', 'From GitHub')] });
    const b = open(roomName('page', PAGE, 2));
    await b.synced;
    expect(plain(b.doc, 'p9')).toBe('From GitHub');
  });

  it('external: 3-way merges an outside push into a live doc', async () => {
    const base = { blocks: [paragraph('p1', 'Hello world'), paragraph('p2', 'Second')] };
    server.world.blobs.set('seed-sha', JSON.stringify(base));
    server.world.contentAt.set(`${PAGE}@c2`, {
      blocks: [paragraph('p1', 'Hello world'), paragraph('p2', 'Second, edited on GitHub')],
    });

    const a = open();
    await a.synced;
    a.doc.transact(() => textOf(a.doc, 'p1').insert(0, 'Live '));
    await waitFor(
      () => plain(server.runtime.loadedDocument('page', PAGE)!, 'p1') === 'Live Hello world',
      3000,
      'live edit on server'
    );

    const res = await internal(server, 'POST', `/page/${PAGE}/external`, { sha: 'c2' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ action: 'merged', conflicts: 0 });
    await waitFor(() => plain(a.doc, 'p2') === 'Second, edited on GitHub', 3000, 'theirs arrives');
    expect(plain(a.doc, 'p1')).toBe('Live Hello world');
    expect((await server.store.get('page', PAGE))!.source_sha).toBe('blob-c2');
  });
});

describe('checkpoint trigger options', () => {
  const config = { checkpointDelay: '10s', checkpointMaxDelay: '30s' };
  it('debounces stores per classroom', () => {
    expect(checkpointTriggerOptions('c1', false, config)).toEqual({
      concurrencyKey: 'c1',
      debounce: { key: 'checkpoint:c1', delay: '10s', maxDelay: '30s', mode: 'trailing' },
    });
  });
  it('runs save-version / last-leave on its own 1-s key', () => {
    expect(checkpointTriggerOptions('c1', true, config)).toEqual({
      concurrencyKey: 'c1',
      debounce: { key: 'checkpoint-now:c1', delay: '1s', mode: 'trailing' },
    });
  });
});
