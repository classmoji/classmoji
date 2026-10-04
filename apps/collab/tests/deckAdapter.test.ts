/**
 * The deck adapter against fake lookups: authorization (today's slide edit
 * rule + classroom lock + flag), seeding, ops (applied id-aware; 409 on a slide
 * a person holds), external merges, and the server's lock bookkeeping.
 */
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { Role } from '@prisma/client';
import {
  LOCK_EXPIRE_IDLE_MS,
  acquireLock,
  cloneYDoc,
  deckSlides,
  deckToYDoc,
  getLock,
  markDisconnected,
  readSlideConflicts,
  roomName,
  yDocToDeck,
} from '@classmoji/collab';
import type { DeckJson } from '@classmoji/services/slides';
import { itemHash } from '@classmoji/collab/hash';

import { CollabHttpError, type LiveEditContext } from '../src/adapters/types.ts';
import {
  LOCK_ORIGIN,
  canEditDeck,
  writersOf,
  createDeckAdapter,
  type DeckAdapterDeps,
  type DeckRecord,
} from '../src/adapters/deck.ts';
import type { CollabDocRow } from '../src/store/types.ts';

const DECK: DeckJson = {
  version: 1,
  theme: 'white',
  codeTheme: 'github',
  slides: [
    { id: 'aaaa0001', html: '<h1>One</h1>' },
    { id: 'aaaa0002', html: '<h2>Two</h2>', notes: 'say hi' },
    {
      id: 'aaaa0003',
      children: [
        { id: 'aaaa0004', html: '<p>child</p>' },
        { id: 'aaaa0005', html: '<p>child 2</p>' },
      ],
    },
  ],
};

const SLIDE: DeckRecord = {
  id: 'slide-1',
  title: 'Deck',
  kind: 'DECK',
  content_path: 'slides/deck',
  classroom_id: 'class-1',
  created_by: 'assistant-own',
  allow_team_edit: false,
  classroom: {
    id: 'class-1',
    status: 'ACTIVE',
    collab_enabled: true,
    content_repo: 'content',
    git_organization: { login: 'org' },
  },
};

function makeDeps(overrides: Partial<DeckAdapterDeps> = {}, roles: Record<string, Role> = {}) {
  let now = 1_000_000;
  const blobs = new Map<string, string>([['base-sha', JSON.stringify(DECK)]]);
  const decks = new Map<string, DeckJson>([['main', DECK]]);
  const deps: DeckAdapterDeps & { tick(ms: number): void; decks: typeof decks } = {
    decks,
    tick(ms) {
      now += ms;
    },
    findSlide: async id => (id === SLIDE.id ? SLIDE : null),
    findRole: async userId => roles[userId] ?? null,
    loadDeck: async (_slide, { ref }) => {
      const deck = decks.get(ref ?? 'main');
      if (!deck) throw new Error('Slide content not found: slides/deck/index.html');
      return { deck: structuredClone(deck), sha: `${ref ?? 'main'}-sha`, sha_source: 'deck' };
    },
    readBlob: async (_slide, sha) => blobs.get(sha) ?? null,
    now: () => now,
    ...overrides,
  };
  return deps;
}

/** A live document with a Hocuspocus-like awareness (only `getStates` + events). */
function liveDoc(deck: DeckJson = DECK, connected: number[] = []) {
  const document = deckToYDoc(deck) as Y.Doc & { awareness: FakeAwareness };
  document.awareness = new FakeAwareness(connected);
  return document;
}

class FakeAwareness {
  private states: Map<number, unknown>;
  private listeners = new Set<(change: { added?: number[]; removed: number[] }) => void>();
  constructor(connected: number[]) {
    this.states = new Map(connected.map(id => [id, { user: { id: `u${id}` } }]));
  }
  getStates() {
    return this.states;
  }
  on(_event: 'update', cb: (change: { added?: number[]; removed: number[] }) => void) {
    this.listeners.add(cb);
  }
  off(_event: 'update', cb: (change: { added?: number[]; removed: number[] }) => void) {
    this.listeners.delete(cb);
  }
  reconnect(clientId: number) {
    this.states.set(clientId, { user: { id: `u${clientId}` } });
    for (const cb of this.listeners) cb({ added: [clientId], removed: [] });
  }
  disconnect(clientId: number) {
    this.states.delete(clientId);
    for (const cb of this.listeners) cb({ removed: [clientId] });
  }
}

