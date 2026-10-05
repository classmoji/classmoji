/**
 * Agents in awareness (server.ts, agent presence): one entry per agent
 * session, labelled and coloured per session; what each op batch touched;
 * the page caret; staying for `agentPresenceMs` after the last op, sent again
 * every `agentRenewMs` and to a client that reconnects; `/cursor`.
 * Timings are shortened through the config.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { roomName, userColor, type CollabActor } from '@classmoji/collab';
import { FRAGMENT } from '@classmoji/page-schema';

import { pagePosition } from '../src/adapters/pageCursor.ts';
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

const PAGE = 'page-1';
const ROOM = roomName('page', PAGE, 1);

const paragraph = (id: string, text: string) => ({
  id,
  type: 'paragraph',
  props: { textColor: 'default', backgroundColor: 'default', textAlignment: 'left' },
  content: text ? [{ type: 'text', text, styles: {} }] : [],
  children: [],
});

const ada: CollabActor = { userId: 'teacher-1', name: 'Ada', agentSession: 'session-a' };
const adaToo: CollabActor = { userId: 'teacher-1', name: 'Ada', agentSession: 'session-b' };

interface AgentState {
  user: { name: string; color: string; agent: true };
  blockId?: string;
  slide?: string;
  touched?: { ids: string[]; seq: number };
  cursor?: { anchor: unknown; head: unknown };
  pointer?: { slide: string; x: number; y: number };
}

/** The agent entries a client sees, by clientID. */
function agents(client: TestClient): Map<number, AgentState> {
  const out = new Map<number, AgentState>();
  for (const [id, state] of client.provider.awareness!.getStates()) {
    const user = (state as { user?: { agent?: unknown } }).user;
    if (user?.agent === true) out.set(id, state as AgentState);
  }
  return out;
}
const agentList = (client: TestClient) => [...agents(client).values()];
const names = (client: TestClient) =>
  agentList(client)
    .map(a => a.user.name)
    .sort();

/** Where a caret's relative position lands in a client's doc: block id + offset in its text. */
function landing(client: TestClient, rel: unknown): { block: string | null; index: number } | null {
  const abs = Y.createAbsolutePositionFromRelativePosition(
    Y.createRelativePositionFromJSON(rel),
    client.doc
  );
  if (!abs) return null;
  let node: Y.AbstractType<unknown> | null = abs.type;
  while (node && !(node instanceof Y.XmlElement && node.getAttribute('id'))) {
    node = (node._item?.parent as Y.AbstractType<unknown> | null) ?? null;
  }
  return {
    block: node ? ((node as Y.XmlElement).getAttribute('id') ?? null) : null,
    index: abs.index,
  };
}

let server: TestServer;
const clients: TestClient[] = [];

function open(room = ROOM) {
  const client = connect(server, room);
  clients.push(client);
  return client;
}

async function start(config: Parameters<typeof startServer>[0] = {}) {
  server = await startServer(config);
  server.world.pages.set(PAGE, makePage(PAGE));
  server.world.content.set(PAGE, {
    blocks: [paragraph('p1', 'Hello world'), paragraph('p2', 'Second')],
  });
  server.world.roles.set(`teacher-1:${CLASSROOM_ID}`, 'TEACHER');
}

const ops = (actor: CollabActor, list: unknown[]) =>
  internal(server, 'POST', `/page/${PAGE}/ops`, { actor, ops: list });

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await server?.close();
});

