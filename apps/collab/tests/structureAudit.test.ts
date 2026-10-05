/**
 * Structural edits in the audit log: the slides a transaction inserted,
 * deleted or moved, read from its events, and the UPDATE row the server
 * writes for a person's structural edit (agents' ops are audited by MCP).
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  applyLocalStructure,
  deckSlides,
  deckToYDoc,
  deleteSlide,
  insertSlide,
  moveSlide,
  roomName,
  structureOfDoc,
  planLocalStructure,
} from '@classmoji/collab';
import type { DeckJson } from '@classmoji/services/slides';

import type { CollabAdapter } from '../src/adapters/types.ts';
import {
  summarizeStructure,
  watchDeckStructure,
  type StructuralOp,
} from '../src/structureAudit.ts';
import {
  CLASSROOM_ID,
  connect,
  internal,
  startServer,
  waitFor,
  type TestClient,
  type TestServer,
} from './helpers.ts';

const DECK: DeckJson = {
  version: 1,
  theme: 'white',
  codeTheme: 'github',
  slides: [
    { id: 'aaaa0001', html: '<h1>One</h1>' },
    { id: 'aaaa0002', html: '<h2>Two</h2>' },
    { id: 'aaaa0003', html: '<h2>Three</h2>' },
    { id: 'stack001', children: [{ id: 'aaaa0004', html: '<p>child</p>' }] },
  ],
};

function recorder(doc: Y.Doc) {
  const watch = watchDeckStructure(doc);
  const seen: StructuralOp[][] = [];
  doc.on('afterTransaction', (tr: Y.Transaction) => seen.push(watch.opsOf(tr)));
  return seen;
}

describe('watchDeckStructure', () => {
  it('names the inserts, deletes and moves of each transaction, and nothing else', () => {
    const doc = deckToYDoc(DECK);
    const seen = recorder(doc);

    insertSlide(doc, 'new00001', { html: '<p>new</p>' }, { parent: null, after: 'aaaa0001' });
    expect(seen.at(-1)).toEqual([{ op: 'insert', id: 'new00001' }]);

    deleteSlide(doc, 'aaaa0002');
    expect(seen.at(-1)).toEqual([{ op: 'delete', id: 'aaaa0002' }]);

    moveSlide(doc, 'aaaa0003', { parent: null, after: null });
    expect(seen.at(-1)).toEqual([{ op: 'move', id: 'aaaa0003' }]);

    moveSlide(doc, 'aaaa0001', { parent: 'stack001', after: 'aaaa0004' });
    expect(seen.at(-1)).toEqual([{ op: 'move', id: 'aaaa0001', parent: 'stack001' }]);

    // Content, attributes and visibility are not structure.
    const map = deckSlides(doc).get('aaaa0003') as Y.Map<unknown>;
    doc.transact(() => map.set('html', '<h2>edited</h2>'));
    expect(seen.at(-1)).toEqual([]);
    doc.transact(() => map.set('hidden', true));
    expect(seen.at(-1)).toEqual([]);
  });

  it("reads the editor bridge's batched plan (a new slide's own placement is not a move)", () => {
    const doc = deckToYDoc(DECK);
    const seen = recorder(doc);
    const base = structureOfDoc(doc);
    const editor = structureOfDoc(doc);
    // The editor: one slide gone, one new at the top, the third moved last.
    editor.scopes.set(null, ['fresh001', 'aaaa0001', 'stack001', 'aaaa0003']);
    applyLocalStructure(doc, planLocalStructure(base, editor), {
      newSlide: () => ({ html: '<p>fresh</p>' }),
    });
    const ops = seen.at(-1) as StructuralOp[];
    expect(ops).toEqual(
      expect.arrayContaining([
        { op: 'insert', id: 'fresh001' },
        { op: 'delete', id: 'aaaa0002' },
      ])
    );
    // One slide moved (which one is the plan's choice); the new one is no move.
    expect(ops.filter(o => o.op === 'move')).toHaveLength(1);
    expect(ops).toHaveLength(3);
    expect(summarizeStructure(seen.at(-1) as StructuralOp[])).toContain('delete aaaa0002');
  });
});

describe('the audit row for a structural edit', () => {
  let server: TestServer;
  const clients: TestClient[] = [];

  function deckAdapter(): CollabAdapter {
    return {
      kind: 'deck',
      schemaVersion: 1,
      authorize: async () => ({ ok: true, classroomId: CLASSROOM_ID, role: 'TEACHER' }),
      locate: async () => ({ classroomId: CLASSROOM_ID }),
      seed: async () => ({ doc: deckToYDoc(DECK), sourceSha: null, classroomId: CLASSROOM_ID }),
      snapshot: () => ({}) as never,
      parseOps: raw => raw as unknown[],
      applyOps: ctx => {
        ctx.transact(doc => deckSlides(doc).delete('aaaa0003'));
        return { touchedIds: [] };
      },
      mergeExternal: async () => ({ sourceSha: null, conflicts: 0 }),
      hasItem: (doc, id) => deckSlides(doc).has(id),
      ephemeralRoots: ['locks'],
    };
  }

  afterEach(async () => {
    for (const client of clients.splice(0)) client.destroy();
    await server?.close();
  });

  it("records who deleted a slide from the editor; html typing and agents' ops add no row", async () => {
    server = await startServer({ deck: deckAdapter() });
    const client = connect(server, roomName('deck', 'deck-1', 1), { schemaVersion: 1 });
    clients.push(client);
    await client.synced;
    const updates = () => server.audit.entries.filter(e => e.action === 'UPDATE');

    const map = deckSlides(client.doc).get('aaaa0001') as Y.Map<unknown>;
    client.doc.transact(() => map.set('html', '<h1>typed</h1>'));
    deleteSlide(client.doc, 'aaaa0002');
    await waitFor(() => updates().length > 0, 3000, 'structural audit row');
    expect(updates()).toEqual([
      {
        userId: 'teacher-1',
        classroomId: CLASSROOM_ID,
        role: 'TEACHER',
        action: 'UPDATE',
        resourceType: 'SLIDES',
        resourceId: 'deck-1',
        data: {
          tool: 'live_editor',
          ops: [{ op: 'delete', id: 'aaaa0002' }],
          value: 'delete aaaa0002',
        },
      },
    ]);

    // An agent's op (a direct connection) is the MCP tool's to audit.
    const res = await internal(server, 'POST', '/deck/deck-1/ops', {
      actor: { userId: 'teacher-2', name: 'Agent' },
      ops: [{ op: 'x' }],
    });
    expect(res.status).toBe(200);
    await waitFor(() => !deckSlides(client.doc).has('aaaa0003'), 3000, 'agent delete synced');
    expect(updates()).toHaveLength(1);
  });
});