function context(document: Y.Doc, row: Partial<CollabDocRow> | null = null): LiveEditContext {
  return {
    ref: {
      kind: 'deck',
      docId: SLIDE.id,
      classroomId: SLIDE.classroom_id,
      epoch: 1,
      room: roomName('deck', SLIDE.id, 1),
    },
    actor: { userId: 'agent-user', name: 'Agent' },
    document,
    row: row as CollabDocRow | null,
    transact(fn) {
      document.transact(() => fn(document), { source: 'local', context: { agent: true } });
    },
  };
}

const holder = (clientId: number) => ({
  userId: `u${clientId}`,
  name: `User ${clientId}`,
  color: '#123456',
  clientId,
});

describe('authorize', () => {
  const roles: Record<string, Role> = {
    owner: 'OWNER',
    teacher: 'TEACHER',
    'assistant-own': 'ASSISTANT',
    'assistant-other': 'ASSISTANT',
    student: 'STUDENT',
  };

  it("follows assertSlideAccess's edit rule", async () => {
    const adapter = createDeckAdapter(makeDeps({}, roles));
    const ok = async (userId: string) => (await adapter.authorize({ userId, docId: SLIDE.id })).ok;
    expect(await ok('owner')).toBe(true);
    expect(await ok('teacher')).toBe(true);
    expect(await ok('assistant-own')).toBe(true);
    expect(await ok('assistant-other')).toBe(false);
    expect(await ok('student')).toBe(false);
    expect(await ok('stranger')).toBe(false);
    expect(canEditDeck('ASSISTANT', { created_by: 'x', allow_team_edit: true }, 'y')).toBe(true);
    // Refusals of members carry their role (audited); strangers' do not.
    expect(await adapter.authorize({ userId: 'student', docId: SLIDE.id })).toMatchObject({
      ok: false,
      reason: 'forbidden',
      classroomId: 'class-1',
      role: 'STUDENT',
    });
    expect(await adapter.authorize({ userId: 'stranger', docId: SLIDE.id })).not.toHaveProperty(
      'role'
    );
    expect(await adapter.authorize({ userId: 'teacher', docId: SLIDE.id })).toMatchObject({
      ok: true,
      role: 'TEACHER',
    });
  });

  it('refuses unflagged classrooms, locked classrooms, and non-decks', async () => {
    const flagOff = createDeckAdapter(
      makeDeps(
        {
          findSlide: async () => ({
            ...SLIDE,
            classroom: { ...SLIDE.classroom, collab_enabled: false },
          }),
        },
        roles
      )
    );
    expect(await flagOff.authorize({ userId: 'owner', docId: SLIDE.id })).toMatchObject({
      ok: false,
      reason: 'collab-disabled',
    });
    const locked = createDeckAdapter(
      makeDeps(
        {
          findSlide: async () => ({
            ...SLIDE,
            classroom: { ...SLIDE.classroom, status: 'LOCKED' },
          }),
        },
        roles
      )
    );
    expect(await locked.authorize({ userId: 'teacher', docId: SLIDE.id })).toMatchObject({
      ok: false,
      reason: 'classroom-locked',
    });
    expect((await locked.authorize({ userId: 'owner', docId: SLIDE.id })).ok).toBe(true);
    const fileSlide = createDeckAdapter(
      makeDeps({ findSlide: async () => ({ ...SLIDE, kind: 'FILE' }) }, roles)
    );
    expect(await fileSlide.authorize({ userId: 'owner', docId: SLIDE.id })).toMatchObject({
      ok: false,
      reason: 'not-found',
    });
  });
});

describe('seed and snapshot', () => {
  it('seeds from deck.json and snapshots it back unchanged', async () => {
    const adapter = createDeckAdapter(makeDeps());
    const { doc, sourceSha, classroomId } = await adapter.seed({ docId: SLIDE.id });
    expect(sourceSha).toBe('main-sha');
    expect(classroomId).toBe('class-1');
    expect(JSON.stringify(adapter.snapshot(doc))).toBe(JSON.stringify(DECK));
  });

  it('a deck with no content is a clear 409', async () => {
    const deps = makeDeps();
    deps.decks.delete('main');
    await expect(createDeckAdapter(deps).seed({ docId: SLIDE.id })).rejects.toMatchObject({
      status: 409,
      body: { error: 'content-missing' },
    });
  });
});