describe('what an op batch touched', () => {
  beforeEach(() => start({ config: { agentTouchMs: 60_000 } }));

  it('lists inserted and updated blocks (not deleted ones) and numbers each batch', async () => {
    const a = open();
    await a.synced;
    const res = await ops(ada, [
      { op: 'insert', blocks: [paragraph('new-1', 'Fresh')], position: { after: 'p1' } },
      { op: 'update', id: 'p2', block: paragraph('p2', 'Second, edited') },
      { op: 'delete', id: 'p1' },
    ]);
    expect(res.status).toBe(200);
    await waitFor(() => agentList(a)[0]?.touched?.seq === 1, 3000, 'first batch');
    expect(agentList(a)[0]).toMatchObject({
      user: { name: 'Ada (agent)', agent: true },
      touched: { ids: ['new-1', 'p2'], seq: 1 },
      blockId: 'p2',
    });

    // While the next batch runs, the last one's list is still there…
    const seen: Array<AgentState['touched']> = [];
    a.provider.awareness!.on('change', () => seen.push(agentList(a)[0]?.touched));
    await ops(ada, [{ op: 'move', id: 'new-1', position: { at: 'end' } }]);
    await waitFor(() => agentList(a)[0]?.touched?.seq === 2, 3000, 'second batch');
    // …and only the batch's own result replaces it.
    expect(seen.every(t => t !== undefined)).toBe(true);
    expect(agentList(a)[0].touched).toEqual({ ids: ['new-1'], seq: 2 });
  });

  it('caps the list at the last 40 ids', async () => {
    const a = open();
    await a.synced;
    const blocks = Array.from({ length: 45 }, (_, i) => paragraph(`b${i}`, `Block ${i}`));
    await ops(ada, [{ op: 'insert', blocks, position: { at: 'end' } }]);
    await waitFor(() => !!agentList(a)[0]?.touched, 3000, 'touched');
    const ids = agentList(a)[0].touched!.ids;
    expect(ids).toHaveLength(40);
    expect(ids.at(-1)).toBe('b44');
  });

  it('a replace_all touches the new top-level blocks', async () => {
    const a = open();
    await a.synced;
    await ops(ada, [
      { op: 'replace_all', blocks: [paragraph('r1', 'One'), paragraph('r2', 'Two')] },
    ]);
    await waitFor(() => !!agentList(a)[0]?.touched, 3000, 'touched');
    expect(agentList(a)[0].touched!.ids).toEqual(['r1', 'r2']);
  });
});

describe('presence over time', () => {
  it('drops the touched list after agentTouchMs but keeps the agent', async () => {
    await start({ config: { agentTouchMs: 150 } });
    const a = open();
    await a.synced;
    await ops(ada, [{ op: 'update', id: 'p1', block: paragraph('p1', 'Hello there') }]);
    await waitFor(() => !!agentList(a)[0]?.touched, 3000, 'touched');
    await waitFor(() => agentList(a)[0] && !agentList(a)[0].touched, 3000, 'touched cleared');
    expect(names(a)).toEqual(['Ada (agent)']);
  });

  it('stays agentPresenceMs after its LAST op, then leaves', async () => {
    await start({ config: { agentPresenceMs: 600, agentRenewMs: 100 } });
    const a = open();
    await a.synced;
    await ops(ada, [{ op: 'update', id: 'p1', block: paragraph('p1', 'One') }]);
    await waitFor(() => names(a).length === 1, 3000, 'agent shown');
    await new Promise(r => setTimeout(r, 400));
    await ops(ada, [{ op: 'update', id: 'p1', block: paragraph('p1', 'Two') }]);
    await new Promise(r => setTimeout(r, 400));
    // 800 ms after the first op, 400 after the second: still here.
    expect(names(a)).toEqual(['Ada (agent)']);
    await waitFor(() => names(a).length === 0, 3000, 'agent gone');
  });

  it('sends the state again while present (a newer clock each time)', async () => {
    await start({ config: { agentRenewMs: 80 } });
    const a = open();
    await a.synced;
    await ops(ada, [{ op: 'update', id: 'p1', block: paragraph('p1', 'One') }]);
    await waitFor(() => agents(a).size === 1, 3000, 'agent shown');
    const [id] = agents(a).keys();
    const clock = () => a.provider.awareness!.meta.get(id)!.clock;
    const first = clock();
    await waitFor(() => clock() >= first + 3, 3000, 'renewals');
  });

  it('comes back to a client whose socket dropped and reconnected', async () => {
    await start({ config: { agentRenewMs: 60_000 } });
    const a = open();
    await a.synced;
    await ops(ada, [{ op: 'update', id: 'p1', block: paragraph('p1', 'One') }]);
    await waitFor(() => names(a).length === 1, 3000, 'agent shown');
    // The provider forgets other clients' states on a drop, but remembers
    // their clocks: the same state sent again would be ignored.
    const ws = (a.socket as unknown as { webSocket: { close(): void } | null }).webSocket;
    ws?.close();
    await waitFor(() => names(a).length === 0, 3000, 'states dropped with the socket');
    await waitFor(() => names(a).length === 1, 3000, 'agent back after the reconnect');
  });
});

