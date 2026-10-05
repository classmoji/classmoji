/**
 * `expect_since`: an agent's live pin judged on the collab server, per block
 * (page) or slide (deck), against what THAT agent was shown — so a read
 * served through one MCP machine and an apply through another (no MCP state
 * at all) behave exactly like one process. Also the view store's rules and
 * byte cap.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { Role } from '@prisma/client';
import { deckSlides, roomName } from '@classmoji/collab';
import { pageView, type ItemView } from '@classmoji/collab/hash';
import { FRAGMENT } from '@classmoji/page-schema';
import type { DeckJson } from '@classmoji/services/slides';

import { AgentViews } from '../src/agentViews.ts';
import { createDeckAdapter, type DeckRecord } from '../src/adapters/deck.ts';
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
const AGENT = { userId: 'teacher-1', name: 'Ada', agentSession: 'sess-a' };
const PERSON = { userId: 'teacher-2', name: 'Grace' };

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

let server: TestServer;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await server?.close();
});

type Snap = { epoch: number; version: number; content: { blocks: Array<{ id: string }> } };

/**
 * A stateless "MCP machine": every call carries everything it needs, nothing
 * is kept between calls — so machine A's read and machine B's apply share
 * nothing but the collab server.
 */
const machine = (viewer = AGENT) => ({
  async read(kind = 'page', id = PAGE): Promise<Snap> {
    const session = viewer.agentSession ? `&session=${viewer.agentSession}` : '';
    const res = await internal(
      server,
      'GET',
      `/${kind}/${id}/snapshot?viewer=${viewer.userId}${session}`
    );
    expect(res.status).toBe(200);
    return res.body as unknown as Snap;
  },
  apply(ops: unknown[], pin: { epoch: number; version: number } | null, kind = 'page', id = PAGE) {
    return internal(server, 'POST', `/${kind}/${id}/ops`, {
      actor: viewer,
      ops,
      ...(pin ? { expect_since: pin } : { remember: true }),
    });
  },
});

/** Someone else's edit, stored as its own version. */
async function personEdits(fn: (doc: Y.Doc) => void, kind: 'page' | 'deck' = 'page', id = PAGE) {
  await server.runtime.withLiveEdit(kind, id, PERSON, ctx => ctx.transact(fn));
}

const update = (id: string, text: string) => ({
  op: 'update',
  id,
  block: { type: 'paragraph', content: text },
});

