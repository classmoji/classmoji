/**
 * Legacy pages (only `pages/<slug>/index.html`): converted on the first live
 * open, seeded with index.html's blob as `source_sha` (what the checkpoint
 * worker compares while content.json does not exist), stable block ids, outside
 * merges against the converted HTML, old page links scoped to the page's own
 * classroom, and the refusal that is left when the converter fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Y from 'yjs';
import { roomName } from '@classmoji/collab';
import { yDocToBlocks } from '@classmoji/page-schema/server';

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
const SAME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const MISSING = '33333333-3333-4333-8333-333333333333';
const actor = { userId: 'teacher-1', name: 'Ada' };

const legacyHtml = (second = 'Second paragraph') =>
  `<html><body><h1>Page ${PAGE}</h1><p class="subtitle">Old subtitle</p>` +
  `<h2>Intro</h2>` +
  `<p>See <a href="/oldslug/pages/${SAME}">same</a>, <a href="/oldslug/pages/${OTHER}">other</a>` +
  ` and <a href="/oldslug/pages/${MISSING}">gone</a>.</p>` +
  `<p>${second}</p>` +
  `</body></html>`;

interface Block {
  id: string;
  type: string;
  content?: { type: string; text?: string; href?: string; content?: { text?: string }[] }[];
  children?: Block[];
}

const textOf = (block: Block | undefined) =>
  (block?.content ?? [])
    .map(c => c.text ?? (c.content ?? []).map(x => x.text ?? '').join(''))
    .join('');

const byText = (blocks: Block[], text: string) => blocks.find(b => textOf(b) === text);

let server: TestServer;
const clients: TestClient[] = [];
function open(room = ROOM) {
  const client = connect(server, room);
  clients.push(client);
  return client;
}

async function snapshot(id = PAGE) {
  const res = await internal(server, 'GET', `/page/${id}/snapshot`);
  return res;
}

async function snapshotBlocks(id = PAGE): Promise<Block[]> {
  const res = await snapshot(id);
  expect(res.status).toBe(200);
  return (res.body.content as { blocks: Block[] }).blocks;
}

const liveBlocks = (doc: Y.Doc) => yDocToBlocks(doc) as Block[];

async function closeAll() {
  for (const client of clients.splice(0)) client.destroy();
  await waitFor(() => !server.runtime.loadedDocument('page', PAGE), 3000, 'unload');
}

beforeEach(async () => {
  server = await startServer({ storeDebounceMs: 30 });
  server.world.pages.set(PAGE, makePage(PAGE, { slug: 'cs52-26f' }));
  // A page of the same classroom, and one of another classroom.
  server.world.pages.set(SAME, makePage(SAME));
  server.world.pages.set(OTHER, {
    ...makePage(OTHER, { id: 'class-2' }),
    classroom_id: 'class-2',
  });
  server.world.content.set(PAGE, { html: legacyHtml() });
  server.world.blobs.set('html-sha', legacyHtml());
  server.world.roles.set(`teacher-1:${CLASSROOM_ID}`, 'TEACHER');
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await server.close();
});

describe('legacy HTML pages convert on the first live open', () => {
  it('a snapshot of an unopened legacy page converts it, stores nothing, and names blocks stably', async () => {
    const first = await snapshotBlocks();
    const second = await snapshotBlocks();
    expect(await server.store.get('page', PAGE)).toBeNull();

    // The title <h1> and subtitle live on the page row; the body is content.
    expect(first.some(b => textOf(b) === `Page ${PAGE}`)).toBe(false);
    expect(byText(first, 'Intro')?.type).toBe('heading');
    expect(byText(first, 'Second paragraph')?.type).toBe('paragraph');

    // Content-derived ids, the same on every read of the same HTML.
    expect(first.map(b => b.id)).toEqual(second.map(b => b.id));
    for (const b of first) expect(b.id).toMatch(/^b[0-9a-f]{10}$/);
  });

  it('the first open seeds with index.html’s blob as source_sha; a clean reopen is served from the row', async () => {
    const before = await snapshotBlocks();
    const conversionsBefore = server.world.conversions.length;

    const a = open();
    await a.synced;
    // The ids an agent read before anyone opened the page are the room's ids.
    expect(liveBlocks(a.doc).map(b => b.id)).toEqual(before.map(b => b.id));
    const row = (await server.store.get('page', PAGE))!;
    expect(row).toMatchObject({ epoch: 1, source_sha: 'html-sha', version: 0, pushed_version: 0 });
    expect(server.world.conversions.length).toBe(conversionsBefore + 1);

    await closeAll();
    const b = open();
    await b.synced;
    expect(b.authFailures).toEqual([]);
    expect((await server.store.get('page', PAGE))!.epoch).toBe(1);
    // Served from the row: no second conversion, no reseed.
    expect(server.world.conversions.length).toBe(conversionsBefore + 1);
  });

  it('after the first checkpoint the row tracks content.json, and a reopen does not reseed', async () => {
    const a = open();
    await a.synced;
    const res = await internal(server, 'POST', `/page/${PAGE}/ops`, {
      actor,
      ops: [
        {
          op: 'insert',
          blocks: [{ id: 'new1', type: 'paragraph', content: 'Added live' }],
          position: { at: 'end' },
        },
      ],
    });
    expect(res.status).toBe(200);
    await waitFor(() => (server.store.rows.get(`page:${PAGE}`)?.version ?? 0) > 0, 3000, 'store');
    await closeAll();

    // What content-checkpoint does: content.json created beside index.html,
    // its blob recorded as source_sha (contentCheckpointCore step 7).
    const stored = server.store.rows.get(`page:${PAGE}`)!;
    const blocks = await snapshotBlocks();
    Object.assign(stored, {
      pushed_version: stored.version,
      pushed_commit: 'c1',
      source_sha: 'json-sha',
      dirty_since: null,
    });
    server.world.content.set(PAGE, { blocks });
    server.world.headSha.set(PAGE, 'json-sha');

    const b = open();
    await b.synced;
    expect(b.authFailures).toEqual([]);
    expect((await server.store.get('page', PAGE))!.epoch).toBe(1);
    expect(byText(liveBlocks(b.doc), 'Added live')).toBeTruthy();
  });

  it('a clean, closed converted room reseeds once when content.json appears outside', async () => {
    const a = open();
    await a.synced;
    await closeAll();

    server.world.content.set(PAGE, {
      blocks: [
        {
          id: 'gh',
          type: 'paragraph',
          content: [{ type: 'text', text: 'From GitHub', styles: {} }],
        },
      ],
    });
    server.world.headSha.set(PAGE, 'json-sha');
    const stale = open();
    await waitFor(() => stale.authFailures.length > 0, 3000, 'refusal');
    expect(stale.authFailures[0]).toBe('stale-epoch');
    await closeAll();

    const room2 = roomName('page', PAGE, 2);
    const fresh = open(room2);
    await fresh.synced;
    expect(byText(liveBlocks(fresh.doc), 'From GitHub')).toBeTruthy();
    expect((await server.store.get('page', PAGE))!).toMatchObject({
      epoch: 2,
      source_sha: 'json-sha',
    });
    await closeAll();

    const again = open(room2);
    await again.synced;
    expect(again.authFailures).toEqual([]);
    expect((await server.store.get('page', PAGE))!.epoch).toBe(2);
  });
});

describe('outside writes to a converted page', () => {
  /** Live edit: the "Second paragraph" block becomes "Second, live". */
  async function editLive(a: TestClient) {
    const target = byText(liveBlocks(a.doc), 'Second paragraph')!;
    const res = await internal(server, 'POST', `/page/${PAGE}/ops`, {
      actor,
      ops: [
        {
          op: 'update',
          id: target.id,
          block: { type: 'paragraph', content: 'Second, live' },
        },
      ],
    });
    expect(res.status).toBe(200);
    await waitFor(() => !!byText(liveBlocks(a.doc), 'Second, live'), 3000, 'live edit');
  }

  /** content.json as an outside writer that read the live page makes it: Intro renamed. */
  async function theirsJson(): Promise<Block[]> {
    const blocks = structuredClone(await snapshotBlocks()) as Block[];
    const intro = byText(blocks, 'Intro')!;
    intro.content = [{ type: 'text', text: 'Intro, outside' }];
    // The outside writer read the page before the live edit.
    const second = blocks.find(b => textOf(b) === 'Second, live');
    if (second) second.content = [{ type: 'text', text: 'Second paragraph' }];
    return blocks;
  }

  it('content.json created while the room is open merges against the HTML at `before`', async () => {
    const a = open();
    await a.synced;
    await editLive(a);

    server.world.contentAt.set(`${PAGE}@b1`, { html: legacyHtml() });
    server.world.contentAt.set(`${PAGE}@c2`, { blocks: await theirsJson() });
    const res = await internal(server, 'POST', `/page/${PAGE}/external`, {
      sha: 'c2',
      before: 'b1',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ action: 'merged', conflicts: 0 });
    await waitFor(() => !!byText(liveBlocks(a.doc), 'Intro, outside'), 3000, 'theirs');
    expect(byText(liveBlocks(a.doc), 'Second, live')).toBeTruthy();
    expect((await server.store.get('page', PAGE))!.source_sha).toBe('blob-c2');
  });

  it('without `before`, the base is the index.html blob the room was seeded from', async () => {
    const a = open();
    await a.synced;
    await editLive(a);

    server.world.contentAt.set(`${PAGE}@c2`, { blocks: await theirsJson() });
    const res = await internal(server, 'POST', `/page/${PAGE}/external`, { sha: 'c2' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ action: 'merged', conflicts: 0 });
    await waitFor(() => !!byText(liveBlocks(a.doc), 'Intro, outside'), 3000, 'theirs');
    expect(byText(liveBlocks(a.doc), 'Second, live')).toBeTruthy();
  });

  it('an outside index.html push (theirs is HTML) converts and merges', async () => {
    const a = open();
    await a.synced;
    server.world.contentAt.set(`${PAGE}@b1`, { html: legacyHtml() });
    server.world.contentAt.set(`${PAGE}@c3`, { html: legacyHtml('Second, edited in HTML') });
    const res = await internal(server, 'POST', `/page/${PAGE}/external`, {
      sha: 'c3',
      before: 'b1',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ action: 'merged', conflicts: 0 });
    await waitFor(() => !!byText(liveBlocks(a.doc), 'Second, edited in HTML'), 3000, 'theirs html');
    expect(byText(liveBlocks(a.doc), 'Second paragraph')).toBeUndefined();
  });
});

