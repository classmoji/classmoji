/**
 * Legacy pages (git holds only `pages/<slug>/index.html`, no content.json):
 * collab does not convert them. Every way into the room — a browser opening
 * it, a snapshot, agent ops, a cover, a preview merge — is refused with
 * `legacy-html` (422 on the internal API), and nothing is seeded, stored,
 * checkpointed or left loaded. They are converted by the operator script
 * (packages/tasks/src/scripts/convertLegacyPages.ts), not here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { roomName } from '@classmoji/collab';
import { SCHEMA_VERSION } from '@classmoji/page-schema';
import { pageContentToYDoc, yDocToBlocks } from '@classmoji/page-schema/server';

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

const PAGE = 'legacy-1';
const ROOM = roomName('page', PAGE, 1);
const actor = { userId: 'teacher-1', name: 'Ada' };
const LEGACY_HTML = `<html><body><h1>Page ${PAGE}</h1><p>Old body</p></body></html>`;

const paragraph = (id: string, text: string) => ({
  id,
  type: 'paragraph',
  content: [{ type: 'text', text, styles: {} }],
});

const textsOf = (doc: Y.Doc) =>
  (yDocToBlocks(doc) as { content?: { text?: string }[] }[]).map(b =>
    (b.content ?? []).map(c => c.text ?? '').join('')
  );

let server: TestServer;
const clients: TestClient[] = [];
function open(room = ROOM) {
  const client = connect(server, room);
  clients.push(client);
  return client;
}

/** Opens the room and waits for the refusal. */
async function refusedOpen(room = ROOM): Promise<string> {
  const client = open(room);
  await waitFor(() => client.authFailures.length > 0, 3000, 'refusal');
  return client.authFailures[0];
}

/** Nothing left behind: no row (or the marker untouched), no store, no checkpoint, nothing loaded. */
async function expectNothingWritten(marker?: { epoch: number }) {
  const row = await server.store.get('page', PAGE);
  if (marker) {
    expect(row).toMatchObject({ epoch: marker.epoch });
    expect(row!.state.byteLength).toBe(0);
  } else {
    expect(row).toBeNull();
  }
  expect(server.store.storeCalls).toBe(0);
  expect(server.checkpoints.calls).toEqual([]);
  await waitFor(() => !server.runtime.loadedDocument('page', PAGE), 3000, 'room unloaded');
}

beforeEach(async () => {
  server = await startServer({ storeDebounceMs: 30 });
  server.world.pages.set(PAGE, makePage(PAGE));
  server.world.content.set(PAGE, { html: LEGACY_HTML });
  server.world.roles.set(`teacher-1:${CLASSROOM_ID}`, 'TEACHER');
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await server.close();
});