describe('agent sessions', () => {
  beforeEach(() => start());

  it('gives each session of one person its own entry, colour and number', async () => {
    const a = open();
    await a.synced;
    await ops(ada, [{ op: 'update', id: 'p1', block: paragraph('p1', 'From A') }]);
    await waitFor(() => names(a).length === 1, 3000, 'first session');
    expect(names(a)).toEqual(['Ada (agent)']);
    const firstId = [...agents(a).keys()][0];

    await ops(adaToo, [{ op: 'update', id: 'p2', block: paragraph('p2', 'From B') }]);
    await waitFor(
      () => names(a).join() === 'Ada (agent 1),Ada (agent 2)',
      3000,
      'two numbered sessions'
    );
    const list = agentList(a);
    const colours = new Set(list.map(s => s.user.color));
    expect(colours.size).toBe(2);
    expect(colours.has(userColor('teacher-1'))).toBe(false);
    // The renamed session is a new awareness client (carets are named once per client).
    expect(agents(a).has(firstId)).toBe(false);

    // Without a session id an actor is one more presence of its own.
    await ops({ userId: 'teacher-1', name: 'Ada' }, [
      { op: 'update', id: 'p1', block: paragraph('p1', 'No session') },
    ]);
    await waitFor(() => names(a).length === 3, 3000, 'third');
    expect(names(a)).toEqual(['Ada (agent 1)', 'Ada (agent 2)', 'Ada (agent 3)']);
  });

  it('numbers by first activity and drops the number when one is left', async () => {
    await server.close();
    await start({ config: { agentPresenceMs: 500 } });
    const a = open();
    await a.synced;
    await ops(ada, [{ op: 'update', id: 'p1', block: paragraph('p1', 'A') }]);
    await new Promise(r => setTimeout(r, 300));
    await ops(adaToo, [{ op: 'update', id: 'p2', block: paragraph('p2', 'B') }]);
    await waitFor(() => names(a).length === 2, 3000, 'two');
    const byColour = new Map(agentList(a).map(s => [s.user.name, s.user.color]));
    // A expires first; B is alone again and plain "(agent)", in its own colour.
    await waitFor(() => names(a).join() === 'Ada (agent)', 3000, 'one left');
    expect(agentList(a)[0].user.color).toBe(byColour.get('Ada (agent 2)'));
  });
});

