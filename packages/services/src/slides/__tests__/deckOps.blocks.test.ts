/**
 * Block ops in the shared op engine (block_add / block_update / block_delete):
 * the vocabulary deck_apply and the live collab server both apply.
 *
 * Pinned here: the markup each type builds (html source escaped into srcdoc
 * and read back exactly, svg sanitized, iframe embeds lazy-loaded), ids, the
 * box, the 200 KB slide cap, stack containers, the `applied` report, and the
 * iframe `src` rules and resolution the MCP applies before the ops travel.
 */

import { describe, expect, it } from 'vitest';
import {
  DeckOpError,
  MAX_SLIDE_HTML,
  SlideHtmlError,
  applyDeckOps,
  checkBlockFrameSrc,
  deckOpSchema,
  deckOpsPayloadSchema,
  ensureSlideBlockIds,
  prepareDeckOps,
  readSlideBlocks,
  resolveDeckFrameSrc,
  type DeckOp,
} from '../deckOps.ts';
import { HTML_BLOCK_SANDBOX, htmlBlockSrcdoc } from '../deckBlocks.ts';
import { normalizeSlideHtml } from '../deckHtml.ts';
import type { DeckJson } from '../deckTypes.ts';

const BOX = { left: 40, top: 60, width: 480, height: 320 };

function deck(): DeckJson {
  return {
    version: 1,
    theme: 'white',
    codeTheme: 'github',
    slides: [
      { id: 's1', html: '<h2>Title</h2>' },
      {
        id: 'stack',
        children: [
          { id: 'c1', html: '<p>one</p>' },
          { id: 'c2', html: '' },
        ],
      },
    ],
  } as unknown as DeckJson;
}

function html(d: DeckJson, id: string): string {
  for (const slide of d.slides) {
    if (slide.id === id) return slide.html ?? '';
    for (const child of slide.children ?? []) if (child.id === id) return child.html ?? '';
  }
  throw new Error(`no slide ${id}`);
}

function apply(ops: DeckOp[], start: DeckJson = deck()) {
  return applyDeckOps(
    start,
    ops.map(op => deckOpSchema.parse(op))
  );
}

const GAME = `<!doctype html>
<html><body style="margin:0">
<canvas id="c" width="200" height="100"></canvas>
<script>
  const ctx = document.getElementById('c').getContext('2d');
  let x = 0;
  (function tick() { ctx.clearRect(0, 0, 200, 100); ctx.fillText("a < b && \\"q\\" & 'r'", x++ % 200, 50); requestAnimationFrame(tick); })();
</script>
</body></html>`;

