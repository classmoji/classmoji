import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { DeckJson } from '@classmoji/services/slides';

import { cloneYDoc, deckSlides, deckToYDoc, yDocToDeck } from '../convert.ts';
import { installLockGuard } from '../guard.ts';
import { acquireLock, getLock, installLockArbiter } from '../locks.ts';
import { F } from '../shape.ts';
import { deleteSlide, moveSlide } from '../structure.ts';

const DECK: DeckJson = {
  version: 1,
  theme: 'white',
  codeTheme: 'github',
  slides: [
    { id: 's1', html: '<p>1</p>', notes: 'n1', attrs: { 'data-x': '1' } },
    { id: 's2', html: '<p>2</p>' },
    { id: 'st', children: [{ id: 'c1', html: '<p>c</p>' }] },
  ],
};

/**
 * A server doc with the arbiter and the guard; clients A (holder) and B (a
 * peer skipping the client checks). Updates are tagged with their writer.
 */
function setup() {
  const server = deckToYDoc(DECK);
  installLockArbiter(server, 'arbiter');
  const reverted: string[][] = [];
  installLockGuard(server, {
    origin: 'guard',
    writersOf: tr =>
      typeof tr.origin === 'object' && tr.origin && 'client' in tr.origin
        ? new Set([(tr.origin as { client: number }).client])
        : null,
    onRevert: ids => reverted.push(ids),
  });
  const a = cloneYDoc(server);
  a.clientID = 100;
  const b = cloneYDoc(server);
  b.clientID = 200;
  const send = (from: Y.Doc) => {
    Y.applyUpdate(server, Y.encodeStateAsUpdate(from), { client: from.clientID });
    Y.applyUpdate(from, Y.encodeStateAsUpdate(server));
  };
  // A holds s1, confirmed by the server.
  acquireLock(a, 's1', { userId: 'a', name: 'A', color: '#000', clientId: 100 }, { now: 0 });
  send(a);
  Y.applyUpdate(b, Y.encodeStateAsUpdate(server));
  return { server, a, b, send, reverted };
}

describe('server-side lock guard', () => {
  it("undoes another client's html change to a held slide", () => {
    const t = setup();
    (deckSlides(t.b).get('s1') as Y.Map<unknown>).set(F.html, '<p>hijack</p>');
    (deckSlides(t.b).get('s2') as Y.Map<unknown>).set(F.html, '<p>fine</p>');
    t.send(t.b);
    const deck = yDocToDeck(t.server);
    expect(deck.slides[0].html).toBe('<p>1</p>');
    expect(deck.slides[1].html).toBe('<p>fine</p>');
    expect(t.reverted).toEqual([['s1']]);
    // The correction reaches the offender.
    expect(yDocToDeck(t.b).slides[0].html).toBe('<p>1</p>');
  });

  it("the holder's own change stands", () => {
    const t = setup();
    (deckSlides(t.a).get('s1') as Y.Map<unknown>).set(F.html, '<p>mine</p>');
    t.send(t.a);
    expect(yDocToDeck(t.server).slides[0].html).toBe('<p>mine</p>');
    expect(t.reverted).toEqual([]);
  });

  it('re-creates a held slide another client deleted, notes and attributes included', () => {
    const t = setup();
    deleteSlide(t.b, 's1');
    t.send(t.b);
    const deck = yDocToDeck(t.server);
    expect(deck.slides[0]).toEqual(DECK.slides[0]);
    expect(yDocToDeck(t.b).slides.map(s => s.id)).toEqual(['s1', 's2', 'st']);
    // …and its lock (deleteSlide drops it) is A's again.
    expect(getLock(t.server, 's1')?.clientId).toBe(100);
  });

  it('moves a held slide back out of a stack someone moved it into', () => {
    const t = setup();
    moveSlide(t.b, 's1', { parent: 'st', after: 'c1' });
    t.send(t.b);
    expect(yDocToDeck(t.server).slides.map(s => s.id)).toEqual(['s1', 's2', 'st']);
  });

  it('attributes and unlocked slides are not guarded', () => {
    const t = setup();
    const attrs = (deckSlides(t.b).get('s1') as Y.Map<unknown>).get(F.attrs) as Y.Map<string>;
    attrs.set('data-x', '2');
    deleteSlide(t.b, 's2');
    t.send(t.b);
    const deck = yDocToDeck(t.server);
    expect(deck.slides[0].attrs).toEqual({ 'data-x': '2' });
    expect(deck.slides.map(s => s.id)).toEqual(['s1', 'st']);
  });
});
