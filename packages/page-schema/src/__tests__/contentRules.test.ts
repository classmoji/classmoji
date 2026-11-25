/**
 * Page content judged by BlockNote's STOCK style rules (validatePageBlocks)
 * and made to fit them (cleanPageBlocks). The failing shapes are the ones
 * stored pages hold: inline code that is also bold/italic, code inside a
 * link, and a link stored as a text style (`styles.href`).
 */
import { readFileSync } from 'node:fs';
import { BlockNoteEditor } from '@blocknote/core';
import { describe, expect, it } from 'vitest';

import { CODE_EXCLUDED_STYLES, cleanPageBlocks } from '../cleanContent.ts';
import { createStrictPageSchema } from '../schema.ts';
import { strictPmSchema, validatePageBlocks } from '../validateContent.ts';

const text = (t: string, styles: Record<string, unknown> = {}) => ({
  type: 'text',
  text: t,
  styles,
});
const para = (id: string, content: unknown[], children: unknown[] = []) => ({
  id,
  type: 'paragraph',
  props: {},
  content,
  children,
});

const boldCode = () => [para('p1', [text('useFetcher', { bold: true, code: true })])];
const linkCode = () => [
  para('p1', [
    {
      type: 'link',
      href: 'https://react.dev/reference/react/StrictMode',
      content: [text('<StrictMode>', { code: true })],
    },
  ]),
];
/** The shape of the prod page that fails under any schema: a link stored as a style. */
const hrefStyle = () => [
  {
    id: 'n1',
    type: 'numberedListItem',
    props: {},
    content: [
      text('Read '),
      text('the style guide', {
        href: 'https://kotlinlang.org/docs/coding-conventions.html',
      }),
      text(' and ', {}),
      text('Android', { href: 'https://developer.android.com', bold: true }),
      text(' docs', { href: 'https://developer.android.com' }),
    ],
    children: [],
  },
];

/** Whether BlockNote itself (stock styles) builds an editor from the blocks. */
function opensInStockEditor(blocks: unknown[]): boolean {
  try {
    BlockNoteEditor.create({
      schema: createStrictPageSchema(),
      initialContent: blocks as never,
    });
    return true;
  } catch {
    return false;
  }
}

describe('the stock rules', () => {
  it("names exactly the marks BlockNote's own code mark excludes", () => {
    const marks = strictPmSchema().marks;
    const code = marks.code;
    const excluded = Object.values(marks)
      .filter(mark => code.excludes(mark))
      .map(mark => mark.name)
      .sort();
    expect(excluded).toEqual([...CODE_EXCLUDED_STYLES, 'code', 'link'].sort());
  });
});