describe('block_add', () => {
  it('html: escapes the source into srcdoc and reads it back exactly', () => {
    const { deck: next, applied } = apply([
      { op: 'block_add', slide: 's1', type: 'html', box: BOX, source: GAME, block_id: 'game0001' },
    ]);
    const out = html(next, 's1');
    expect(out.startsWith('<h2>Title</h2><div class="sl-block" data-block-type="html"')).toBe(true);
    expect(out).toContain(`sandbox="${HTML_BLOCK_SANDBOX}"`);
    expect(out).toContain('style="left: 40px; top: 60px; width: 480px; height: 320px;"');
    expect(out).not.toContain('<script>');
    const [block] = readSlideBlocks(out);
    expect(block).toEqual({ id: 'game0001', type: 'html', box: BOX, source: GAME });
    // Stored in canonical form: a second normalize pass changes nothing.
    expect(normalizeSlideHtml(out)).toBe(out);
    expect(applied).toEqual([{ op: 'block_add', slide: 's1', block_id: 'game0001', type: 'html' }]);
  });

  it('html: the srcdoc carries the storage shim, the source does not', () => {
    const { deck: next } = apply([
      { op: 'block_add', slide: 's1', type: 'html', box: BOX, source: '<p>hi</p>' },
    ]);
    const out = html(next, 's1');
    const srcdoc = htmlBlockSrcdoc('<p>hi</p>');
    expect(srcdoc).not.toBe('<p>hi</p>');
    expect(readSlideBlocks(out)[0].source).toBe('<p>hi</p>');
  });

  it('svg: sanitizes and sizes the drawing to the box', () => {
    const { deck: next } = apply([
      {
        op: 'block_add',
        slide: 's1',
        type: 'svg',
        box: BOX,
        source:
          '<svg width="100" height="50" onclick="x()"><script>x()</script><circle r="4"/></svg>',
        block_id: 'art00001',
      },
    ]);
    const [block] = readSlideBlocks(html(next, 's1'));
    expect(block.type).toBe('svg');
    expect(block.id).toBe('art00001');
    expect(block.svg).toContain('viewBox="0 0 100 50"');
    expect(block.svg).toContain('width="100%"');
    expect(block.svg).not.toMatch(/script|onclick/);
  });

  it('svg: refuses a source that is not one <svg>', () => {
    expect(() =>
      apply([{ op: 'block_add', slide: 's1', type: 'svg', box: BOX, source: '<div>no</div>' }])
    ).toThrow(SlideHtmlError);
  });

  it("iframe: today's lazy embed — data-src, allowfullscreen, no sandbox", () => {
    const src = '/content/org/repo/slides/deck/games/minions/index.html?level=1&mode=a';
    const { deck: next } = apply([
      { op: 'block_add', slide: 's1', type: 'iframe', box: BOX, src, block_id: 'emb00001' },
    ]);
    const out = html(next, 's1');
    expect(out).toContain(
      '<div class="sl-block" data-block-type="iframe" data-cm-block-id="emb00001" ' +
        'style="left: 40px; top: 60px; width: 480px; height: 320px;"><div class="sl-block-content">' +
        '<iframe allowfullscreen="" data-src="/content/org/repo/slides/deck/games/minions/index.html?level=1&amp;mode=a" ' +
        'style="width: 100%; height: 100%; border: 0px;"></iframe></div></div>'
    );
    expect(out).not.toContain('sandbox');
    expect(out).not.toMatch(/\ssrc=/);
    expect(readSlideBlocks(out)[0]).toEqual({ id: 'emb00001', type: 'iframe', box: BOX, src });
    expect(normalizeSlideHtml(out)).toBe(out);
  });

  it('mints a fresh 8-hex id when none is given, unique within the slide', () => {
    const { deck: next, applied } = apply([
      { op: 'block_add', slide: 's1', type: 'html', box: BOX, source: '<p>1</p>' },
      { op: 'block_add', slide: 's1', type: 'html', box: BOX, source: '<p>2</p>' },
    ]);
    const ids = readSlideBlocks(html(next, 's1')).map(b => b.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}$/);
    expect(new Set(ids).size).toBe(2);
    expect(applied.map(a => a.block_id)).toEqual(ids);
  });

  it('refuses an id the slide already has', () => {
    const ops: DeckOp[] = [
      { op: 'block_add', slide: 's1', type: 'html', box: BOX, source: 'a', block_id: 'same' },
      { op: 'block_add', slide: 's1', type: 'html', box: BOX, source: 'b', block_id: 'same' },
    ];
    expect(() => apply(ops)).toThrow(/already has a block 'same'/);
  });

  it('refuses an id a nested block on the slide already has', () => {
    const start = deck();
    start.slides[0].html =
      '<div class="sl-block" data-block-type="text"><div class="sl-block-content">' +
      '<div class="sl-block" data-block-type="svg" data-cm-block-id="inner01"></div></div></div>';
    const ops: DeckOp[] = [
      { op: 'block_add', slide: 's1', type: 'html', box: BOX, source: 'a', block_id: 'inner01' },
    ];
    expect(() => apply(ops, start)).toThrow(/already has a block 'inner01'/);
  });

  it('adds to a stack child, refuses the stack container', () => {
    const { deck: next } = apply([
      { op: 'block_add', slide: 'c2', type: 'html', box: BOX, source: 'x' },
    ]);
    expect(readSlideBlocks(html(next, 'c2'))).toHaveLength(1);
    expect(() =>
      apply([{ op: 'block_add', slide: 'stack', type: 'html', box: BOX, source: 'x' }])
    ).toThrow(/vertical stack container/);
  });

  it('refuses an unknown slide', () => {
    expect(() =>
      apply([{ op: 'block_add', slide: 'nope', type: 'html', box: BOX, source: 'x' }])
    ).toThrow(DeckOpError);
  });

  it('refuses fields that do not fit the type', () => {
    expect(() =>
      apply([{ op: 'block_add', slide: 's1', type: 'html', box: BOX, src: 'https://a.b/' }])
    ).toThrow(/takes source, not src/);
    expect(() =>
      apply([{ op: 'block_add', slide: 's1', type: 'iframe', box: BOX, source: '<p/>' }])
    ).toThrow(/takes src/);
    expect(() => apply([{ op: 'block_add', slide: 's1', type: 'iframe', box: BOX }])).toThrow(
      /needs src/
    );
    expect(() => apply([{ op: 'block_add', slide: 's1', type: 'svg', box: BOX }])).toThrow(
      /needs source/
    );
  });

  it('refuses a slide html over 200 KB after the op, and leaves the deck untouched', () => {
    const start = deck();
    const big = 'x'.repeat(MAX_SLIDE_HTML - 100);
    expect(() =>
      apply([{ op: 'block_add', slide: 's1', type: 'html', box: BOX, source: big }], start)
    ).toThrow(/over the 200000 limit/);
    expect(html(start, 's1')).toBe('<h2>Title</h2>');
  });

  it('schema: box needs all four numbers, positive size; type is one of three', () => {
    const base = { op: 'block_add', slide: 's1', source: 'x' };
    expect(deckOpSchema.safeParse({ ...base, type: 'html', box: BOX }).success).toBe(true);
    expect(
      deckOpSchema.safeParse({ ...base, type: 'html', box: { left: 1, top: 1, width: 1 } }).success
    ).toBe(false);
    expect(
      deckOpSchema.safeParse({ ...base, type: 'html', box: { ...BOX, width: 0 } }).success
    ).toBe(false);
    expect(deckOpSchema.safeParse({ ...base, type: 'text', box: BOX }).success).toBe(false);
    expect(
      deckOpSchema.safeParse({ ...base, type: 'html', box: BOX, block_id: 'a b' }).success
    ).toBe(false);
    // The editor and live /ops payloads accept the same vocabulary.
    expect(deckOpsPayloadSchema.safeParse([{ ...base, type: 'html', box: BOX }]).success).toBe(
      true
    );
  });
});