describe('old page links', () => {
  it('resolve only to pages of this page’s own classroom, at its own address', async () => {
    const blocks = await snapshotBlocks();
    const links = blocks.flatMap(b => (b.content ?? []).filter(c => c.type === 'link'));
    const hrefs = Object.fromEntries(
      links.map(l => [(l.content ?? []).map(x => x.text).join(''), l.href])
    );
    expect(hrefs).toEqual({
      same: `/cs52-26f/${SAME}`,
      other: `/oldslug/pages/${OTHER}`,
      gone: `/oldslug/pages/${MISSING}`,
    });
  });

  it('are looked up in ONE query, scoped by the page row’s own classroom', async () => {
    await snapshotBlocks();
    expect(server.world.pageIdQueries).toEqual([
      { classroomId: CLASSROOM_ID, ids: expect.arrayContaining([SAME, OTHER, MISSING]) },
    ]);
    expect(server.world.pageIdQueries[0].ids).toHaveLength(3);
  });

  it('a page without uuid-shaped links asks nothing', async () => {
    server.world.content.set(PAGE, { html: '<p>No links here</p>' });
    await snapshotBlocks();
    expect(server.world.pageIdQueries).toEqual([]);
  });

  it('a failed lookup fails the conversion as unavailable (retried), never links left unresolved', async () => {
    server.world.fail.pageIds = true;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await snapshot();
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('unavailable');

    const a = open();
    await waitFor(() => a.authFailures.length > 0, 3000, 'refusal');
    expect(a.authFailures[0]).toBe('unavailable');
    expect(await server.store.get('page', PAGE)).toBeNull();
    a.destroy();

    // Back up: the same HTML converts to the blocks (and ids) a clean read gives.
    server.world.fail.pageIds = false;
    const blocks = await snapshotBlocks();
    const link = blocks
      .flatMap(b => b.content ?? [])
      .find(c => c.type === 'link' && (c.content ?? []).some(x => x.text === 'same'));
    expect(link?.href).toBe(`/cs52-26f/${SAME}`);
    error.mockRestore();
  });
});