describe('a page git still holds as legacy HTML is refused, never seeded', () => {
  it('opening it live is refused with legacy-html, every time, and nothing is written', async () => {
    expect(await refusedOpen()).toBe('legacy-html');
    expect(await refusedOpen()).toBe('legacy-html');
    expect(await refusedOpen()).toBe('legacy-html');
    await expectNothingWritten();
  });

  it('a snapshot is refused 422 legacy-html and stores nothing', async () => {
    const res = await internal(server, 'GET', `/page/${PAGE}/snapshot`);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('legacy-html');
    await expectNothingWritten();
  });

  it('agent ops, a cover and a preview merge are refused 422 legacy-html, writing nothing', async () => {
    const ops = await internal(server, 'POST', `/page/${PAGE}/ops`, {
      actor,
      ops: [{ op: 'insert', blocks: [paragraph('n1', 'New')], position: { at: 'end' } }],
    });
    expect([ops.status, ops.body.error]).toEqual([422, 'legacy-html']);

    const cover = await internal(server, 'POST', `/page/${PAGE}/cover`, {
      actor,
      coverImage: { url: 'assets/cover.png', position: 40 },
    });
    expect([cover.status, cover.body.error]).toEqual([422, 'legacy-html']);

    const merge = await internal(server, 'POST', `/page/${PAGE}/merge-preview`, {
      actor,
      base: { blocks: [paragraph('p1', 'One')] },
      theirs: { blocks: [paragraph('p1', 'One'), paragraph('p2', 'Two')] },
    });
    expect([merge.status, merge.body.error]).toEqual([422, 'legacy-html']);

    await expectNothingWritten();
  });

  it('a reseed marker stays a marker: opens and snapshots are refused, nothing is seeded into it', async () => {
    const doc = pageContentToYDoc({ blocks: [paragraph('p1', 'Converted once')] });
    await server.store.insertSeed({
      kind: 'page',
      doc_id: PAGE,
      classroom_id: CLASSROOM_ID,
      state: Y.encodeStateAsUpdate(doc),
      schema_version: SCHEMA_VERSION,
      source_sha: 'html-sha',
    });
    doc.destroy();
    const marker = (await server.store.markReseed('page', PAGE))!;
    expect(marker.epoch).toBe(2);

    expect(await refusedOpen(roomName('page', PAGE, 2))).toBe('legacy-html');
    const res = await internal(server, 'GET', `/page/${PAGE}/snapshot`);
    expect([res.status, res.body.error]).toEqual([422, 'legacy-html']);
    await expectNothingWritten(marker);
  });

  it('closing, resetting and renaming such a page still work (they never seed)', async () => {
    const meta = await internal(server, 'POST', `/page/${PAGE}/meta-changed`, { title: 'New' });
    expect(meta.status).toBe(200);
    const reset = await internal(server, 'POST', `/page/${PAGE}/reset`, { actor });
    expect(reset.status).toBe(200);
    const close = await internal(server, 'POST', `/page/${PAGE}/close`, { reason: 'closed' });
    expect(close.status).toBe(200);
    const deleted = await internal(server, 'POST', `/page/${PAGE}/close`, { reason: 'deleted' });
    expect(deleted.status).toBe(200);
    expect(await server.store.get('page', PAGE)).toBeNull();
    expect(server.store.storeCalls).toBe(0);
  });
});