describe('the page caret', () => {
  beforeEach(() => start());

  it('ends up after the last text the ops wrote', async () => {
    const a = open();
    await a.synced;
    await ops(ada, [
      { op: 'update', id: 'p1', block: paragraph('p1', 'Hello there') },
      { op: 'insert', blocks: [paragraph('p3', 'Brand new')], position: { at: 'end' } },
    ]);
    await waitFor(() => !!agentList(a)[0]?.cursor, 3000, 'cursor');
    const { anchor, head } = agentList(a)[0].cursor!;
    expect(landing(a, head)).toEqual({ block: 'p3', index: 'Brand new'.length });
    expect(landing(a, anchor)).toEqual(landing(a, head));
  });

  it('stays after that text while someone types in front of it', async () => {
    const a = open();
    await a.synced;
    await ops(ada, [{ op: 'update', id: 'p1', block: paragraph('p1', 'Hello world!') }]);
    await waitFor(() => !!agentList(a)[0]?.cursor, 3000, 'cursor');
    const text = (() => {
      let found: Y.XmlText | null = null;
      const walk = (n: Y.XmlElement | Y.XmlFragment) => {
        for (const c of n.toArray()) {
          if (c instanceof Y.XmlElement) {
            if (c.getAttribute('id') === 'p1')
              found = (c.get(0) as Y.XmlElement).get(0) as Y.XmlText;
            else walk(c);
          }
        }
      };
      walk(a.doc.getXmlFragment(FRAGMENT));
      return found!;
    })();
    text.insert(0, '>> ');
    expect(landing(a, agentList(a)[0].cursor!.head)).toEqual({
      block: 'p1',
      index: '>> Hello world!'.length,
    });
  });

  it('/cursor places a caret or a selection, and changes no content', async () => {
    const a = open();
    await a.synced;
    const before = server.store.storeCalls;
    const res = await internal(server, 'POST', `/page/${PAGE}/cursor`, {
      actor: ada,
      page: { blockId: 'p1', offset: 6, selectTo: { offset: 11 } },
    });
    expect(res).toEqual({ status: 200, body: { shown: true } });
    await waitFor(() => !!agentList(a)[0]?.cursor, 3000, 'cursor');
    const state = agentList(a)[0];
    expect(state.blockId).toBe('p1');
    expect(state.touched).toBeUndefined();
    expect(landing(a, state.cursor!.anchor)).toEqual({ block: 'p1', index: 6 });
    expect(landing(a, state.cursor!.head)).toEqual({ block: 'p1', index: 11 });

    // Into another block, at its start.
    await internal(server, 'POST', `/page/${PAGE}/cursor`, {
      actor: ada,
      page: { blockId: 'p1', at: 'end', selectTo: { blockId: 'p2', at: 'start' } },
    });
    await waitFor(() => landing(a, agentList(a)[0].cursor!.head)?.block === 'p2', 3000, 'moved');
    expect(landing(a, agentList(a)[0].cursor!.head)).toEqual({ block: 'p2', index: 0 });
    expect(landing(a, agentList(a)[0].cursor!.anchor)).toEqual({
      block: 'p1',
      index: 'Hello world'.length,
    });
    expect(server.store.storeCalls).toBe(before);
  });

  it('/cursor: 404 for an unknown block, 400 for a malformed body, nothing shown when no one is in', async () => {
    const a = open();
    await a.synced;
    const missing = await internal(server, 'POST', `/page/${PAGE}/cursor`, {
      actor: ada,
      page: { blockId: 'nope' },
    });
    expect(missing).toEqual({ status: 404, body: { error: 'not-found', what: 'block' } });
    for (const page of [{}, { blockId: 'p1', offset: -1 }, { blockId: 'p1', at: 'middle' }]) {
      const bad = await internal(server, 'POST', `/page/${PAGE}/cursor`, { actor: ada, page });
      expect(bad.status).toBe(400);
    }
    const noActor = await internal(server, 'POST', `/page/${PAGE}/cursor`, {
      page: { blockId: 'p1' },
    });
    expect(noActor.status).toBe(400);

    a.destroy();
    await waitFor(() => !server.runtime.isLive('page', PAGE), 3000, 'nobody in');
    const empty = await internal(server, 'POST', `/page/${PAGE}/cursor`, {
      actor: ada,
      page: { blockId: 'p1' },
    });
    expect(empty).toEqual({ status: 200, body: { shown: false } });
  });
});

describe('pagePosition', () => {
  it('counts an offset across the text nodes of a block and clamps it', () => {
    const doc = new Y.Doc();
    const group = new Y.XmlElement('blockGroup');
    doc.getXmlFragment(FRAGMENT).insert(0, [group]);
    const container = new Y.XmlElement('blockContainer');
    group.insert(0, [container]);
    container.setAttribute('id', 'b1');
    const para = new Y.XmlElement('paragraph');
    container.insert(0, [para]);
    const one = new Y.XmlText('abc');
    const mention = new Y.XmlElement('mention');
    const two = new Y.XmlText('def');
    para.insert(0, [one, mention, two]);

    const at = (offset?: number, edge?: 'start' | 'end') => {
      const rel = pagePosition(doc, {
        blockId: 'b1',
        ...(offset !== undefined ? { offset } : {}),
        ...(edge ? { at: edge } : {}),
      })!;
      const abs = Y.createAbsolutePositionFromRelativePosition(rel, doc)!;
      return [abs.type === one ? 'one' : abs.type === two ? 'two' : 'other', abs.index];
    };
    expect(at(1)).toEqual(['one', 1]);
    expect(at(4)).toEqual(['two', 1]);
    expect(at(99)).toEqual(['two', 3]);
    expect(at(undefined, 'start')).toEqual(['one', 0]);
    expect(at()).toEqual(['two', 3]);
    expect(pagePosition(doc, { blockId: 'missing' })).toBeNull();
  });
});