describe('validatePageBlocks', () => {
  it('passes valid content', () => {
    expect(
      validatePageBlocks([
        para('p1', [text('a', { code: true }), text('b', { bold: true, italic: true })]),
      ])
    ).toEqual([]);
    expect(validatePageBlocks([])).toEqual([]);
  });

  it('reports code that is also bold, naming the block and the run', () => {
    expect(validatePageBlocks(boldCode())).toEqual([
      {
        blockId: 'p1',
        blockType: 'paragraph',
        problem: "inline code can't also be bold",
        text: 'useFetcher',
      },
    ]);
  });

  it('reports code inside a link', () => {
    expect(validatePageBlocks(linkCode())).toEqual([
      expect.objectContaining({
        blockId: 'p1',
        problem: "inline code can't be inside a link",
      }),
    ]);
  });

  it('reports every bad run, nested blocks and table cells included', () => {
    const blocks = [
      para(
        'p1',
        [
          text('x', { code: true, italic: true }),
          text('y', { code: true, bold: true, italic: true }),
        ],
        [para('child', [text('z', { code: true, strike: true })])]
      ),
      {
        id: 't1',
        type: 'table',
        props: {},
        content: {
          type: 'tableContent',
          rows: [
            {
              cells: [[text('cell', { code: true, underline: true })], [text('ok')]],
            },
          ],
        },
        children: [],
      },
    ];
    expect(validatePageBlocks(blocks).map(p => [p.blockId, p.problem])).toEqual([
      ['p1', "inline code can't also be italic"],
      ['p1', "inline code can't also be bold or italic"],
      ['child', "inline code can't also be struck through"],
      ['t1', "inline code can't also be underlined"],
    ]);
  });

  it('reports an unknown text style per run, on the block holding it', () => {
    expect(validatePageBlocks(hrefStyle())).toEqual([
      {
        blockId: 'n1',
        blockType: 'numberedListItem',
        problem: "unknown text style 'href'",
        text: 'the style guide',
      },
      expect.objectContaining({ problem: "unknown text style 'href'", text: 'Android' }),
      expect.objectContaining({ problem: "unknown text style 'href'", text: 'docs' }),
    ]);
    const nested = [para('p1', [text('fine')], [para('kid', [text('x', { glow: true })])])];
    expect(validatePageBlocks(nested)).toEqual([
      { blockId: 'kid', blockType: 'paragraph', problem: "unknown text style 'glow'", text: 'x' },
    ]);
  });

  it('an unknown style hides no other problem in its block', () => {
    const blocks = [
      para('p1', [
        text('both', { code: true, bold: true }),
        text('link', { href: 'https://a.dev' }),
        text('glowing', { glow: true }),
        { type: 'link', href: 'https://b.dev', content: [text('linked code', { code: true })] },
      ]),
    ];
    expect(validatePageBlocks(blocks).map(p => [p.blockId, p.problem, p.text])).toEqual([
      ['p1', "unknown text style 'href'", 'link'],
      ['p1', "unknown text style 'glow'", 'glowing'],
      ['p1', "inline code can't also be bold", 'both'],
      ['p1', "inline code can't be inside a link", 'linked code'],
    ]);
    expect(opensInStockEditor(blocks)).toBe(false);
    expect(validatePageBlocks(cleanPageBlocks(blocks).blocks)).toEqual([]);
  });

  it('styles that are not an object, and unknown inline content, are named as such', () => {
    const blocks = [
      para('p1', [
        { type: 'text', text: 'listed', styles: ['bold'] },
        { type: 'mention', user: 'ada' },
      ]),
    ];
    expect(validatePageBlocks(blocks).map(p => p.problem)).toEqual([
      'text styles must be an object of style names',
      "unknown inline content type 'mention'",
    ]);
    const { blocks: cleaned, changes } = cleanPageBlocks([
      para('p1', [{ type: 'text', text: 'listed', styles: ['bold'] }]),
    ]);
    expect(changes.map(c => c.change)).toEqual(['dropped text styles that were not an object']);
    expect(validatePageBlocks(cleaned)).toEqual([]);
  });

  it('a part that does not build hides nothing else in its tree', () => {
    const blocks = [
      para(
        'top',
        [text('own', { glow: true })],
        [
          para('kid-a', [text('a', { href: 'https://a.dev' })]),
          para('kid-b', [text('b', { code: true, bold: true })]),
          para('kid-c', [text('fine')]),
        ]
      ),
    ];
    expect(validatePageBlocks(blocks).map(p => [p.blockId, p.problem])).toEqual([
      ['top', "unknown text style 'glow'"],
      ['kid-a', "unknown text style 'href'"],
      ['kid-b', "inline code can't also be bold"],
    ]);
  });

  it('reports an unknown block type', () => {
    expect(validatePageBlocks([{ id: 'w', type: 'widget', props: {}, content: [] }])).toEqual([
      {
        blockId: 'w',
        blockType: 'widget',
        problem: "unknown block type 'widget'",
      },
    ]);
  });

  it('judges code blocks as readers draw them: stored runs and links are flattened', () => {
    const code = [
      {
        id: 'c1',
        type: 'codeBlock',
        props: { language: 'js' },
        content: [
          text('let a', { bold: true, code: true }),
          { type: 'link', href: 'https://x.dev', content: [text(' = 1')] },
        ],
        children: [],
      },
    ];
    expect(validatePageBlocks(code)).toEqual([]);
  });

  it('leaves a falsy style alone: it builds no mark', () => {
    expect(validatePageBlocks([para('p1', [text('a', { code: true, bold: false })])])).toEqual([]);
  });

  it('agrees with BlockNote itself on every shape', () => {
    const cases: unknown[][] = [
      boldCode(),
      linkCode(),
      hrefStyle(),
      [para('p1', [text('a', { code: true, textColor: 'red' })])],
      [para('p1', [text('a', { code: true, backgroundColor: 'blue' })])],
      [para('p1', [text('a', { code: true, bold: false })])],
      [para('p1', [text('a', { code: true }), text('b', { bold: true })])],
      [{ id: 'w', type: 'widget', props: {}, content: [] }],
      cleanPageBlocks(boldCode()).blocks,
      cleanPageBlocks(linkCode()).blocks,
      cleanPageBlocks(hrefStyle()).blocks,
    ];
    for (const blocks of cases) {
      expect(validatePageBlocks(blocks).length === 0, JSON.stringify(blocks)).toBe(
        opensInStockEditor(blocks)
      );
    }
  });
});