describe('block_update', () => {
  function withBlocks() {
    return apply([
      { op: 'block_add', slide: 's1', type: 'html', box: BOX, source: '<p>v1</p>', block_id: 'h1' },
      {
        op: 'block_add',
        slide: 's1',
        type: 'svg',
        box: BOX,
        source: '<svg viewBox="0 0 4 4"><rect width="1" height="1"/></svg>',
        block_id: 'v1',
      },
      {
        op: 'block_add',
        slide: 's1',
        type: 'iframe',
        box: BOX,
        src: 'https://example.com/demo',
        block_id: 'f1',
      },
    ]).deck;
  }

  it('html: replaces the source and moves the box', () => {
    const { deck: next, applied } = apply(
      [
        {
          op: 'block_update',
          slide: 's1',
          block_id: 'h1',
          source: GAME,
          box: { left: 0, width: 960 },
        },
      ],
      withBlocks()
    );
    const block = readSlideBlocks(html(next, 's1')).find(b => b.id === 'h1');
    expect(block).toEqual({
      id: 'h1',
      type: 'html',
      box: { left: 0, top: 60, width: 960, height: 320 },
      source: GAME,
    });
    expect(applied).toEqual([{ op: 'block_update', slide: 's1', block_id: 'h1' }]);
  });

  it('svg: source replaces the drawing', () => {
    const { deck: next } = apply(
      [
        {
          op: 'block_update',
          slide: 's1',
          block_id: 'v1',
          source: '<svg viewBox="0 0 9 9"><circle r="2"/></svg>',
        },
      ],
      withBlocks()
    );
    const block = readSlideBlocks(html(next, 's1')).find(b => b.id === 'v1');
    expect(block?.svg).toContain('<circle r="2">');
  });

  it('iframe: src replaces the frame URL (still lazy)', () => {
    const { deck: next } = apply(
      [{ op: 'block_update', slide: 's1', block_id: 'f1', src: 'https://example.com/other' }],
      withBlocks()
    );
    const out = html(next, 's1');
    expect(readSlideBlocks(out).find(b => b.id === 'f1')?.src).toBe('https://example.com/other');
    expect(out).toContain('data-src="https://example.com/other"');
  });

  it('refuses fields that do not fit the block', () => {
    const start = withBlocks();
    expect(() =>
      apply([{ op: 'block_update', slide: 's1', block_id: 'f1', source: 'x' }], start)
    ).toThrow(/takes src/);
    expect(() =>
      apply([{ op: 'block_update', slide: 's1', block_id: 'h1', src: 'https://a.b/' }], start)
    ).toThrow(/src applies to iframe blocks/);
    expect(() => apply([{ op: 'block_update', slide: 's1', block_id: 'h1' }], start)).toThrow(
      /at least one of box, source, src/
    );
    expect(() =>
      apply([{ op: 'block_update', slide: 's1', block_id: 'h1', box: {} }], start)
    ).toThrow(/at least one of/);
  });

  it('refuses an unknown block with the slide named', () => {
    expect(() =>
      apply([{ op: 'block_update', slide: 's1', block_id: 'zz', box: { top: 1 } }], withBlocks())
    ).toThrow(/No block 'zz' on slide 's1'/);
  });

  it('refuses a slide over the cap after the update', () => {
    expect(() =>
      apply(
        [
          {
            op: 'block_update',
            slide: 's1',
            block_id: 'h1',
            source: 'y'.repeat(MAX_SLIDE_HTML - 50),
          },
        ],
        withBlocks()
      )
    ).toThrow(/over the 200000 limit/);
  });
});