describe('outside pushes and legacy HTML', () => {
  beforeEach(() => {
    server.world.content.set(PAGE, { blocks: [paragraph('p1', 'One')] });
    server.world.blobs.set('seed-sha', JSON.stringify({ blocks: [paragraph('p1', 'One')] }));
  });

  /** A live edit that is stored but not pushed: the doc is dirty. */
  async function editLive(a: TestClient) {
    const res = await internal(server, 'POST', `/page/${PAGE}/ops`, {
      actor,
      ops: [{ op: 'insert', blocks: [paragraph('n1', 'Live')], position: { at: 'end' } }],
    });
    expect(res.status).toBe(200);
    await waitFor(() => textsOf(a.doc).includes('Live'), 3000, 'live edit');
    await server.runtime.flush('page', PAGE);
    const row = (await server.store.get('page', PAGE))!;
    expect(row.version).toBeGreaterThan(row.pushed_version);
  }

  it('a push that leaves only index.html over unpushed edits: 422 legacy-html, kept, recorded', async () => {
    const a = open();
    await a.synced;
    await editLive(a);
    server.world.contentAt.set(`${PAGE}@c3`, { html: LEGACY_HTML });
    const res = await internal(server, 'POST', `/page/${PAGE}/external`, {
      sha: 'c3',
      before: 'b1',
    });
    expect([res.status, res.body.error]).toEqual([422, 'legacy-html']);
    expect(textsOf(server.runtime.loadedDocument('page', PAGE)!)).toEqual(['One', 'Live']);
    // Recorded with a reason the checkpoint worker honours: it stops re-notifying c3.
    expect((await server.store.get('page', PAGE))!.last_conflict).toMatchObject({
      sha: 'c3',
      ids: [],
      reason: 'legacy-html',
    });
  });

  it('a push that leaves only index.html with nothing unpushed: reseeded, the room closed', async () => {
    const a = open();
    await a.synced;
    server.world.contentAt.set(`${PAGE}@c3`, { html: LEGACY_HTML });
    const res = await internal(server, 'POST', `/page/${PAGE}/external`, {
      sha: 'c3',
      before: 'b1',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ action: 'reseeded', epoch: 2, reason: 'legacy-html' });
    await waitFor(() => a.closeCodes.includes(4409), 3000, 'room closed');
    const row = (await server.store.get('page', PAGE))!;
    expect(row.state.byteLength).toBe(0);
    expect(row.last_conflict ?? null).toBeNull();
  });

  it('a pushed content.json that does not parse, over unpushed edits: 422 invalid-content, recorded', async () => {
    const a = open();
    await a.synced;
    await editLive(a);
    server.world.contentAt.set(`${PAGE}@c5`, { corrupt: true });
    const res = await internal(server, 'POST', `/page/${PAGE}/external`, {
      sha: 'c5',
      before: 'b1',
    });
    // Final (4xx, not a 500 the worker would retry), and recorded so the
    // checkpoint worker stops re-notifying c5.
    expect([res.status, res.body.error]).toEqual([422, 'invalid-content']);
    expect(textsOf(server.runtime.loadedDocument('page', PAGE)!)).toEqual(['One', 'Live']);
    expect((await server.store.get('page', PAGE))!.last_conflict).toMatchObject({
      sha: 'c5',
      reason: 'invalid-content',
    });
  });

  it('a pushed content.json that does not parse, nothing unpushed: reseeded', async () => {
    const a = open();
    await a.synced;
    server.world.contentAt.set(`${PAGE}@c5`, { corrupt: true });
    const res = await internal(server, 'POST', `/page/${PAGE}/external`, {
      sha: 'c5',
      before: 'b1',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ action: 'reseeded', reason: 'invalid-content' });
    await waitFor(() => a.closeCodes.includes(4409), 3000, 'room closed');
  });

  describe('a clean row an older collab seeded from index.html, when content.json lands', () => {
    beforeEach(async () => {
      // The row as the old conversion left it: index.html's blob as source_sha.
      const doc = pageContentToYDoc({ blocks: [paragraph('p1', 'Converted once')] });
      await server.store.insertSeed({
        kind: 'page',
        doc_id: PAGE,
        classroom_id: CLASSROOM_ID,
        state: Y.encodeStateAsUpdate(doc),
        schema_version: SCHEMA_VERSION,
        source_sha: 'html-sha',
      });
      doc.destroy();
      // Git still holds index.html only while the room is open (served from the row).
      server.world.content.set(PAGE, { html: LEGACY_HTML });
      server.world.blobs.set('html-sha', LEGACY_HTML);
      server.world.contentAt.set(`${PAGE}@b1`, { html: LEGACY_HTML });
      server.world.contentAt.set(`${PAGE}@c2`, { blocks: [paragraph('p1', 'Converted once')] });
    });

    it('open with nothing unpushed: no merge base, so it is reseeded (nothing recorded)', async () => {
      const a = open();
      await a.synced;
      expect(textsOf(a.doc)).toEqual(['Converted once']);
      const res = await internal(server, 'POST', `/page/${PAGE}/external`, {
        sha: 'c2',
        before: 'b1',
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ action: 'reseeded', epoch: 2, reason: 'no-merge-base' });
      await waitFor(() => a.closeCodes.includes(4409), 3000, 'room closed');
      const row = (await server.store.get('page', PAGE))!;
      expect(row.state.byteLength).toBe(0);
      expect(row.last_conflict ?? null).toBeNull();
    });

    it('open with unpushed edits: kept, 409 no-merge-base, recorded', async () => {
      const a = open();
      await a.synced;
      await editLive(a);
      const res = await internal(server, 'POST', `/page/${PAGE}/external`, {
        sha: 'c2',
        before: 'b1',
      });
      expect([res.status, res.body.error]).toEqual([409, 'no-merge-base']);
      expect(textsOf(server.runtime.loadedDocument('page', PAGE)!)).toEqual([
        'Converted once',
        'Live',
      ]);
      expect((await server.store.get('page', PAGE))!.last_conflict).toMatchObject({
        sha: 'c2',
        reason: 'no-merge-base',
      });
    });
  });

  it('legacy HTML at `before` is no merge base: the blob the room descends from is used', async () => {
    const a = open();
    await a.synced;
    server.world.contentAt.set(`${PAGE}@b1`, { html: LEGACY_HTML });
    server.world.contentAt.set(`${PAGE}@c2`, {
      blocks: [paragraph('p1', 'One'), paragraph('p2', 'Two, outside')],
    });
    const res = await internal(server, 'POST', `/page/${PAGE}/external`, {
      sha: 'c2',
      before: 'b1',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ action: 'merged', conflicts: 0 });
    await waitFor(
      () => textsOf(a.doc).includes('Two, outside'),
      3000,
      'outside block in the live doc'
    );
    expect(textsOf(a.doc)).toEqual(['One', 'Two, outside']);
  });
});
