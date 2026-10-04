/**
 * Guarded ops, persisted co-authors, deleted docs, audit rows, agent focus,
 * stateless broadcasts, checkpoint fields, legacy covers, restarts and the
 * production config checks.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { roomName } from '@classmoji/collab';
import { itemHash } from '@classmoji/collab/hash';
import { FRAGMENT } from '@classmoji/page-schema';

import { loadConfig } from '../src/config.ts';
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
  const content = (found as Y.XmlElement | null)?.get(0) as Y.XmlElement | undefined;
  const text = content?.get(0);
  if (!(text instanceof Y.XmlText)) throw new Error(`no text in ${id}`);
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

function populate(target: TestServer) {
  target.world.pages.set(PAGE, makePage(PAGE));
  target.world.content.set(PAGE, { blocks: [paragraph('p1', 'One'), paragraph('p2', 'Two')] });
  target.world.roles.set(`teacher-1:${CLASSROOM_ID}`, 'TEACHER');
  target.world.roles.set(`teacher-2:${CLASSROOM_ID}`, 'OWNER');
  target.world.roles.set(`student-1:${CLASSROOM_ID}`, 'STUDENT');
  target.sessions.names.set('teacher-1', 'Ada');
  target.sessions.names.set('teacher-2', 'Grace');
}

async function snapshot() {
  const res = await internal(server, 'GET', `/page/${PAGE}/snapshot`);
  expect(res.status).toBe(200);
  return res.body as {
    epoch: number;
    version: number;
    content: { blocks: { id: string }[] };
    lastCheckpointAt: string | null;
    lastCheckpointError: string | null;
  };
}

beforeEach(async () => {
  server = await startServer();
  populate(server);
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await server.close();
});

describe('guarded ops', () => {
  it('applies when every expected hash matches, returning epoch, version and insertedIds', async () => {
    const snap = await snapshot();
    const p1 = snap.content.blocks.find(b => b.id === 'p1')!;
    const res = await internal(server, 'POST', `/page/${PAGE}/ops`, {
      actor,
      expect: { p1: itemHash(p1) },
      ops: [
        { op: 'update', id: 'p1', block: { type: 'paragraph', content: 'One, edited' } },
        {
          op: 'insert',
          blocks: [{ type: 'paragraph', content: 'New A' }],
          position: { after: 'p1' },
        },
        { op: 'insert', blocks: [paragraph('p2', 'Clashes with p2')], position: { at: 'end' } },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.epoch).toBe(1);
    expect(res.body.version).toBeGreaterThanOrEqual(1);
    const inserted = res.body.insertedIds as string[];
    expect(inserted).toHaveLength(2);
    expect(inserted[1]).not.toBe('p2'); // re-minted: p2 already exists
    const ids = (await snapshot()).content.blocks.map(b => b.id);
    expect(ids).toEqual(['p1', inserted[0], 'p2', inserted[1]]);
  });

  it('409 block-changed with nothing applied when a block moved on', async () => {
    const snap = await snapshot();
    const p1 = snap.content.blocks.find(b => b.id === 'p1')!;
    const a = open();
    await a.synced;
    a.doc.transact(() => textOf(a.doc, 'p1').insert(0, 'x'));
    await waitFor(
      () => plain(server.runtime.loadedDocument('page', PAGE)!, 'p1') === 'xOne',
      3000,
      'edit on server'
    );
    const res = await internal(server, 'POST', `/page/${PAGE}/ops`, {
      actor,
      expect: { p1: itemHash(p1), gone: 'abc' },
      ops: [{ op: 'delete', id: 'p2' }],
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'block-changed', changedIds: ['p1', 'gone'] });
    expect(plain(a.doc, 'p2')).toBe('Two');
  });
});

describe('co-authors are persisted', () => {
  it('stores merge editors into the row; the trigger payload reads them', async () => {
    const a = open();
    const b = open(ROOM, { userId: 'teacher-2' });
    await Promise.all([a.synced, b.synced]);
    a.doc.transact(() => textOf(a.doc, 'p1').insert(0, 'a'));
    await waitFor(() => server.store.storeCalls > 0, 3000, 'first store');
    b.doc.transact(() => textOf(b.doc, 'p2').insert(0, 'b'));
    await waitFor(
      () => (server.store.rows.get(`page:${PAGE}`)?.editors.length ?? 0) === 2,
      3000,
      'both editors persisted'
    );
    expect(server.store.rows.get(`page:${PAGE}`)!.editors).toEqual([
      { userId: 'teacher-1', name: 'Ada' },
      { userId: 'teacher-2', name: 'Grace' },
    ]);
    const last = server.checkpoints.calls.at(-1)!.payload;
    expect(last.editors).toEqual([
      {
        kind: 'page',
        docId: PAGE,
        editors: [
          { userId: 'teacher-1', name: 'Ada' },
          { userId: 'teacher-2', name: 'Grace' },
        ],
      },
    ]);
  });

  it('Save version records its actor as an editor', async () => {
    const a = open();
    await a.synced;
    a.doc.transact(() => textOf(a.doc, 'p1').insert(0, 'a'));
    await waitFor(() => server.store.storeCalls > 0, 3000, 'store');
    const res = await internal(server, 'POST', `/page/${PAGE}/checkpoint`, {
      actor: { userId: 'teacher-2', name: 'Grace' },
    });
    expect(res.status).toBe(200);
    expect(server.store.rows.get(`page:${PAGE}`)!.editors.map(e => e.userId)).toEqual([
      'teacher-1',
      'teacher-2',
    ]);
    const saved = server.checkpoints.calls.find(c => c.payload.reason === 'save-version')!;
    expect(saved.payload.editors?.[0].editors.map(e => e.userId)).toContain('teacher-2');
  });
});

describe('/close reason deleted', () => {
  it('closes the room (4409) and deletes the row, with no checkpoint', async () => {
    await server.close();
    server = await startServer({ storeDebounceMs: 60_000 });
    populate(server);
    const a = open();
    await a.synced;
    a.doc.transact(() => textOf(a.doc, 'p1').insert(0, 'x')); // unstored
    await waitFor(() => server.runtime.hasUnstoredChanges('page', PAGE), 3000, 'change');
    server.world.pages.delete(PAGE);

    const res = await internal(server, 'POST', `/page/${PAGE}/close`, { reason: 'deleted' });
    expect(res.body).toEqual({ closed: 1 });
    await waitFor(() => a.closeCodes.includes(4409), 3000, '4409');
    await waitFor(() => !server.runtime.loadedDocument('page', PAGE), 3000, 'unload');
    expect(await server.store.get('page', PAGE)).toBeNull();
    expect(server.checkpoints.calls).toHaveLength(0);
  });
});

describe('audit', () => {
  it('records COLLAB_JOIN and COLLAB_LEAVE per connection', async () => {
    const a = open();
    await a.synced;
    await waitFor(() => server.audit.entries.length > 0, 3000, 'join');
    expect(server.audit.entries[0]).toMatchObject({
      action: 'COLLAB_JOIN',
      userId: 'teacher-1',
      classroomId: CLASSROOM_ID,
      role: 'TEACHER',
      resourceType: 'collab_page',
      resourceId: PAGE,
    });
    a.destroy();
    await waitFor(() => server.audit.entries.some(e => e.action === 'COLLAB_LEAVE'), 3000, 'leave');
  });

  it('records ACCESS_DENIED for a refused member, nothing for a non-member', async () => {
    const student = open(ROOM, { userId: 'student-1' });
    await waitFor(() => student.authFailures.length > 0, 3000, 'refusal');
    const stranger = open(ROOM, { userId: 'stranger' });
    await waitFor(() => stranger.authFailures.length > 0, 3000, 'refusal');
    await waitFor(() => server.audit.entries.length > 0, 3000, 'audit');
    expect(server.audit.entries).toEqual([
      expect.objectContaining({
        action: 'ACCESS_DENIED',
        userId: 'student-1',
        role: 'STUDENT',
        data: { reason: 'forbidden' },
      }),
    ]);
  });
});

describe('agent presence focus', () => {
  it('carries the blockId the agent last touched', async () => {
    const a = open();
    await a.synced;
    await internal(server, 'POST', `/page/${PAGE}/ops`, {
      actor,
      ops: [{ op: 'update', id: 'p2', block: { type: 'paragraph', content: 'Agent' } }],
    });
    await waitFor(
      () =>
        [...a.provider.awareness!.getStates().values()].some(
          s => (s as { blockId?: string }).blockId === 'p2'
        ),
      3000,
      'agent focus'
    );
  });
});

describe('stateless broadcasts', () => {
  it('checkpoint-result tells each listed live room', async () => {
    const a = open();
    await a.synced;
    const res = await internal(server, 'POST', '/checkpoint-result', {
      classroomId: CLASSROOM_ID,
      docs: [
        { kind: 'page', id: PAGE, commit: 'abc123', at: '2026-10-04T03:00:00.000Z' },
        { kind: 'page', id: 'not-open', at: '2026-10-04T03:00:00.000Z', error: 'x' },
      ],
    });
    expect(res.body).toEqual({ broadcast: 1 });
    await waitFor(() => a.stateless.length > 0, 3000, 'stateless');
    expect(a.stateless[0]).toEqual({
      type: 'checkpoint',
      commit: 'abc123',
      at: '2026-10-04T03:00:00.000Z',
    });
  });

  it('meta-changed broadcasts the new title and width', async () => {
    const a = open();
    await a.synced;
    await internal(server, 'POST', `/page/${PAGE}/meta-changed`, { title: 'Week 3', width: 3 });
    await waitFor(() => a.stateless.length > 0, 3000, 'stateless');
    expect(a.stateless[0]).toEqual({ type: 'page-meta', title: 'Week 3', width: 3 });
  });
});

describe('snapshot checkpoint fields', () => {
  it('returns lastCheckpointAt / lastCheckpointError from the row', async () => {
    expect(await snapshot()).toMatchObject({ lastCheckpointAt: null, lastCheckpointError: null });
    const a = open();
    await a.synced;
    const row = server.store.rows.get(`page:${PAGE}`)!;
    row.last_checkpoint_at = new Date('2026-10-04T03:00:00.000Z');
    row.last_checkpoint_error = 'push-rejected: protected branch';
    expect(await snapshot()).toMatchObject({
      lastCheckpointAt: '2026-10-04T03:00:00.000Z',
      lastCheckpointError: 'push-rejected: protected branch',
    });
  });
});

describe('legacy cover', () => {
  it('seeds the DB-only cover into meta.coverImage', async () => {
    server.world.pages.set(PAGE, {
      ...makePage(PAGE),
      header_image_url: 'https://cdn.example/cover.png',
      header_image_position: null,
    });
    const snap = (await snapshot()) as unknown as { content: { coverImage: unknown } };
    expect(snap.content.coverImage).toEqual({ url: 'https://cdn.example/cover.png', position: 50 });
  });

  it('prefers content.json’s cover', async () => {
    server.world.pages.set(PAGE, { ...makePage(PAGE), header_image_url: 'https://cdn/old.png' });
    server.world.content.set(PAGE, {
      blocks: [paragraph('p1', 'One')],
      coverImage: { url: 'assets/new.png', position: 10 },
    });
    const snap = (await snapshot()) as unknown as { content: { coverImage: unknown } };
    expect(snap.content.coverImage).toEqual({ url: 'assets/new.png', position: 10 });
  });
});

describe('restart', () => {
  it('a shutdown flushes pending stores; the restarted server serves the same state', async () => {
    await server.close();
    server = await startServer({ storeDebounceMs: 60_000 });
    populate(server);
    const a = open();
    await a.synced;
    a.doc.transact(() => textOf(a.doc, 'p1').insert(3, ' survives'));
    await waitFor(() => server.runtime.hasUnstoredChanges('page', PAGE), 3000, 'change');
    expect(server.store.storeCalls).toBe(0);

    // What SIGTERM runs (stopOnSignals → destroy → flushPendingStores).
    const { store, world } = server;
    await server.close();
    expect(store.storeCalls).toBeGreaterThan(0);
    a.destroy();

    server = await startServer({ store, world });
    populate(server);
    const b = open();
    await b.synced;
    expect(plain(b.doc, 'p1')).toBe('One survives');
  });
});

describe('production config', () => {
  const base = { NODE_ENV: 'production', COLLAB_INTERNAL_SECRET: 'real-secret' };
  it('refuses to start without TRIGGER_SECRET_KEY', () => {
    expect(() => loadConfig(base)).toThrow(/TRIGGER_SECRET_KEY/);
    expect(() => loadConfig({ ...base, TRIGGER_SECRET_KEY: 'tr_prod_x' })).not.toThrow();
  });
  it('refuses the development secret', () => {
    expect(() =>
      loadConfig({
        ...base,
        TRIGGER_SECRET_KEY: 'tr_prod_x',
        COLLAB_INTERNAL_SECRET: 'classmoji-collab-dev-secret',
      })
    ).toThrow(/COLLAB_INTERNAL_SECRET/);
  });
});