describe('applyOps', () => {
  it('applies deckOps id-aware: a concurrent peer edit elsewhere survives', () => {
    const adapter = createDeckAdapter(makeDeps());
    const document = liveDoc();
    const peer = cloneYDoc(document);
    (deckSlides(peer).get('aaaa0002') as Y.Map<unknown>).set('html', '<h2>peer</h2>');

    const ops = adapter.parseOps([
      { op: 'update', id: 'aaaa0001', html: '<h1>Agent</h1>' },
      { op: 'insert', position: { after: 'aaaa0001' }, slides: [{ html: '<p>new</p>' }] },
      { op: 'move', id: 'aaaa0004', position: { after: 'aaaa0005' } },
    ]);
    adapter.applyOps(context(document), ops);
    Y.applyUpdate(document, Y.encodeStateAsUpdate(peer));

    const deck = yDocToDeck(document);
    expect(deck.slides[0].html).toBe('<h1>Agent</h1>');
    expect(deck.slides[1].html).toBe('<p>new</p>');
    expect(deck.slides[2].html).toBe('<h2>peer</h2>');
    expect(deck.slides[3].children?.map(c => c.id)).toEqual(['aaaa0005', 'aaaa0004']);
  });

  it('409 slide-locked on an update or delete of a slide a person holds', () => {
    const adapter = createDeckAdapter(makeDeps());
    const document = liveDoc(DECK, [42]);
    acquireLock(document, 'aaaa0004', holder(42), { now: 1_000_000 });
    adapter.attach(document);

    const attempt = (ops: unknown[]) => {
      try {
        adapter.applyOps(context(document), adapter.parseOps(ops));
        return null;
      } catch (err) {
        return err;
      }
    };
    const update = attempt([{ op: 'update', id: 'aaaa0004', html: '<p>x</p>' }]);
    expect(update).toBeInstanceOf(CollabHttpError);
    expect(update).toMatchObject({
      status: 409,
      body: { error: 'slide-locked', slideId: 'aaaa0004', holder: { clientId: 42 } },
    });
    // Deleting the stack takes the held child with it: refused too.
    expect(attempt([{ op: 'delete', id: 'aaaa0003' }])).toMatchObject({ status: 409 });
    // Nothing was written.
    expect(yDocToDeck(document).slides[2].children?.[0].html).toBe('<p>child</p>');
    // Other slides are fine.
    expect(attempt([{ op: 'update', id: 'aaaa0001', html: '<h1>ok</h1>' }])).toBeNull();
    // Moving the held slide is structural: allowed.
    expect(attempt([{ op: 'move', id: 'aaaa0004', position: { at: 'end' } }])).toBeNull();
  });

  it('a stale or disconnected holder does not block', () => {
    const deps = makeDeps();
    const adapter = createDeckAdapter(deps);
    const document = liveDoc(DECK, [42]);
    acquireLock(document, 'aaaa0001', holder(42), { now: deps.now() });
    adapter.attach(document);
    deps.tick(61_000);
    adapter.applyOps(
      context(document),
      adapter.parseOps([{ op: 'update', id: 'aaaa0001', html: 'x' }])
    );
    expect(yDocToDeck(document).slides[0].html).toBe('x');
  });

  it('bad ops are 400, impossible ops are 422', () => {
    const adapter = createDeckAdapter(makeDeps());
    expect(() => adapter.parseOps([{ op: 'nope' }])).toThrow(CollabHttpError);
    expect(() =>
      adapter.applyOps(liveCtx(), adapter.parseOps([{ op: 'update', id: 'missing', html: 'x' }]))
    ).toThrow(expect.objectContaining({ status: 422 }));
  });
});

function liveCtx() {
  return context(liveDoc());
}