describe('decks', () => {
  /** Just enough of a deck adapter for presence: one deck with two slides. */
  function stubDeck(): CollabAdapter {
    return {
      kind: 'deck',
      schemaVersion: 1,
      authorize: async () => ({ ok: true, classroomId: CLASSROOM_ID, role: 'TEACHER' }),
      locate: async () => ({ classroomId: CLASSROOM_ID }),
      seed: async () => {
        const doc = new Y.Doc();
        doc.getMap('slides').set('s1', 1);
        doc.getMap('slides').set('s2', 1);
        return { doc, sourceSha: null, classroomId: CLASSROOM_ID };
      },
      snapshot: () => ({}) as never,
      parseOps: raw => raw as unknown[],
      applyOps: () => ({ touchedIds: ['s2'], touchedId: 's2' }),
      mergeExternal: async () => ({ sourceSha: null, conflicts: 0 }),
      hasItem: (doc, id) => doc.getMap('slides').has(id),
      ephemeralRoots: [],
    };
  }

  it('shows the slide a deck op touched and the slide /cursor points at', async () => {
    await start({ deck: stubDeck() });
    const room = roomName('deck', 'deck-1', 1);
    const client = connect(server, room, { schemaVersion: 1 });
    clients.push(client);
    await client.synced;
    await internal(server, 'POST', '/deck/deck-1/ops', { actor: ada, ops: [{ op: 'x' }] });
    await waitFor(() => agentList(client)[0]?.slide === 's2', 3000, 'touched slide');
    expect(agentList(client)[0].touched).toEqual({ ids: ['s2'], seq: 1 });

    const res = await internal(server, 'POST', '/deck/deck-1/cursor', { actor: ada, slide: 's1' });
    expect(res).toEqual({ status: 200, body: { shown: true } });
    await waitFor(() => agentList(client)[0]?.slide === 's1', 3000, 'pointed slide');
    expect(agentList(client)[0].cursor).toBeUndefined();

    const missing = await internal(server, 'POST', '/deck/deck-1/cursor', {
      actor: ada,
      slide: 'zz',
    });
    expect(missing).toEqual({ status: 404, body: { error: 'not-found', what: 'slide' } });
    const bad = await internal(server, 'POST', '/deck/deck-1/cursor', { actor: ada });
    expect(bad.status).toBe(400);
  });

  it("puts the agent's pointer arrow where it points, else the slide's centre", async () => {
    await start({ deck: stubDeck() });
    const room = roomName('deck', 'deck-1', 1);
    const client = connect(server, room, { schemaVersion: 1 });
    clients.push(client);
    await client.synced;
    const pointer = () => agentList(client)[0]?.pointer;

    // An op: the arrow goes to the centre of the slide it changed.
    await internal(server, 'POST', '/deck/deck-1/ops', { actor: ada, ops: [{ op: 'x' }] });
    await waitFor(() => pointer()?.slide === 's2', 3000, 'arrow on the changed slide');
    expect(pointer()).toEqual({ slide: 's2', x: 480, y: 350 });

    // /cursor with a spot (clamped onto the slide).
    let res = await internal(server, 'POST', '/deck/deck-1/cursor', {
      actor: ada,
      slide: 's2',
      x: 120.5,
      y: 9000,
    });
    expect(res).toEqual({ status: 200, body: { shown: true } });
    await waitFor(() => pointer()?.x === 120.5, 3000, 'arrow at the spot');
    expect(pointer()).toEqual({ slide: 's2', x: 120.5, y: 700 });

    // Another op on the same slide leaves it where it pointed.
    await internal(server, 'POST', '/deck/deck-1/ops', { actor: ada, ops: [{ op: 'x' }] });
    await waitFor(() => agentList(client)[0]?.touched?.seq === 2, 3000, 'second batch');
    expect(pointer()).toEqual({ slide: 's2', x: 120.5, y: 700 });

    // /cursor without a spot: the centre of that slide.
    res = await internal(server, 'POST', '/deck/deck-1/cursor', { actor: ada, slide: 's1' });
    expect(res.status).toBe(200);
    await waitFor(() => pointer()?.slide === 's1', 3000, 'arrow on s1');
    expect(pointer()).toEqual({ slide: 's1', x: 480, y: 350 });

    for (const body of [
      { actor: ada, slide: 's1', x: 'a' },
      { actor: ada, slide: 's1', y: '5' },
      { actor: ada, slide: 's1', x: true },
    ]) {
      expect((await internal(server, 'POST', '/deck/deck-1/cursor', body)).status).toBe(400);
    }
  });
});
