import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
// Relative: the lint resolver does not follow package subpath exports.
import {
  applyDeckOps,
  generateDeckHtml,
  parseDeckHtml,
  slideService,
  type DeckJson,
} from '../../../../services/src/slides/index.ts';

import {
  ROUND_TRIP_FIXTURES,
  seededIdGen,
} from '../../../../services/src/slides/__tests__/fixtures.ts';
import {
  cloneYDoc,
  deckSlideList,
  deckSlides,
  deckToYDoc,
  planScopeOrder,
  syncDeckIntoYDoc,
  yDocToDeck,
} from '../convert.ts';
import { renderDeckSections } from '../render.ts';
import { F } from '../shape.ts';
import { KITCHEN_SINK_HTML } from './kitchenSink.ts';

const TITLE = 'Round Trip';

/** deck.json exactly as saveDeck writes it. */
const deckJson = (deck: DeckJson): string => JSON.stringify(deck, null, 2) + '\n';

/** Through Y, then through the wire to a fresh peer, then back. */
function roundTrip(deck: DeckJson): DeckJson {
  const doc = deckToYDoc(deck);
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
  return yDocToDeck(peer);
}

const FIXTURES = [
  ...ROUND_TRIP_FIXTURES,
  { name: 'kitchen-sink', html: KITCHEN_SINK_HTML, themeUrls: undefined },
];

describe('deck ⇄ Y.Doc round trip', () => {
  for (const fixture of FIXTURES) {
    describe(fixture.name, () => {
      const { deck } = parseDeckHtml(fixture.html, { idGen: seededIdGen() });

      it('deck.json is byte-identical (parser key order)', () => {
        expect(deckJson(roundTrip(deck))).toBe(deckJson(deck));
      });

      it('index.html is byte-identical', () => {
        const opts = { title: TITLE, themeUrls: fixture.themeUrls };
        expect(generateDeckHtml(roundTrip(deck), opts)).toBe(generateDeckHtml(deck, opts));
      });

      it('deck.json is byte-identical in the editor save key order', () => {
        // What buildEditorDeck (the editor's whole-doc save) writes.
        const editorDeck = slideService.buildEditorDeck({
          theme: deck.theme,
          codeTheme: deck.codeTheme,
          slides: deck.slides,
          currentDeck: deck,
        });
        expect(deckJson(roundTrip(editorDeck))).toBe(deckJson(editorDeck));
      });

      it('the browser renderer matches the generator section for section', () => {
        const html = generateDeckHtml(deck, { title: TITLE, themeUrls: fixture.themeUrls });
        const start = html.indexOf('<div class="slides">\n') + '<div class="slides">\n'.length;
        const end = html.indexOf('\n    </div>\n  </div>');
        expect(renderDeckSections(roundTrip(deck))).toBe(html.slice(start, end));
      });
    });
  }

  it('carries deckOps key orders (containers, notes added later)', () => {
    const { deck } = parseDeckHtml(KITCHEN_SINK_HTML, { idGen: seededIdGen() });
    const { deck: edited } = applyDeckOps(deck, [
      {
        op: 'insert',
        position: { after: 'ks000002' },
        slides: [{ children: [{ html: '<p>a</p>' }, { html: '<p>b</p>' }], notes: 'n' }],
      },
      { op: 'update', id: 'ks000004', notes: 'added later' },
      { op: 'update', id: 'ks000014', attrs: { 'data-b': '2', 'data-a': '1' } },
      { op: 'delete', id: 'ks000012' },
    ]);
    expect(deckJson(roundTrip(edited))).toBe(deckJson(edited));
  });

  it('keeps a stack whose last child was deleted (children: [])', () => {
    const deck: DeckJson = {
      version: 1,
      theme: 'white',
      codeTheme: 'github',
      slides: [
        { id: 'aaaa0001', html: '<p>x</p>' },
        { id: 'aaaa0002', children: [] },
      ],
    };
    expect(deckJson(roundTrip(deck))).toBe(deckJson(deck));
  });

  it('empty notes stay present; absent notes stay absent', () => {
    const deck: DeckJson = {
      version: 1,
      theme: 'white',
      codeTheme: 'github',
      slides: [
        { id: 'bbbb0001', html: '<p>x</p>', notes: '' },
        { id: 'bbbb0002', html: '<p>y</p>' },
      ],
    };
    const back = roundTrip(deck);
    expect(back.slides[0]).toEqual({ id: 'bbbb0001', html: '<p>x</p>', notes: '' });
    expect('notes' in back.slides[1]).toBe(false);
  });
});