describe('mergeExternal', () => {
  it('3-way merges an outside push into the live deck', async () => {
    const deps = makeDeps();
    deps.decks.set('push-sha', {
      ...DECK,
      slides: [{ id: 'aaaa0001', html: '<h1>From GitHub</h1>' }, ...DECK.slides.slice(1)],
    });
    const adapter = createDeckAdapter(deps);
    const document = liveDoc();
    // A live edit to another slide since the last push.
    (deckSlides(document).get('aaaa0002') as Y.Map<unknown>).set('html', '<h2>live</h2>');

    const result = await adapter.mergeExternal(context(document, { source_sha: 'base-sha' }), {
      sha: 'push-sha',
    });
    expect(result).toEqual({ sourceSha: 'push-sha-sha', conflicts: 0 });
    const deck = yDocToDeck(document);
    expect(deck.slides[0].html).toBe('<h1>From GitHub</h1>');
    expect(deck.slides[1].html).toBe('<h2>live</h2>');
  });

  it('a conflicted slide someone is editing keeps the live side', async () => {
    const deps = makeDeps();
    deps.decks.set('push-sha', {
      ...DECK,
      slides: [{ id: 'aaaa0001', html: '<h1>push</h1>' }, ...DECK.slides.slice(1)],
    });
    const adapter = createDeckAdapter(deps);
    const document = liveDoc(DECK, [7]);
    (deckSlides(document).get('aaaa0001') as Y.Map<unknown>).set('html', '<h1>typing</h1>');
    acquireLock(document, 'aaaa0001', holder(7), { now: deps.now() });
    adapter.attach(document);

    const result = await adapter.mergeExternal(context(document, { source_sha: 'base-sha' }), {
      sha: 'push-sha',
    });
    expect(result.conflicts).toBe(1);
    expect(yDocToDeck(document).slides[0].html).toBe('<h1>typing</h1>');
  });
});