describe('cleanPageBlocks', () => {
  it('keeps the code and drops the formatting beside it', () => {
    const { blocks, changes } = cleanPageBlocks([
      para('p1', [
        text('a', { bold: true, code: true }),
        text('b', {
          code: true,
          italic: true,
          textColor: 'red',
          backgroundColor: 'blue',
        }),
      ]),
    ]);
    expect(blocks[0].content).toEqual([text('a', { code: true }), text('b', { code: true })]);
    expect(changes.map(c => c.change)).toEqual([
      'dropped bold from inline code (the code stays)',
      'dropped italic from inline code (the code stays)',
      'dropped textColor from inline code (the code stays)',
      'dropped backgroundColor from inline code (the code stays)',
    ]);
    expect(changes[0]).toMatchObject({
      blockId: 'p1',
      blockType: 'paragraph',
      text: 'a',
    });
  });

  it('keeps the link and drops the code inside it', () => {
    const { blocks } = cleanPageBlocks(linkCode());
    expect(blocks[0].content).toEqual([
      {
        type: 'link',
        href: 'https://react.dev/reference/react/StrictMode',
        content: [text('<StrictMode>', {})],
      },
    ]);
  });

  it('turns a link stored as a style into a link, merging neighbours with the same href', () => {
    const { blocks, changes } = cleanPageBlocks(hrefStyle());
    expect(blocks[0].content).toEqual([
      text('Read '),
      {
        type: 'link',
        href: 'https://kotlinlang.org/docs/coding-conventions.html',
        content: [text('the style guide', {})],
      },
      text(' and ', {}),
      {
        type: 'link',
        href: 'https://developer.android.com',
        content: [text('Android', { bold: true }), text(' docs', {})],
      },
    ]);
    expect(changes).toHaveLength(3);
    expect(validatePageBlocks(blocks)).toEqual([]);
  });

  it('an href style with code becomes a link without the code', () => {
    const { blocks } = cleanPageBlocks([
      para('p1', [text('x', { href: 'https://a.dev', code: true, bold: true })]),
    ]);
    expect(blocks[0].content).toEqual([
      {
        type: 'link',
        href: 'https://a.dev',
        content: [text('x', { bold: true })],
      },
    ]);
  });

  it('drops an href style inside a link (links do not nest) and any other unknown style', () => {
    const { blocks } = cleanPageBlocks([
      para('p1', [
        {
          type: 'link',
          href: 'https://a.dev',
          content: [text('x', { href: 'https://b.dev' })],
        },
        text('y', { glow: true, bold: true }),
        text('z', { href: '' }),
      ]),
    ]);
    expect(blocks[0].content).toEqual([
      { type: 'link', href: 'https://a.dev', content: [text('x', {})] },
      text('y', { bold: true }),
      text('z', {}),
    ]);
  });

  it('cleans table cells and nested children, and leaves code blocks to the reader', () => {
    const codeBlock = {
      id: 'c1',
      type: 'codeBlock',
      props: {},
      content: [text('x', { code: true, bold: true })],
      children: [],
    };
    const input = [
      para('p1', [text('ok')], [para('kid', [text('k', { code: true, bold: true })])]),
      {
        id: 't1',
        type: 'table',
        props: {},
        content: {
          type: 'tableContent',
          rows: [
            {
              cells: [
                [text('a', { code: true, italic: true })],
                {
                  type: 'tableCell',
                  props: {},
                  content: [text('b', { code: true, bold: true })],
                },
                'plain',
              ],
            },
          ],
        },
        children: [],
      },
      codeBlock,
    ];
    const { blocks, changes } = cleanPageBlocks(input);
    expect(changes.map(c => c.blockId)).toEqual(['kid', 't1', 't1']);
    expect(blocks[2]).toBe(codeBlock);
    expect(validatePageBlocks(blocks)).toEqual([]);
    // The input is not mutated.
    expect((input[0].children[0] as { content: unknown[] }).content[0]).toEqual(
      text('k', { code: true, bold: true })
    );
  });

  it('leaves valid content untouched: the same array, byte for byte', () => {
    const fixture = JSON.parse(
      readFileSync(new URL('./fixtures/kitchen-sink.content.json', import.meta.url), 'utf8')
    ) as { blocks: unknown[] };
    const before = JSON.stringify(fixture.blocks);
    const { blocks, changes } = cleanPageBlocks(fixture.blocks);
    expect(blocks).toBe(fixture.blocks);
    expect(changes).toEqual([]);
    expect(JSON.stringify(blocks)).toBe(before);

    const falsy = [para('p1', [text('a', { code: true, bold: false })])];
    expect(cleanPageBlocks(falsy).blocks).toBe(falsy);
  });

  it('is idempotent, and what it returns passes the stock rules', () => {
    for (const input of [boldCode(), linkCode(), hrefStyle()]) {
      const once = cleanPageBlocks(input);
      expect(validatePageBlocks(once.blocks)).toEqual([]);
      const twice = cleanPageBlocks(once.blocks);
      expect(twice.blocks).toBe(once.blocks);
      expect(twice.changes).toEqual([]);
    }
  });

  it('takes anything: a non-array comes back as it is', () => {
    expect(cleanPageBlocks(null)).toEqual({ blocks: null, changes: [] });
  });

  it('keepCodeMarks (what the app schemas still draw): code marks stay, the rest is cleaned', () => {
    const bold = boldCode();
    expect(cleanPageBlocks(bold, { keepCodeMarks: true }).blocks).toBe(bold);
    const link = linkCode();
    expect(cleanPageBlocks(link, { keepCodeMarks: true }).blocks).toBe(link);
    const { blocks } = cleanPageBlocks(
      [para('p1', [text('x', { href: 'https://a.dev', code: true }), text('y', { glow: true })])],
      { keepCodeMarks: true }
    );
    expect(blocks[0].content).toEqual([
      { type: 'link', href: 'https://a.dev', content: [text('x', { code: true })] },
      text('y', {}),
    ]);
  });
});