describe('expect_since on pages', () => {
  beforeEach(async () => {
    server = await startServer();
    server.world.pages.set(PAGE, makePage(PAGE));
    server.world.content.set(PAGE, {
      blocks: [paragraph('p1', 'One'), paragraph('p2', 'Two'), paragraph('p3', 'Three')],
    });
    server.world.roles.set(`teacher-1:${CLASSROOM_ID}`, 'TEACHER');
    server.world.roles.set(`teacher-2:${CLASSROOM_ID}`, 'OWNER');
    server.sessions.names.set('teacher-1', 'Ada');
  });

  it('read on machine A, apply on machine B: typing elsewhere (stored) does not refuse', async () => {
    const pin = await machine().read();
    await personEdits(doc => textOf(doc, 'p2').insert(0, 'typed '));
    const res = await machine().apply([update('p1', 'One, edited')], pin);
    expect(res.status).toBe(200);
    expect(res.body.version).toBeGreaterThan(pin.version);
  });

  it('typing elsewhere that is not stored yet does not refuse either', async () => {
    const person = connect(server, roomName('page', PAGE, 1), { userId: 'teacher-2' });
    clients.push(person);
    await person.synced;
    const pin = await machine().read();
    person.doc.transact(() => textOf(person.doc, 'p2').insert(0, 'live '));
    await waitFor(
      () => {
        const doc = server.runtime.loadedDocument('page', PAGE);
        return !!doc && textOf(doc, 'p2').toString().startsWith('live');
      },
      3000,
      'typing on the server'
    );
    const res = await machine().apply([update('p1', 'One, edited')], pin);
    expect(res.status).toBe(200);
  });

  it('a change to the block the ops touch is refused as block-changed, nothing applied', async () => {
    const pin = await machine().read();
    await personEdits(doc => textOf(doc, 'p1').insert(0, 'mine '));
    const res = await machine().apply([update('p1', 'agent'), update('p2', 'agent')], pin);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'block-changed', changedIds: ['p1'] });
    const now = await machine().read();
    expect(JSON.stringify(now.content.blocks)).toContain('Two');
  });

  it('a pin this agent was never shown is unknown-version (another agent, or no viewer: a render)', async () => {
    const other = await machine({ ...AGENT, agentSession: 'sess-b' }).read();
    const mine = await machine().apply([update('p1', 'x')], other);
    expect(mine.status).toBe(409);
    expect(mine.body).toMatchObject({
      error: 'unknown-version',
      current: { epoch: 1, version: other.version },
    });

    const render = await internal(server, 'GET', `/page/${PAGE}/snapshot`);
    const viaRender = await machine().apply([update('p1', 'x')], {
      epoch: 1,
      version: (render.body as unknown as Snap).version,
    });
    expect(viaRender.status).toBe(409);
    expect(viaRender.body.error).toBe('unknown-version');
  });

  it('a pin from another epoch is stale-epoch', async () => {
    const pin = await machine().read();
    const res = await machine().apply([update('p1', 'x')], { ...pin, epoch: pin.epoch + 1 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('stale-epoch');
  });

  it('replace_all needs every top-level block unchanged since the read', async () => {
    const pin = await machine().read();
    await personEdits(doc => textOf(doc, 'p3').insert(0, 'x'));
    const res = await machine().apply(
      [{ op: 'replace_all', blocks: [paragraph('p9', 'new')] }],
      pin
    );
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'block-changed', changedIds: ['p3'] });
  });

  it('an insert after a block deleted since the read is refused', async () => {
    const pin = await machine().read();
    await server.runtime.withLiveEdit('page', PAGE, PERSON, (ctx, adapter) =>
      adapter.applyOps(ctx, adapter.parseOps([{ op: 'delete', id: 'p3' }]))
    );
    const res = await machine().apply(
      [{ op: 'insert', blocks: [{ type: 'paragraph', content: 'n' }], position: { after: 'p3' } }],
      pin
    );
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'block-changed', changedIds: ['p3'] });
  });

  it("the apply's new version is a pin too: a person's edit before the apply is still caught", async () => {
    const pin = await machine().read();
    // Between the read and the apply someone edits p2; the agent never saw it.
    await personEdits(doc => textOf(doc, 'p2').insert(0, 'unseen '));
    const first = await machine().apply([update('p1', 'agent 1')], pin);
    expect(first.status).toBe(200);
    const next = { epoch: first.body.epoch as number, version: first.body.version as number };
    // p1 (the agent's own write) may be edited again on the new pin…
    expect((await machine().apply([update('p1', 'agent 2')], next)).status).toBe(200);
    // …p2 (changed before the apply, never read) is refused…
    const p2 = await machine().apply([update('p2', 'agent')], next);
    expect(p2.status).toBe(409);
    expect(p2.body).toEqual({ error: 'block-changed', changedIds: ['p2'] });
    // …until the agent re-reads.
    const reread = await machine().read();
    expect((await machine().apply([update('p2', 'agent')], reread)).status).toBe(200);
  });

  it('a re-read at the apply version replaces the view the apply left', async () => {
    const pin = await machine().read();
    await personEdits(doc => textOf(doc, 'p2').insert(0, 'unseen '));
    const first = await machine().apply([update('p1', 'agent')], pin);
    const next = { epoch: 1, version: first.body.version as number };
    const reread = await machine().read();
    expect(reread.version).toBe(next.version);
    expect((await machine().apply([update('p2', 'agent')], next)).status).toBe(200);
  });

  it('a pure insert (no pin) leaves a per-block pin behind', async () => {
    const inserted = await machine().apply(
      [{ op: 'insert', blocks: [{ type: 'paragraph', content: 'n' }], position: { at: 'end' } }],
      null
    );
    expect(inserted.status).toBe(200);
    const pin = { epoch: 1, version: inserted.body.version as number };
    await personEdits(doc => textOf(doc, 'p2').insert(0, 'typed '));
    expect((await machine().apply([update('p1', 'agent')], pin)).status).toBe(200);
    const refused = await machine().apply([update('p2', 'agent')], pin);
    expect(refused.body).toEqual({ error: 'block-changed', changedIds: ['p2'] });
  });

  it('a cover set with remember leaves a per-block pin behind', async () => {
    const res = await internal(server, 'POST', `/page/${PAGE}/cover`, {
      actor: AGENT,
      coverImage: { url: 'pages/page-1/assets/a.png', position: 50 },
      remember: true,
    });
    expect(res.status).toBe(200);
    const pin = { epoch: 1, version: res.body.version as number };
    expect((await machine().apply([update('p1', 'agent')], pin)).status).toBe(200);
  });

  it('agents of different users never share a view', async () => {
    const pin = await machine().read();
    const res = await machine({ userId: 'teacher-2', name: 'Grace', agentSession: 'sess-a' }).apply(
      [update('p1', 'x')],
      pin
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('unknown-version');
  });

  it('refuses a malformed expect_since', async () => {
    const res = await internal(server, 'POST', `/page/${PAGE}/ops`, {
      actor: AGENT,
      ops: [update('p1', 'x')],
      expect_since: { epoch: '1', version: 2 },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid-expect-since');
  });
});

// ─── Decks ───────────────────────────────────────────────────────────────────

const DECK_ID = 'deck-1';
const DECK: DeckJson = {
  version: 1,
  theme: 'white',
  codeTheme: 'github',
  slides: [
    { id: 'aaaa0001', html: '<h1>One</h1>' },
    { id: 'aaaa0002', html: '<h2>Two</h2>' },
    { id: 'aaaa0003', children: [{ id: 'aaaa0004', html: '<p>child</p>' }] },
  ],
};

const SLIDE: DeckRecord = {
  id: DECK_ID,
  title: 'Deck',
  kind: 'DECK',
  content_path: 'slides/deck',
  classroom_id: CLASSROOM_ID,
  created_by: 'teacher-1',
  allow_team_edit: false,
  classroom: {
    id: CLASSROOM_ID,
    status: 'ACTIVE',
    collab_enabled: true,
    content_repo: 'content',
    git_organization: { login: 'org' },
  },
};

describe('expect_since on decks', () => {
  beforeEach(async () => {
    const roles: Record<string, Role> = { 'teacher-1': 'TEACHER', 'teacher-2': 'OWNER' };
    const deck = createDeckAdapter({
      findSlide: async id => (id === DECK_ID ? SLIDE : null),
      findRole: async userId => roles[userId] ?? null,
      loadDeck: async () => ({ deck: structuredClone(DECK), sha: 'main-sha', sha_source: 'deck' }),
      readBlob: async () => null,
      now: () => Date.now(),
    });
    server = await startServer({ deck });
  });

  const setHtml = (id: string, html: string) => (doc: Y.Doc) =>
    (deckSlides(doc).get(id) as Y.Map<unknown>).set('html', html);
  const read = () => machine().read('deck', DECK_ID);
  const apply = (ops: unknown[], pin: { epoch: number; version: number } | null) =>
    machine().apply(ops, pin, 'deck', DECK_ID);

  it('an edit to another slide does not refuse; one to the target does', async () => {
    const pin = await read();
    await personEdits(setHtml('aaaa0002', '<h2>typed</h2>'), 'deck', DECK_ID);
    expect((await apply([{ op: 'update', id: 'aaaa0001', html: '<h1>A</h1>' }], pin)).status).toBe(
      200
    );
    const refused = await apply([{ op: 'update', id: 'aaaa0002', html: '<h2>A</h2>' }], pin);
    expect(refused.body).toEqual({ error: 'block-changed', changedIds: ['aaaa0002'] });
  });

  it("a stack child's edit refuses a block op on its stack entry", async () => {
    const pin = await read();
    await personEdits(setHtml('aaaa0004', '<p>typed</p>'), 'deck', DECK_ID);
    const refused = await apply([{ op: 'update', id: 'aaaa0003', notes: 'n' }], pin);
    expect(refused.body).toEqual({ error: 'block-changed', changedIds: ['aaaa0003'] });
  });

  it('a block op is judged on the slide holding the block', async () => {
    const pin = await read();
    await personEdits(setHtml('aaaa0002', '<h2>typed</h2>'), 'deck', DECK_ID);
    const box = { left: 10, top: 10, width: 100, height: 100 };
    const elsewhere = await apply(
      [{ op: 'block_add', slide: 'aaaa0001', type: 'svg', box, source: '<svg></svg>' }],
      pin
    );
    expect(elsewhere.status).toBe(200);
    const there = await apply(
      [{ op: 'block_add', slide: 'aaaa0002', type: 'svg', box, source: '<svg></svg>' }],
      pin
    );
    expect(there.body).toEqual({ error: 'block-changed', changedIds: ['aaaa0002'] });
  });

  it('reorder is refused when someone moved slides since the read', async () => {
    const pin = await read();
    await server.runtime.withLiveEdit('deck', DECK_ID, PERSON, (ctx, adapter) =>
      adapter.applyOps(
        ctx,
        adapter.parseOps([{ op: 'move', id: 'aaaa0002', position: { at: 'start' } }])
      )
    );
    const res = await apply([{ op: 'reorder', order: ['aaaa0003', 'aaaa0001', 'aaaa0002'] }], pin);
    expect(res.status).toBe(409);
    expect((res.body.changedIds as string[]).includes('__order__')).toBe(true);
  });

  it('reorder applies when only slide content changed since the read', async () => {
    const pin = await read();
    await personEdits(setHtml('aaaa0002', '<h2>typed</h2>'), 'deck', DECK_ID);
    const res = await apply([{ op: 'reorder', order: ['aaaa0003', 'aaaa0001', 'aaaa0002'] }], pin);
    expect(res.status).toBe(200);
  });

  it('set_theme is refused when someone changed the theme since the read', async () => {
    const pin = await read();
    await server.runtime.withLiveEdit('deck', DECK_ID, PERSON, (ctx, adapter) =>
      adapter.applyOps(ctx, adapter.parseOps([{ op: 'set_theme', theme: 'black' }]))
    );
    const res = await apply([{ op: 'set_theme', code_theme: 'monokai' }], pin);
    expect(res.body).toEqual({ error: 'block-changed', changedIds: ['__meta__'] });
    const fresh = await read();
    expect((await apply([{ op: 'set_theme', code_theme: 'monokai' }], fresh)).status).toBe(200);
  });
});

// ─── The view store ──────────────────────────────────────────────────────────

describe('AgentViews', () => {
  const view = (n: number, tag = 'a'): ItemView =>
    pageView({
      blocks: Array.from({ length: n }, (_, i) => paragraph(`b${i}`, `${tag}${i}`)),
    });
  const key = (version: number, userId = 'u1') => ({
    userId,
    session: 's',
    kind: 'page',
    docId: 'd',
    epoch: 1,
    version,
  });

  it('keeps the first read, lets a read replace an apply view, never lets an apply replace', () => {
    const views = new AgentViews();
    const first = view(2, 'first');
    views.remember(key(1), first, 'read');
    views.remember(key(1), view(2, 'second'), 'read');
    expect(views.recall(key(1))).toBe(first);
    views.remember(key(1), view(2, 'apply'), 'apply');
    expect(views.recall(key(1))).toBe(first);

    const applied = view(2, 'apply');
    views.remember(key(2), applied, 'apply');
    const reread = view(2, 'reread');
    views.remember(key(2), reread, 'read');
    expect(views.recall(key(2))).toBe(reread);
  });

  it('a repeat read keeps the first view but extends its life', () => {
    let now = 0;
    const views = new AgentViews({ ttlMs: 1000, now: () => now });
    const first = view(1, 'first');
    views.remember(key(1), first, 'read');
    now = 900;
    views.remember(key(1), view(1, 'again'), 'read');
    now = 1500;
    expect(views.recall(key(1))).toBe(first);
  });

  it('expires after the TTL', () => {
    let now = 0;
    const views = new AgentViews({ ttlMs: 1000, now: () => now });
    views.remember(key(1), view(1), 'read');
    now = 1001;
    expect(views.recall(key(1))).toBeNull();
    expect(views.size.entries).toBe(0);
  });

  it('evicts least recently used views to stay under its byte cap', () => {
    const views = new AgentViews({ maxBytes: 70_000 });
    for (let v = 1; v <= 10; v++) views.remember(key(v), view(50, `v${v}`), 'read');
    const { bytes, entries } = views.size;
    expect(bytes).toBeLessThanOrEqual(70_000);
    expect(entries).toBeGreaterThan(1);
    expect(entries).toBeLessThan(10);
    expect(views.recall(key(10))).not.toBeNull();
    expect(views.recall(key(1))).toBeNull();
  });
});