describe('syncDeckIntoYDoc', () => {
  const base = (): DeckJson => parseDeckHtml(KITCHEN_SINK_HTML, { idGen: seededIdGen() }).deck;

  it('touches only what changed and keeps unmoved order keys', () => {
    const doc = deckToYDoc(base());
    const before = new Map(deckSlideList(doc).map(e => [e.id, e.order]));
    const next = base();
    // Move ks000001 to the end, edit one slide.
    const [first] = next.slides.splice(0, 1);
    next.slides.push(first);
    next.slides[1].html = '<h2>edited</h2>';

    const changed: string[] = [];
    deckSlides(doc).observeDeep(events => {
      for (const event of events) {
        const target = event.target;
        if (target instanceof Y.Map && target.parent === deckSlides(doc)) {
          const keys = [...(event as Y.YMapEvent<unknown>).keysChanged];
          changed.push(`${target._item?.parentSub}:${keys.join(',')}`);
        }
      }
    });
    syncDeckIntoYDoc(doc, next);
    expect(changed.sort()).toEqual(
      [`ks000001:${F.order}`, `${next.slides[1].id}:${F.html}`].sort()
    );
    const after = new Map(deckSlideList(doc).map(e => [e.id, e.order]));
    for (const [id, order] of before) {
      if (id !== 'ks000001') expect(after.get(id)).toBe(order);
    }
    expect(deckJson(yDocToDeck(doc))).toBe(deckJson(next));
  });

  it("merges with a peer's concurrent edit of another slide", () => {
    const doc = deckToYDoc(base());
    const peer = cloneYDoc(doc);

    // Server side: an agent's edit through a full-deck sync.
    const agentDeck = base();
    agentDeck.slides[0].html = '<h1>agent</h1>';
    syncDeckIntoYDoc(doc, agentDeck);

    // Peer, concurrently: a different slide's html and a move.
    const peerMap = deckSlides(peer).get('ks000002') as Y.Map<unknown>;
    peerMap.set(F.html, '<h2>peer</h2>');

    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const merged = yDocToDeck(doc);
    expect(merged.slides[0].html).toBe('<h1>agent</h1>');
    expect(merged.slides[1].html).toBe('<h2>peer</h2>');
    expect(deckJson(yDocToDeck(peer))).toBe(deckJson(merged));
  });

  it('notes change by one splice so concurrent typing survives', () => {
    const doc = deckToYDoc(base());
    const peer = cloneYDoc(doc);
    const text = (deckSlides(peer).get('ks000001') as Y.Map<unknown>).get(F.notes) as Y.Text;
    text.insert(0, 'PEER ');
    const next = base();
    next.slides[0].notes = 'Opening notes with <b>markup</b> and more';
    syncDeckIntoYDoc(doc, next);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    expect(yDocToDeck(doc).slides[0].notes).toBe('PEER Opening notes with <b>markup</b> and more');
  });

  it('refuses duplicate ids and nested stacks', () => {
    const dup = base();
    dup.slides[1].id = dup.slides[0].id;
    expect(() => deckToYDoc(dup)).toThrow(/duplicate/);
    const nested = base();
    (nested.slides[9].children as DeckJson['slides'])[0].children = [];
    expect(() => deckToYDoc(nested)).toThrow(/stack inside a stack/);
  });

  it('promotes orphans (slide moved into a stack someone deleted) to the top level', () => {
    const doc = deckToYDoc(base());
    const peer = cloneYDoc(doc);
    // Peer moves ks000001 into the stack; we delete the stack.
    (deckSlides(peer).get('ks000001') as Y.Map<unknown>).set(F.parent, 'ks000010');
    deckSlides(doc).delete('ks000010');
    for (const child of ['ks000011', 'ks000012', 'ks000013']) deckSlides(doc).delete(child);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const ids = yDocToDeck(doc).slides.map(s => s.id);
    expect(ids).toContain('ks000001');
    expect(deckJson(yDocToDeck(peer))).toBe(deckJson(yDocToDeck(doc)));
  });
});

describe('planScopeOrder', () => {
  it('keeps the longest in-order run and mints between neighbours', () => {
    const keys: Record<string, string> = { a: 'a0', b: 'a1', c: 'a2', d: 'a3' };
    const plan = planScopeOrder(['b', 'c', 'a', 'd', 'new'], id => keys[id] ?? null);
    expect(plan.get('b')).toBe('a1');
    expect(plan.get('c')).toBe('a2');
    expect(plan.get('d')).toBe('a3');
    const seq = ['b', 'c', 'a', 'd', 'new'].map(id => plan.get(id) as string);
    expect([...seq].sort()).toEqual(seq);
  });
});

describe('isRenderableAttr', () => {
  it('refuses handlers, bad names and javascript: URLs, however written', async () => {
    const { isRenderableAttr } = await import('../render.ts');
    expect(isRenderableAttr('href', '/x')).toBe(true);
    expect(isRenderableAttr('onclick', 'x()')).toBe(false);
    expect(isRenderableAttr('OnLoad', 'x()')).toBe(false);
    expect(isRenderableAttr('1bad', 'x')).toBe(false);
    expect(isRenderableAttr('href', ' JaVa\tScript:alert(1)')).toBe(false);
    expect(isRenderableAttr('data-background-iframe', 'javascript:x')).toBe(false);
  });
});
