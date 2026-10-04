import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { DeckJson } from '@classmoji/services/slides';

import { cloneYDoc, deckSlides, deckToYDoc, yDocToDeck } from '../convert.ts';
import {
  applyLocalStructure,
  deleteSlide,
  insertSlide,
  moveSlide,
  planLocalStructure,
  planReorder,
  setSlideHidden,
  structureOfDoc,
  structureOrder,
  type DeckStructure,
} from '../structure.ts';

const deck = (): DeckJson => ({
  version: 1,
  theme: 'white',
  codeTheme: 'github',
  slides: [
    { id: 's1', html: '<p>1</p>' },
    { id: 's2', html: '<p>2</p>' },
    {
      id: 'st',
      children: [
        { id: 'c1', html: '<p>c1</p>' },
        { id: 'c2', html: '<p>c2</p>' },
      ],
    },
    { id: 's3', html: '<p>3</p>' },
  ],
});

const ids = (doc: Y.Doc): string[] => structureOrder(structureOfDoc(doc));

/** Structure from a compact description: [['s1'], ['st', 'c1', 'c2'], …]. */
function struct(spec: Array<string | [string, ...string[]]>): DeckStructure {
  const scopes = new Map<string | null, string[]>([[null, []]]);
  const containers = new Set<string>();
  for (const item of spec) {
    if (typeof item === 'string') {
      (scopes.get(null) as string[]).push(item);
    } else {
      const [id, ...kids] = item;
      (scopes.get(null) as string[]).push(id);
      containers.add(id);
      scopes.set(id, kids);
    }
  }
  return { scopes, containers };
}

describe('direct structural helpers', () => {
  it('insert / move / delete / hide', () => {
    const doc = deckToYDoc(deck());
    insertSlide(doc, 'n1', { html: '<p>new</p>' }, { parent: null, after: 's1' });
    expect(ids(doc)).toEqual(['s1', 'n1', 's2', 'st', 'c1', 'c2', 's3']);
    insertSlide(doc, 'n0', { html: '<p>first</p>' }, { parent: null, after: null });
    expect(ids(doc)[0]).toBe('n0');
    moveSlide(doc, 's3', { parent: 'st', after: 'c1' });
    expect(ids(doc)).toEqual(['n0', 's1', 'n1', 's2', 'st', 'c1', 's3', 'c2']);
    expect(deleteSlide(doc, 'st').sort()).toEqual(['c1', 'c2', 's3', 'st']);
    expect(ids(doc)).toEqual(['n0', 's1', 'n1', 's2']);
    setSlideHidden(doc, 's2', true);
    expect(yDocToDeck(doc).slides[3]).toEqual({ id: 's2', html: '<p>2</p>', hidden: true });
  });

  it('two peers inserting at the same spot converge (ties break by id)', () => {
    const a = deckToYDoc(deck());
    const b = cloneYDoc(a);
    insertSlide(a, 'xa', { html: 'a' }, { parent: null, after: 's1' });
    insertSlide(b, 'xb', { html: 'b' }, { parent: null, after: 's1' });
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(ids(a)).toEqual(ids(b));
    expect(ids(a).slice(0, 3)).toEqual(['s1', 'xa', 'xb']);
    // And a third insert after the tie lands after both.
    insertSlide(a, 'xc', { html: 'c' }, { parent: null, after: 'xb' });
    expect(ids(a).slice(0, 4)).toEqual(['s1', 'xa', 'xb', 'xc']);
  });
});

describe('planLocalStructure', () => {
  const base = struct(['s1', 's2', ['st', 'c1', 'c2'], 's3']);

  it('no change → empty plan', () => {
    expect(planLocalStructure(base, base)).toEqual({ deletes: [], places: [] });
  });

  it('a drag of one slide moves one slide', () => {
    const plan = planLocalStructure(base, struct(['s2', 's1', ['st', 'c1', 'c2'], 's3']));
    expect(plan.deletes).toEqual([]);
    expect(plan.places).toHaveLength(1);
    expect(plan.places[0].create).toBe(false);
  });

  it('insert, delete, cross-stack move and new stack', () => {
    const plan = planLocalStructure(
      base,
      struct(['s1', 'new1', ['wrap', 's2', 'new2'], ['st', 'c2', 's3']])
    );
    expect(plan.deletes).toEqual(['c1']);
    const byId = new Map(plan.places.map(p => [p.id, p]));
    expect(byId.get('new1')).toMatchObject({ create: true, parent: null, after: ['s1'] });
    expect(byId.get('wrap')).toMatchObject({ create: true, container: true, parent: null });
    expect(byId.get('s2')).toMatchObject({ create: false, parent: 'wrap', after: [] });
    expect(byId.get('new2')).toMatchObject({ create: true, parent: 'wrap', after: ['s2'] });
    expect(byId.get('s3')).toMatchObject({ create: false, parent: 'st', after: ['c2'] });
  });

  it('deleting a stack does not list its children separately', () => {
    const plan = planLocalStructure(base, struct(['s1', 's2', 's3']));
    expect(plan.deletes).toEqual(['st']);
  });
});

describe('applyLocalStructure', () => {
  it('replays an editor change onto the doc, keeping a concurrent remote move', () => {
    const doc = deckToYDoc(deck());
    const remote = cloneYDoc(doc);
    const baseline = structureOfDoc(doc);

    // Remote moves s3 to the front.
    moveSlide(remote, 's3', { parent: null, after: null });

    // Editor: new slide after s1, c2 dragged out to the top level after s2.
    const editor = struct(['s1', 'n1', 's2', 'c2', ['st', 'c1'], 's3']);
    applyLocalStructure(doc, planLocalStructure(baseline, editor), {
      newSlide: () => ({ html: '<p>new</p>' }),
    });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote));
    expect(ids(doc)).toEqual(['s3', 's1', 'n1', 's2', 'c2', 'st', 'c1']);
  });

  it('a stack deleted after its child was dragged out keeps the child', () => {
    const doc = deckToYDoc(deck());
    const baseline = structureOfDoc(doc);
    const editor = struct(['s1', 's2', 'c1', 's3']);
    applyLocalStructure(doc, planLocalStructure(baseline, editor), {
      newSlide: () => ({ html: '' }),
    });
    expect(ids(doc)).toEqual(['s1', 's2', 'c1', 's3']);
  });

  it('refuses deleting a slide someone else holds', () => {
    const doc = deckToYDoc(deck());
    const baseline = structureOfDoc(doc);
    const { refused } = applyLocalStructure(
      doc,
      planLocalStructure(baseline, struct(['s1', 's2', 's3'])),
      { newSlide: () => ({ html: '' }), canDelete: id => id !== 'c2' }
    );
    expect(refused).toEqual(['st']);
    expect(deckSlides(doc).has('c2')).toBe(true);
  });
});

describe('planReorder', () => {
  it('moves the fewest slides', () => {
    expect([...planReorder(['a', 'b', 'c', 'd'], ['b', 'c', 'd', 'a']).move]).toEqual(['a']);
  });

  it('keeps the pinned slide still when it can', () => {
    const { move } = planReorder(['a', 'b', 'c', 'd'], ['b', 'c', 'd', 'a'], 'a');
    expect(move.has('a')).toBe(false);
    expect([...move].sort()).toEqual(['b', 'c', 'd']);
  });

  it('counts new ids as moves (inserts)', () => {
    expect([...planReorder(['a', 'b'], ['a', 'x', 'b']).move]).toEqual(['x']);
  });
});
