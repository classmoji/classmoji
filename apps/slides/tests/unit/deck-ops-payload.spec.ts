/**
 * The ops the slides editor's diff emits parse with the schema the server
 * reads an ops save with (deckOpsPayloadSchema), whose op envelopes refuse
 * keys they do not declare.
 *
 * Decks are rendered to HTML (the edited one with the attributes Reveal adds
 * at runtime), read back with the real extractDeckSnapshot through jsdom,
 * diffed with diffDeckSnapshots, and each op list goes through JSON as the
 * route posts it. The deck-tool path is covered too: block ops after
 * prepareDeckOps, and the rewrite that stores a block's source as a file.
 * Runs in the Playwright runner without a browser or the dev stack.
 */

import { test, expect } from '@playwright/test';
// @ts-expect-error -- jsdom ships no type declarations; only the constructor is used.
import { JSDOM } from 'jsdom';
import { deckOpsPayloadSchema, prepareDeckOps } from '@classmoji/services/slides/ops';
import { diffDeckSnapshots, extractDeckSnapshot } from '../../app/utils/deckOpsDiff.ts';

type Slide = {
  id: string | null;
  html?: string;
  notes?: string | null;
  hidden?: boolean;
  attrs: Record<string, string>;
  children?: Slide[];
};

/** A small seeded generator (mulberry32), so a failure replays. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const viaJson = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const parseDocument = (html: string): Document => new JSDOM(html).window.document;

const attrText = (attrs: Record<string, string>) =>
  Object.entries(attrs)
    .map(([key, value]) => ` ${key}="${value.replace(/"/g, '&quot;')}"`)
    .join('');

function renderSlide(slide: Slide, runtime: boolean): string {
  const id = slide.id ? ` data-cm-id="${slide.id}"` : '';
  const hidden = slide.hidden ? ' data-hidden="true"' : '';
  // What Reveal adds while a deck is shown; the editor strips it.
  const added = runtime
    ? ' class="present" style="top: 0px; display: block;" data-index-h="0" aria-hidden="true"'
    : '';
  const notes = slide.notes ? `<aside class="notes">${slide.notes}</aside>` : '';
  const body = slide.children
    ? slide.children.map(child => renderSlide(child, runtime)).join('')
    : (slide.html ?? '');
  return `<section${id}${hidden}${attrText(slide.attrs)}${added}>${body}${notes}</section>`;
}

const renderDeck = (slides: Slide[], runtime: boolean) =>
  '<!doctype html><html><body><div class="reveal" data-theme="white" data-code-theme="github">' +
  `<div class="slides">${slides.map(slide => renderSlide(slide, runtime)).join('')}</div>` +
  '</div></body></html>';

const textBlock = (n: number) =>
  `<div class="sl-block" data-block-type="text" data-cm-block-id="b${n}" ` +
  `style="left:${n * 10}px;top:20px;width:300px"><div class="sl-block-content"><p>Text ${n}</p></div></div>`;

function baseDeck(r: () => number): Slide[] {
  const slides: Slide[] = [];
  for (let i = 0, count = 4 + Math.floor(r() * 6); i < count; i++) {
    const attrs: Record<string, string> = {};
    if (r() < 0.5) attrs['data-background-color'] = '#fff';
    if (r() < 0.3) attrs['data-transition'] = 'fade';
    if (r() < 0.2) attrs['data-auto-animate'] = '';
    if (r() < 0.2) attrs.id = `anchor-${i}`;
    if (r() < 0.15) {
      slides.push({
        id: `stack${i}`,
        attrs,
        children: [
          { id: `stack${i}a`, html: textBlock(i * 10 + 1), attrs: {} },
          {
            id: `stack${i}b`,
            html: `<h2>Child ${i}</h2>`,
            attrs: { 'data-state': 'x' },
            notes: '<p>n</p>',
          },
        ],
      });
    } else {
      slides.push({
        id: `s${i}`,
        html: r() < 0.5 ? textBlock(i) : `<h1>Slide ${i}</h1><p>body</p>`,
        notes: r() < 0.4 ? `<p>notes ${i}</p>` : null,
        hidden: r() < 0.1,
        attrs,
      });
    }
  }
  return slides;
}

function editedDeck(base: Slide[], r: () => number, seed: number): Slide[] {
  const deck = structuredClone(base);
  for (let step = 1 + Math.floor(r() * 4); step > 0; step--) {
    const pick = r();
    const at = Math.floor(r() * deck.length);
    const slide = deck[at];
    if (pick < 0.15 && slide && !slide.children) slide.html = `<h1>edited ${seed}</h1>`;
    else if (pick < 0.25 && slide) slide.notes = slide.notes ? null : `<p>new notes ${seed}</p>`;
    else if (pick < 0.32 && slide) slide.hidden = !slide.hidden;
    else if (pick < 0.45 && slide) {
      slide.attrs =
        Object.keys(slide.attrs).length && r() < 0.5
          ? {}
          : { ...slide.attrs, 'data-background-color': `#${seed % 999}` };
    } else if (pick < 0.6) {
      deck.splice(at, 0, {
        id: null,
        html: `<p>inserted ${seed}</p>`,
        attrs: r() < 0.5 ? { class: 'fancy' } : {},
        notes: r() < 0.5 ? '<p>nn</p>' : null,
        hidden: r() < 0.2,
      });
    } else if (pick < 0.67) {
      deck.splice(at, 0, {
        id: null,
        attrs: {},
        children: [
          { id: null, html: '<p>c1</p>', attrs: {} },
          { id: null, html: '<p>c2</p>', attrs: { 'data-transition': 'zoom' }, notes: '<p>x</p>' },
        ],
      });
    } else if (pick < 0.8 && deck.length > 2) deck.splice(at, 1);
    else if (deck.length > 2) {
      const [moved] = deck.splice(at, 1);
      deck.splice(Math.floor(r() * deck.length), 0, moved);
    }
  }
  if (r() < 0.1) deck.reverse();
  // Moves inside a stack and into one.
  const stack = deck.find(slide => slide.children && slide.children.length > 1 && slide.id);
  if (stack && r() < 0.5) stack.children!.reverse();
  if (stack && r() < 0.3) {
    const leaf = deck.findIndex(slide => !slide.children && slide.id);
    if (leaf >= 0) stack.children!.push(...deck.splice(leaf, 1));
  }
  return deck;
}

const box = { left: 0, top: 0, width: 10, height: 10 };

test.describe('slides editor ops and the server payload schema', () => {
  test('every op list the diff emits parses', () => {
    const kinds = new Set<string>();
    let lists = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const r = random(seed);
      const base = baseDeck(r);
      const before = extractDeckSnapshot(renderDeck(base, false), parseDocument);
      const after = extractDeckSnapshot(renderDeck(editedDeck(base, r, seed), true), parseDocument);
      expect(before && after, `deck #${seed}`).toBeTruthy();
      const ops = diffDeckSnapshots(before!, after!);
      if (!ops || ops.length === 0) continue;
      lists++;
      for (const op of ops) kinds.add(op.op);
      const parsed = deckOpsPayloadSchema.safeParse(viaJson(ops));
      expect(parsed.success, `deck #${seed}: ${JSON.stringify(parsed.error?.issues[0])}`).toBe(
        true
      );
    }
    expect(lists).toBeGreaterThan(250);
    expect([...kinds].sort()).toEqual(['delete', 'insert', 'move', 'reorder', 'update']);
  });

  test('block ops after prepareDeckOps parse, and so does a source stored as a file', () => {
    const ops = prepareDeckOps(
      [
        { op: 'block_add', slide: 's1', type: 'svg', box, source: '<svg/>' },
        { op: 'block_add', slide: 's1', type: 'iframe', box, src: 'https://example.com' },
        { op: 'block_update', slide: 's1', block_id: 'abc', box: { left: 5 } },
        { op: 'block_delete', slide: 's1', block_id: 'abc', delete_file: true },
        { op: 'set_theme', theme: 'black', code_theme: 'github' },
      ],
      null
    );
    expect(deckOpsPayloadSchema.safeParse(viaJson(ops)).success).toBe(true);
    // A block's source written to its file: `source` gives way to `src` and `rev`.
    const { source: _source, ...added } = ops[0] as Record<string, unknown>;
    const stored = { ...added, src: 'blocks/x.html', rev: 'a'.repeat(40) };
    expect(deckOpsPayloadSchema.safeParse([stored]).success).toBe(true);
  });

  test('a key an op does not declare is refused and named; attrs take any name', () => {
    expect(
      deckOpsPayloadSchema.safeParse([{ op: 'update', id: 's1', attrs: { 'data-anything': 'x' } }])
        .success
    ).toBe(true);
    for (const [op, key] of [
      [{ op: 'update', id: 's1', note: '<p>notes</p>' }, 'note'],
      [{ op: 'set_theme', codeTheme: 'github' }, 'codeTheme'],
      [{ op: 'block_delete', slide: 's1', block_id: 'abc', deleteFile: true }, 'deleteFile'],
      [{ op: 'block_add', slide: 's1', type: 'html', box, html: '<p>x</p>' }, 'html'],
    ] as const) {
      const parsed = deckOpsPayloadSchema.safeParse([op]);
      expect(parsed.success, key).toBe(false);
      expect(parsed.error?.issues[0], key).toMatchObject({
        code: 'unrecognized_keys',
        keys: [key],
        path: [0],
      });
    }
  });
});