describe('block_delete', () => {
  it('removes exactly that block', () => {
    const start = apply([
      { op: 'block_add', slide: 's1', type: 'html', box: BOX, source: 'a', block_id: 'a1' },
      { op: 'block_add', slide: 's1', type: 'html', box: BOX, source: 'b', block_id: 'b1' },
    ]).deck;
    const { deck: next, applied } = apply(
      [{ op: 'block_delete', slide: 's1', block_id: 'a1' }],
      start
    );
    expect(readSlideBlocks(html(next, 's1')).map(b => b.id)).toEqual(['b1']);
    expect(html(next, 's1').startsWith('<h2>Title</h2>')).toBe(true);
    expect(applied).toEqual([{ op: 'block_delete', slide: 's1', block_id: 'a1' }]);
  });

  it('an unknown block is a DeckOpError naming the slide; a stack container is refused', () => {
    expect(() => apply([{ op: 'block_delete', slide: 's1', block_id: 'nope' }])).toThrow(
      DeckOpError
    );
    expect(() => apply([{ op: 'block_delete', slide: 's1', block_id: 'nope' }])).toThrow(
      /slide 's1'/
    );
    expect(() => apply([{ op: 'block_delete', slide: 'stack', block_id: 'x' }])).toThrow(
      /vertical stack container/
    );
  });
});