describe('lock bookkeeping', () => {
  it('a disconnected holder keeps the slide for the grace period, store hooks skipped', () => {
    const deps = makeDeps();
    const adapter = createDeckAdapter(deps);
    const document = liveDoc(DECK, [5, 6]);
    acquireLock(document, 'aaaa0001', holder(5), { now: deps.now() });
    acquireLock(document, 'aaaa0002', holder(6), { now: deps.now() });
    adapter.attach(document);
    const origins: unknown[] = [];
    document.on('afterTransaction', tr => origins.push(tr.origin));
    document.awareness.disconnect(5);
    expect(getLock(document, 'aaaa0001')).toMatchObject({
      clientId: 5,
      disconnectedAt: deps.now(),
    });
    expect(origins).toEqual([LOCK_ORIGIN]);
    // Back within the grace: theirs again, unmarked.
    document.awareness.reconnect(5);
    expect(getLock(document, 'aaaa0001')).not.toHaveProperty('disconnectedAt');
    expect(getLock(document, 'aaaa0002')?.clientId).toBe(6);
    document.destroy();
  });

  /** An adapter whose process has been running for a while. */
  const longRunning = () => {
    const deps = makeDeps();
    const adapter = createDeckAdapter(deps);
    deps.tick(5 * 60_000);
    return { deps, adapter };
  };

  it('on load, a lock whose holder left long ago is cleared at once (stored times)', () => {
    const { deps, adapter } = longRunning();
    const document = liveDoc(DECK, [6]);
    acquireLock(document, 'aaaa0001', holder(5), { now: 0 }); // 5 left ages ago
    acquireLock(document, 'aaaa0002', holder(6), { now: deps.now() });
    adapter.attach(document);
    expect(getLock(document, 'aaaa0001')).toBeNull();
    expect(getLock(document, 'aaaa0002')).not.toBeNull();
    document.destroy();
  });

  it('on load, a holder gone within the grace keeps it until the grace (not a fresh one) ends', () => {
    vi.useFakeTimers();
    try {
      const { deps, adapter } = longRunning();
      const document = liveDoc(DECK, []);
      acquireLock(document, 'aaaa0001', holder(5), { now: deps.now() });
      markDisconnected(document, [5], deps.now() - 20_000); // dropped 20 s ago
      adapter.attach(document);
      expect(getLock(document, 'aaaa0001')).not.toBeNull();
      deps.tick(10_300);
      vi.advanceTimersByTime(10_300);
      expect(getLock(document, 'aaaa0001')).toBeNull();
      document.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('agent ops treat a gone holder past the grace as free, and clear the lock', () => {
    const { deps, adapter } = longRunning();
    const document = liveDoc(DECK, [6]);
    adapter.attach(document);
    // Holder 5 joined after load and left; its lock was marked 31 s ago.
    acquireLock(document, 'aaaa0001', holder(5), { now: deps.now() });
    markDisconnected(document, [5], deps.now() - 31_000);
    adapter.applyOps(
      context(document),
      adapter.parseOps([{ op: 'update', id: 'aaaa0001', html: 'x' }])
    );
    expect(yDocToDeck(document).slides[0].html).toBe('x');
    expect(getLock(document, 'aaaa0001')).toBeNull();
    document.destroy();
  });

  it('after a server restart, a holder not yet reconnected keeps the slide for the grace', () => {
    vi.useFakeTimers();
    try {
      // A fresh process (a deploy): the stored lock is old, nobody is connected yet.
      const deps = makeDeps();
      const adapter = createDeckAdapter(deps);
      const document = liveDoc(DECK, []);
      acquireLock(document, 'aaaa0001', holder(5), { now: deps.now() - 10 * 60_000 });
      adapter.attach(document);
      expect(getLock(document, 'aaaa0001')).not.toBeNull();
      // Agents may not write over it meanwhile.
      expect(() =>
        adapter.applyOps(
          context(document),
          adapter.parseOps([{ op: 'update', id: 'aaaa0001', html: 'x' }])
        )
      ).toThrow(expect.objectContaining({ status: 409 }));
      // The holder reconnects at 5 s: theirs, for good.
      deps.tick(5_000);
      vi.advanceTimersByTime(5_000);
      document.awareness.reconnect(5);
      deps.tick(60_000);
      vi.advanceTimersByTime(60_000);
      expect(getLock(document, 'aaaa0001')?.clientId).toBe(5);
      document.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('after a server restart, a holder who never returns loses the slide when the grace ends', () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      const adapter = createDeckAdapter(deps);
      const document = liveDoc(DECK, []);
      acquireLock(document, 'aaaa0001', holder(5), { now: deps.now() - 10 * 60_000 });
      adapter.attach(document);
      deps.tick(30_300);
      vi.advanceTimersByTime(30_300);
      expect(getLock(document, 'aaaa0001')).toBeNull();
      document.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('mergePreview', () => {
  const preview = (): DeckJson => ({
    ...DECK,
    slides: [
      { id: 'aaaa0001', html: '<h1>Preview one</h1>' },
      { id: 'pppp0001', html: '<p>added by the preview</p>' },
      ...DECK.slides.slice(1),
    ],
  });

  it('merges the preview into the live deck, keeping live edits elsewhere', () => {
    const adapter = createDeckAdapter(makeDeps());
    const document = liveDoc();
    (deckSlides(document).get('aaaa0002') as Y.Map<unknown>).set('html', '<h2>live</h2>');
    const result = adapter.mergePreview(context(document), { base: DECK, theirs: preview() });
    expect(result.conflicts).toEqual([]);
    const deck = yDocToDeck(document);
    expect(deck.slides.map(s => s.id)).toEqual(['aaaa0001', 'pppp0001', 'aaaa0002', 'aaaa0003']);
    expect(deck.slides[0].html).toBe('<h1>Preview one</h1>');
    expect(deck.slides[2].html).toBe('<h2>live</h2>');
  });

  it('conflicts apply nothing; resolutions settle them', () => {
    const adapter = createDeckAdapter(makeDeps());
    const document = liveDoc();
    (deckSlides(document).get('aaaa0001') as Y.Map<unknown>).set('html', '<h1>live one</h1>');
    const first = adapter.mergePreview(context(document), { base: DECK, theirs: preview() });
    expect(first.conflicts.map(c => c.id)).toEqual(['aaaa0001']);
    expect(yDocToDeck(document).slides.map(s => s.id)).not.toContain('pppp0001');

    const second = adapter.mergePreview(context(document), {
      base: DECK,
      theirs: preview(),
      resolutions: [{ id: 'aaaa0001', choose: 'theirs' }],
    });
    expect(second.conflicts).toEqual([]);
    expect(yDocToDeck(document).slides[0].html).toBe('<h1>Preview one</h1>');
  });

  it('409 slide-locked when the merge would change a slide a person holds', () => {
    const adapter = createDeckAdapter(makeDeps());
    const document = liveDoc(DECK, [9]);
    acquireLock(document, 'aaaa0001', holder(9), { now: 1_000_000 });
    adapter.attach(document);
    expect(() =>
      adapter.mergePreview(context(document), { base: DECK, theirs: preview() })
    ).toThrow(expect.objectContaining({ status: 409 }));
    expect(yDocToDeck(document).slides[0].html).toBe('<h1>One</h1>');
  });
});

describe('mergeExternal without a base', () => {
  it('refuses rather than merging against a made-up base', async () => {
    const deps = makeDeps();
    deps.decks.set('push-sha', DECK);
    const adapter = createDeckAdapter(deps);
    const document = liveDoc();
    await expect(
      adapter.mergeExternal(context(document, { source_sha: 'missing-sha' }), { sha: 'push-sha' })
    ).rejects.toMatchObject({ status: 409, body: { error: 'no-merge-base' } });
  });
});

describe('mergeExternal: bases, no-ops, held slides', () => {
  const pushed = (): DeckJson => ({
    ...DECK,
    slides: [{ id: 'aaaa0001', html: '<h1>From GitHub</h1>' }, ...DECK.slides.slice(1)],
  });

  it('uses the push’s before commit as the base when readable', async () => {
    const deps = makeDeps();
    deps.decks.set('before-sha', DECK);
    deps.decks.set('push-sha', pushed());
    const adapter = createDeckAdapter(deps);
    const document = liveDoc();
    (deckSlides(document).get('aaaa0002') as Y.Map<unknown>).set('html', '<h2>live</h2>');
    const result = await adapter.mergeExternal(context(document, {}), {
      sha: 'push-sha',
      before: 'before-sha',
    });
    expect(result.conflicts).toBe(0);
    const deck = yDocToDeck(document);
    expect(deck.slides[0].html).toBe('<h1>From GitHub</h1>');
    expect(deck.slides[1].html).toBe('<h2>live</h2>');
  });

  it('no-op when the pushed deck is what the live doc descends from', async () => {
    const deps = makeDeps();
    deps.decks.set('push-sha', pushed());
    const adapter = createDeckAdapter(deps);
    const document = liveDoc();
    const result = await adapter.mergeExternal(context(document, { source_sha: 'push-sha-sha' }), {
      sha: 'push-sha',
    });
    expect(result).toEqual({ sourceSha: 'push-sha-sha', conflicts: 0, noop: true });
    expect(yDocToDeck(document).slides[0].html).toBe('<h1>One</h1>');
  });

  it('a held slide keeps its live html even when only the push changed it', async () => {
    const deps = makeDeps();
    deps.decks.set('push-sha', pushed());
    const adapter = createDeckAdapter(deps);
    const document = liveDoc(DECK, [7]);
    acquireLock(document, 'aaaa0001', holder(7), { now: deps.now() });
    adapter.attach(document);
    const result = await adapter.mergeExternal(context(document, { source_sha: 'base-sha' }), {
      sha: 'push-sha',
    });
    expect(result.conflicts).toBe(1);
    expect(yDocToDeck(document).slides[0].html).toBe('<h1>One</h1>');
  });

  it('currentSourceSha is the deck file’s blob sha', async () => {
    const adapter = createDeckAdapter(makeDeps());
    expect(await adapter.currentSourceSha(SLIDE.id)).toBe('main-sha');
  });
});

describe('writersOf', () => {
  it("a connection's awareness clients and the inserting clients; null for server writes", () => {
    const document = deckToYDoc(DECK) as Y.Doc & { getClients?: (c: unknown) => Set<number> };
    const connection = {};
    document.getClients = c => (c === connection ? new Set([77]) : new Set());
    let seen: Set<number> | null | undefined;
    document.on('afterTransaction', tr => {
      seen = writersOf(document, tr);
    });
    const peer = cloneYDoc(document);
    peer.clientID = 88;
    (deckSlides(peer).get('aaaa0001') as Y.Map<unknown>).set('html', 'x');
    Y.applyUpdate(document, Y.encodeStateAsUpdate(peer), { source: 'connection', connection });
    expect([...(seen ?? [])].sort()).toEqual([77, 88]);
    document.transact(() => deckSlides(document).delete('aaaa0002'), { source: 'local' });
    expect(seen).toBeNull();
  });
});

describe('guarded ops', () => {
  it('checkExpect names the slides whose snapshot entry changed (or vanished)', () => {
    const adapter = createDeckAdapter(makeDeps());
    const document = liveDoc();
    const snap = adapter.snapshot(document);
    const hashOf = (id: string) => {
      const all = snap.slides.flatMap(s => [s, ...(s.children ?? [])]);
      return itemHash(all.find(s => s.id === id));
    };
    const expect_ = {
      aaaa0001: hashOf('aaaa0001'),
      aaaa0002: hashOf('aaaa0002'),
      aaaa0003: hashOf('aaaa0003'),
      gone0001: 'x',
    };
    (deckSlides(document).get('aaaa0002') as Y.Map<unknown>).set('html', '<h2>moved on</h2>');
    // A child edit changes its stack's entry too.
    (deckSlides(document).get('aaaa0004') as Y.Map<unknown>).set('html', '<p>new</p>');
    expect(adapter.checkExpect(document, expect_).sort()).toEqual(
      ['aaaa0002', 'aaaa0003', 'gone0001'].sort()
    );
  });

  it('applyOps returns the minted ids in op order and the last slide touched', () => {
    const adapter = createDeckAdapter(makeDeps());
    const document = liveDoc();
    const result = adapter.applyOps(
      context(document),
      adapter.parseOps([
        { op: 'update', id: 'aaaa0001', html: '<h1>x</h1>' },
        {
          op: 'insert',
          position: { at: 'end' },
          slides: [{ html: '<p>a</p>' }, { children: [{ html: '<p>b</p>' }] }],
        },
      ])
    );
    const deck = yDocToDeck(document);
    const tail = deck.slides.slice(-2);
    expect(result.insertedIds).toEqual([tail[0].id, tail[1].id, tail[1].children?.[0].id]);
    expect(result.touchedId).toBe(tail[1].id);
  });
});

describe('mergeExternal: conflict notices and per-field merges', () => {
  it('a held slide keeps its html and its holder gets the pushed version to look at', async () => {
    const deps = makeDeps();
    deps.decks.set('push-sha', {
      ...DECK,
      slides: [{ id: 'aaaa0001', html: '<h1>From GitHub</h1>' }, ...DECK.slides.slice(1)],
    });
    const adapter = createDeckAdapter(deps);
    const document = liveDoc(DECK, [7]);
    acquireLock(document, 'aaaa0001', holder(7), { now: deps.now() });
    adapter.attach(document);
    const result = (await adapter.mergeExternal(context(document, { source_sha: 'base-sha' }), {
      sha: 'push-sha',
    })) as { conflictIds?: string[] };
    expect(result.conflictIds).toEqual(['aaaa0001']);
    expect(readSlideConflicts(document).get('aaaa0001')).toMatchObject({
      sha: 'push-sha',
      html: '<h1>From GitHub</h1>',
      holderUserId: 'u7',
    });
  });

  it('an unlocked slide both sides changed merges per field', async () => {
    const deps = makeDeps();
    deps.decks.set('push-sha', {
      ...DECK,
      slides: [
        DECK.slides[0],
        { id: 'aaaa0002', html: '<h2>From GitHub</h2>', notes: 'say hi' },
        ...DECK.slides.slice(2),
      ],
    });
    const adapter = createDeckAdapter(deps);
    const document = liveDoc();
    // Live: notes changed on the same slide.
    const notes = (deckSlides(document).get('aaaa0002') as Y.Map<unknown>).get('notes') as Y.Text;
    notes.insert(notes.length, ' loudly');
    await adapter.mergeExternal(context(document, { source_sha: 'base-sha' }), { sha: 'push-sha' });
    const slide = yDocToDeck(document).slides[1];
    expect(slide.html).toBe('<h2>From GitHub</h2>');
    expect(slide.notes).toBe('say hi loudly');
  });
});
