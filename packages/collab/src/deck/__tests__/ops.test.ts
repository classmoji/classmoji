import { describe, expect, it } from 'vitest';

// Relative: the lint resolver does not follow package subpath exports.
import {
  applyDeckOps,
  parseDeckHtml,
  type DeckJson,
} from '../../../../services/src/slides/index.ts';
import { seededIdGen } from '../../../../services/src/slides/__tests__/fixtures.ts';
import { deckOpsBetween } from '../ops.ts';
import { KITCHEN_SINK_HTML } from './kitchenSink.ts';

const base = (): DeckJson => parseDeckHtml(KITCHEN_SINK_HTML, { idGen: seededIdGen() }).deck;
const verify = (deck: DeckJson, ops: Parameters<typeof applyDeckOps>[1]) =>
  applyDeckOps(deck, ops).deck;

/** Replay and compare with the target, ids of new slides ignored. */
function expectReplays(before: DeckJson, after: DeckJson) {
  const ops = deckOpsBetween(before, after, { verify });
  expect(ops).not.toBeNull();
  const replayed = applyDeckOps(before, ops ?? []).deck;
  const strip = (deck: DeckJson, known: DeckJson) => {
    const ids = new Set<string>();
    for (const s of known.slides) {
      ids.add(s.id);
      for (const c of s.children ?? []) ids.add(c.id);
    }
    return JSON.parse(
      JSON.stringify(deck.slides, (key, value) => (key === 'id' && !ids.has(value) ? '*' : value))
    );
  };
  expect(strip(replayed, before)).toEqual(strip(after, before));
  return ops ?? [];
}

describe('deckOpsBetween', () => {
  it('no change → no ops', () => {
    expect(deckOpsBetween(base(), base())).toEqual([]);
  });

  it('content edits become updates of just those slides', () => {
    const after = base();
    after.slides[0].html = '<h1>changed</h1>';
    after.slides[1].notes = 'new notes';
    delete after.slides[2].hidden;
    after.slides[3].attrs = { 'data-background-color': '#fff' };
    delete after.slides[0].notes;
    const ops = expectReplays(base(), after);
    expect(ops.every(op => op.op === 'update')).toBe(true);
    expect(ops).toHaveLength(4);
  });

  it('moves, inserts (incl. a new stack), cross-stack moves and deletes', () => {
    const after = base();
    const [first] = after.slides.splice(0, 1);
    after.slides.splice(4, 0, first); // move
    after.slides.splice(1, 0, { id: 'new00001', html: '<p>new</p>' }); // insert
    after.slides.push({
      id: 'newstack',
      children: [
        { id: 'new00002', html: '<p>a</p>' },
        { id: 'new00003', html: '<p>b</p>' },
      ],
    });
    const stack = after.slides.find(s => s.id === 'ks000010');
    const moved = stack?.children?.splice(1, 1)[0]; // ks000012 out of the stack
    if (moved) after.slides.splice(3, 0, moved);
    stack?.children?.push({ id: 'new00004', html: '<p>child</p>' });
    after.slides = after.slides.filter(s => s.id !== 'ks000006'); // delete
    expectReplays(base(), after);
  });

  it('theme changes become set_theme', () => {
    const after = { ...base(), theme: 'moon', codeTheme: 'monokai' };
    delete after.themeDark;
    const ops = expectReplays(base(), after);
    expect(ops[0]).toEqual({ op: 'set_theme', theme: 'moon', code_theme: 'monokai' });
  });

  it('refuses what the vocabulary cannot say', () => {
    const toStack = base();
    toStack.slides[0] = { id: toStack.slides[0].id, children: [{ id: 'x1', html: 'x' }] };
    expect(deckOpsBetween(base(), toStack)).toBeNull();

    const stackFront = base();
    stackFront.slides
      .find(s => s.id === 'ks000010')
      ?.children?.unshift({ id: 'front001', html: '<p>front</p>' });
    expect(deckOpsBetween(base(), stackFront)).toBeNull();

    const css = { ...base(), customCss: 'body{}' };
    expect(deckOpsBetween(base(), css)).toBeNull();
  });
});