describe('conversion failures and concurrency', () => {
  it('a converter failure is refused as legacy-html, on the socket and the internal API', async () => {
    server.world.fail.convert = true;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await snapshot();
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('legacy-html');

    const a = open();
    await waitFor(() => a.authFailures.length > 0, 3000, 'refusal');
    expect(a.authFailures[0]).toBe('legacy-html');
    expect(await server.store.get('page', PAGE)).toBeNull();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('legacy HTML could not be converted'),
      expect.any(Error)
    );
    error.mockRestore();
  });

  it('the blank-page index.html the webapp writes (plain text) seeds as one paragraph', async () => {
    server.world.content.set(PAGE, { html: 'Add your content here...\n' });
    const a = open();
    await a.synced;
    const blocks = liveBlocks(a.doc);
    expect(blocks.map(b => [b.type, textOf(b)])).toEqual([
      ['paragraph', 'Add your content here...'],
    ]);
  });

  it('concurrent conversions of different pages do not mix', async () => {
    const ids = ['legacy-a', 'legacy-b', 'legacy-c', 'legacy-d'];
    for (const id of ids) {
      server.world.pages.set(id, makePage(id));
      server.world.content.set(id, {
        html: `<html><body><h1>Page ${id}</h1><p>Body of ${id}</p></body></html>`,
      });
    }
    const results = await Promise.all(ids.map(id => snapshotBlocks(id)));
    results.forEach((blocks, i) => {
      expect(blocks.map(textOf).filter(Boolean)).toEqual([`Body of ${ids[i]}`]);
    });
  });
});