describe('blocks made before block ids', () => {
  const OLD =
    '<div class="sl-block" data-block-type="iframe" style="left: 10px; top: 10px; width: 200px; height: 100px;">' +
    '<div class="sl-block-content"><iframe data-src="https://example.com/a"></iframe></div></div>' +
    '<div class="sl-block" data-block-type="iframe" style="left: 10px; top: 200px; width: 200px; height: 100px;">' +
    '<div class="sl-block-content"><iframe data-src="https://example.com/a"></iframe></div></div>';
  const oldDeck = (): DeckJson =>
    ({ ...deck(), slides: [{ id: 's1', html: normalizeSlideHtml(OLD) }] }) as DeckJson;

  it('derive the same unique ids every time, and leave an all-ids slide alone', () => {
    const start = html(oldDeck(), 's1');
    expect(readSlideBlocks(start).map(b => b.id)).toEqual([null, null]);
    const once = ensureSlideBlockIds(start);
    const ids = readSlideBlocks(once).map(b => b.id);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(new Set(ids).size).toBe(2); // identical blocks, distinct ids
    expect(ensureSlideBlockIds(start)).toBe(once);
    expect(ensureSlideBlockIds(once)).toBe(once);
  });

  it('block_update reaches one by the derived id, and the write stores the ids', () => {
    const [first, second] = readSlideBlocks(ensureSlideBlockIds(html(oldDeck(), 's1'))).map(
      b => b.id as string
    );
    const { deck: out } = apply(
      [{ op: 'block_update', slide: 's1', block_id: second, box: { left: 300 } }],
      oldDeck()
    );
    const blocks = readSlideBlocks(html(out, 's1'));
    expect(blocks.map(b => b.id)).toEqual([first, second]);
    expect(blocks[1].box.left).toBe(300);
  });

  it('a pasted copy repeating an id gets its own; the first keeps it', () => {
    const one = OLD.slice(0, OLD.indexOf('</div></div>') + '</div></div>'.length);
    const tagged = one.replace('class="sl-block"', 'class="sl-block" data-cm-block-id="b1"');
    const out = ensureSlideBlockIds(normalizeSlideHtml(tagged + tagged));
    const ids = readSlideBlocks(out).map(b => b.id);
    expect(ids[0]).toBe('b1');
    expect(ids[1]).toMatch(/^[0-9a-f]{8}$/);
  });

  it('an id block ops could not name gets a derived one', () => {
    const one = OLD.slice(0, OLD.indexOf('</div></div>') + '</div></div>'.length);
    const odd = one.replace('class="sl-block"', 'class="sl-block" data-cm-block-id="has space"');
    const [block] = readSlideBlocks(ensureSlideBlockIds(normalizeSlideHtml(odd)));
    expect(block.id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('block_delete reaches one by the derived id', () => {
    const [first, second] = readSlideBlocks(ensureSlideBlockIds(html(oldDeck(), 's1'))).map(
      b => b.id as string
    );
    const { deck: out } = apply([{ op: 'block_delete', slide: 's1', block_id: first }], oldDeck());
    expect(readSlideBlocks(html(out, 's1')).map(b => b.id)).toEqual([second]);
  });
});

describe('iframe src', () => {
  it('accepts https URLs, /content/ paths and deck paths', () => {
    expect(checkBlockFrameSrc(' https://example.com/a?b=1 ')).toBe('https://example.com/a?b=1');
    expect(checkBlockFrameSrc('/content/o/r/slides/d/games/x/index.html')).toBe(
      '/content/o/r/slides/d/games/x/index.html'
    );
    expect(checkBlockFrameSrc('games/x/index.html')).toBe('games/x/index.html');
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>1</script>',
    'http://example.com/',
    'blob:https://example.com/x',
    '//evil.example/x',
    '/admin/x',
    '../other/index.html',
    '/content/o/r/../../x',
    'games/../../x.html',
    'games/%2e%2e/%2E%2E/x.html',
    '/content/o/r/%2e%2e/x',
    'games%2f..%2fx.html',
    'games/%zz.html',
    'a b.html',
    'a\\b.html',
    '',
    '#top',
  ])('refuses %j', src => {
    expect(() => checkBlockFrameSrc(src)).toThrow(DeckOpError);
  });

  const ctx = { org: 'org', repo: 'repo', contentPath: 'slides/my-deck' };

  it('resolves deck paths and in-deck repo paths to /content URLs', () => {
    expect(resolveDeckFrameSrc('games/minions/index.html', ctx)).toBe(
      '/content/org/repo/slides/my-deck/games/minions/index.html'
    );
    expect(resolveDeckFrameSrc('./games/minions/index.html?x=1#y', ctx)).toBe(
      '/content/org/repo/slides/my-deck/games/minions/index.html?x=1#y'
    );
    // What file_upload_status reports for a deck file: the repo path.
    expect(resolveDeckFrameSrc('slides/my-deck/games/minions/index.html', ctx)).toBe(
      '/content/org/repo/slides/my-deck/games/minions/index.html'
    );
    expect(resolveDeckFrameSrc('https://example.com/x', ctx)).toBe('https://example.com/x');
    expect(resolveDeckFrameSrc('/content/a/b/c.html', ctx)).toBe('/content/a/b/c.html');
    // Left for the engine to refuse.
    expect(resolveDeckFrameSrc('../x.html', ctx)).toBe('../x.html');
    expect(resolveDeckFrameSrc('javascript:1', ctx)).toBe('javascript:1');
  });

  it('prepareDeckOps mints block_add ids and resolves srcs, leaving the input alone', () => {
    const ops: DeckOp[] = [
      { op: 'block_add', slide: 's1', type: 'iframe', box: BOX, src: 'games/x/index.html' },
      { op: 'block_add', slide: 's1', type: 'html', box: BOX, source: 'x', block_id: 'keep' },
      { op: 'block_update', slide: 's1', block_id: 'f', src: 'games/y/index.html' },
      { op: 'update', id: 's1', html: '<p>games/x</p>' },
    ];
    const snapshot = structuredClone(ops);
    const prepared = prepareDeckOps(ops, ctx);
    expect(ops).toEqual(snapshot);
    const [add, keep, update, plain] = prepared as Array<Record<string, unknown>>;
    expect(add.block_id).toMatch(/^[0-9a-f]{8}$/);
    expect(add.src).toBe('/content/org/repo/slides/my-deck/games/x/index.html');
    expect(keep.block_id).toBe('keep');
    expect(update.src).toBe('/content/org/repo/slides/my-deck/games/y/index.html');
    expect(plain).toBe(ops[3]);
    // A dry run and a second application with the prepared ops name the same block.
    const first = applyDeckOps(deck(), [prepared[0]]);
    const second = applyDeckOps(deck(), [prepared[0]]);
    expect(first.applied[0].block_id).toBe(add.block_id);
    expect(html(first.deck, 's1')).toBe(html(second.deck, 's1'));
  });
});
