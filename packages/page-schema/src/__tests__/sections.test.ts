import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parsePageContent } from '../content.ts';
import {
  checkableHeadingIds,
  checkableSectionRanges,
  findBlock,
  isCheckableHeading,
  isLockedSection,
  lockedSectionIds,
  headingText,
  lockedSectionTitle,
  redactLockedSections,
  type SectionBlock,
} from '../sections.ts';

const text = (value: string) => [{ type: 'text', text: value, styles: {} }];

const p = (id: string, children: unknown[] = []) => ({
  id,
  type: 'paragraph',
  props: {},
  content: text(id),
  children,
});

const h = (id: string, level: number, checkable?: boolean, children: unknown[] = []) => ({
  id,
  type: 'heading',
  props: { level, isToggleable: false, ...(checkable === undefined ? {} : { checkable }) },
  content: text(id),
  children,
});

const locked = (id: string, title: string, children: unknown[]) => ({
  id,
  type: 'lockedSection',
  props: { title },
  children,
});

/** Freeze every object and array reachable from `value` (mutation then throws). */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Every string anywhere in `value` (to assert a body's words are gone). */
function allText(value: unknown): string {
  return JSON.stringify(value);
}

/** A page with locked sections at every kind of depth. */
function sample() {
  return deepFreeze([
    h('h1', 1, true),
    p('intro'),
    locked('L1', 'Solution', [
      p('L1-body'),
      locked('L1-inner', 'Hint inside', [p('L1-inner-body')]),
    ]),
    {
      id: 'cols',
      type: 'columnList',
      props: {},
      children: [
        {
          id: 'col-a',
          type: 'column',
          props: { width: 1 },
          children: [locked('L-col', 'In a column', [p('L-col-body')])],
        },
        { id: 'col-b', type: 'column', props: { width: 1 }, children: [p('col-b-p')] },
      ],
    },
    {
      id: 'toggle',
      type: 'toggleListItem',
      props: {},
      content: text('toggle'),
      children: [locked('L-toggle', 'In a toggle', [p('L-toggle-body')])],
    },
    {
      id: 'li',
      type: 'bulletListItem',
      props: {},
      content: text('li'),
      children: [
        {
          id: 'li-nested',
          type: 'bulletListItem',
          props: {},
          content: text('li-nested'),
          children: [locked('L-list', 'In a list', [p('L-list-body')])],
        },
      ],
    },
    p('outro'),
  ]);
}

describe('redactLockedSections', () => {
  it('removes every locked body when nothing is revealed, at every depth', () => {
    const out = redactLockedSections(sample(), () => false);
    const body = allText(out);
    for (const secret of ['L1-body', 'L1-inner', 'L-col-body', 'L-toggle-body', 'L-list-body']) {
      expect(body, secret).not.toContain(secret);
    }
    // Titles stay; the stub keeps type, id and props (the title).
    for (const id of ['L1', 'L-col', 'L-toggle', 'L-list']) {
      const block = findBlock(out, id);
      expect(block?.type).toBe('lockedSection');
      expect(block?.children).toEqual([]);
      expect(typeof (block?.props as { title?: unknown }).title).toBe('string');
    }
    expect(lockedSectionTitle(findBlock(out, 'L1'))).toBe('Solution');
    expect(body).toContain('outro');
    expect(body).toContain('col-b-p');
  });

  it('reveals only the ids asked for; a nested lock needs its own id', () => {
    const outer = redactLockedSections(sample(), id => id === 'L1');
    expect(allText(outer)).toContain('L1-body');
    expect(findBlock(outer, 'L1-inner')?.children).toEqual([]);
    expect(allText(outer)).not.toContain('L1-inner-body');

    const both = redactLockedSections(sample(), id => id === 'L1' || id === 'L1-inner');
    expect(allText(both)).toContain('L1-inner-body');

    // The inner id alone reveals nothing: its parent's body is gone with it.
    const innerOnly = redactLockedSections(sample(), id => id === 'L1-inner');
    expect(allText(innerOnly)).not.toContain('L1-body');
    expect(allText(innerOnly)).not.toContain('L1-inner-body');
  });

  it('reveal-all returns the input unchanged (same array)', () => {
    const input = sample();
    expect(redactLockedSections(input, () => true)).toBe(input);
  });

  it('never mutates its input and shares untouched subtrees', () => {
    const input = sample(); // deep-frozen: any write throws
    const snapshot = JSON.stringify(input);
    const out = redactLockedSections(input, () => false);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(out).not.toBe(input);
    // Untouched blocks are the same objects.
    expect(out[0]).toBe(input[0]);
    expect(out[1]).toBe(input[1]);
    expect(out[out.length - 1]).toBe(input[input.length - 1]);
    // In the column list, the column without a lock is shared, the other copied.
    const cols = out[3] as SectionBlock;
    const inCols = input[3] as SectionBlock;
    expect(cols).not.toBe(inCols);
    expect((cols.children as unknown[])[1]).toBe((inCols.children as unknown[])[1]);
    expect((cols.children as unknown[])[0]).not.toBe((inCols.children as unknown[])[0]);
  });

  it('a document without locked sections comes back as the same array', () => {
    const doc = deepFreeze([h('a', 2, true), p('b', [p('c')])]);
    expect(redactLockedSections(doc, () => false)).toBe(doc);
  });

  it('an already-empty locked section is left as is', () => {
    const doc = deepFreeze([locked('L', 'Empty', [])]);
    expect(redactLockedSections(doc, () => false)).toBe(doc);
  });

  it('fails closed: a locked section without a usable id is never revealed', () => {
    const doc = deepFreeze([
      { type: 'lockedSection', props: { title: 'no id' }, children: [p('secret-a')] },
      { id: 42, type: 'lockedSection', props: { title: 'numeric id' }, children: [p('secret-b')] },
      { id: '', type: 'lockedSection', props: { title: 'empty id' }, children: [p('secret-c')] },
    ]);
    const calls: string[] = [];
    const out = redactLockedSections(doc, id => {
      calls.push(id);
      return true;
    });
    expect(calls).toEqual([]);
    expect(allText(out)).not.toMatch(/secret-/);
  });

  it('stubs a locked section whose children are malformed', () => {
    const doc = deepFreeze([
      { id: 'L', type: 'lockedSection', props: { title: 't' }, children: { secret: 'x' } },
      { id: 'M', type: 'lockedSection', props: { title: 't' } },
    ]);
    const out = redactLockedSections(doc, () => false) as SectionBlock[];
    expect(out[0].children).toEqual([]);
    expect(out[1].children).toEqual([]);
  });

  it('tolerates malformed input without throwing', () => {
    const odd = [null, 1, 'x', [], { children: 'nope' }, { type: 'paragraph' }];
    expect(() => redactLockedSections(odd, () => false)).not.toThrow();
    expect(redactLockedSections(odd, () => false)).toBe(odd);
    expect(redactLockedSections(null as unknown, () => false)).toBe(null);
    expect(redactLockedSections({ blocks: [] } as unknown, () => false)).toEqual({ blocks: [] });
  });

  it('keeps every other key of the stub (id, type, props, content, extra keys)', () => {
    const block = { ...locked('L', 'T', [p('x')]), extra: 1 };
    const [stub] = redactLockedSections([block], () => false) as SectionBlock[];
    expect(stub).toEqual({ ...block, children: [] });
  });
});

describe('findBlock', () => {
  it('finds blocks at any depth, or null', () => {
    const doc = sample();
    expect(findBlock(doc, 'intro')?.type).toBe('paragraph');
    expect(findBlock(doc, 'L1-inner')?.type).toBe('lockedSection');
    expect(findBlock(doc, 'L-list-body')?.type).toBe('paragraph');
    expect(findBlock(doc, 'col-b')?.type).toBe('column');
    expect(findBlock(doc, 'missing')).toBeNull();
    expect(findBlock(doc, '')).toBeNull();
    expect(findBlock(null, 'x')).toBeNull();
    expect(findBlock([null, 3, { children: 'x' }], 'x')).toBeNull();
  });

  it('cannot find what redaction removed', () => {
    const out = redactLockedSections(sample(), () => false);
    expect(findBlock(out, 'L1-inner')).toBeNull();
    expect(findBlock(out, 'L1-body')).toBeNull();
    expect(findBlock(out, 'L1')).not.toBeNull();
  });
});

describe('lockedSectionIds / checkableHeadingIds', () => {
  it('lists ids in document order at every depth', () => {
    expect(lockedSectionIds(sample())).toEqual(['L1', 'L1-inner', 'L-col', 'L-toggle', 'L-list']);
    expect(lockedSectionIds(redactLockedSections(sample(), () => false))).toEqual([
      'L1',
      'L-col',
      'L-toggle',
      'L-list',
    ]);
  });

  it('only headings with checkable === true are checkable', () => {
    const doc = [
      h('a', 1, true),
      h('b', 2, false),
      h('c', 2),
      { id: 'd', type: 'heading', props: { level: 2, checkable: 'true' } },
      { id: 'e', type: 'paragraph', props: { checkable: true } },
      locked('L', 'x', [h('f', 3, true)]),
      { id: 'cols', type: 'columnList', children: [{ id: 'col', children: [h('g', 2, true)] }] },
    ];
    expect(checkableHeadingIds(doc)).toEqual(['a', 'f', 'g']);
    expect(isCheckableHeading(doc[0])).toBe(true);
    expect(isCheckableHeading(doc[3])).toBe(false);
    expect(isLockedSection(doc[5])).toBe(true);
    expect(isLockedSection(doc[0])).toBe(false);
    expect(checkableHeadingIds(null)).toEqual([]);
    expect(lockedSectionIds('x')).toEqual([]);
  });
});

describe('checkableSectionRanges', () => {
  it('runs from the heading to the next heading of the same or higher level', () => {
    const doc = [
      p('before'),
      h('s1', 2, true),
      p('s1-a'),
      h('s1-sub', 3), // a lower level stays inside
      p('s1-b'),
      h('s2', 2, true), // same level ends s1
      p('s2-a', [p('s2-a-child')]),
      h('top', 1), // higher level ends s2
      p('after'),
    ];
    const ranges = checkableSectionRanges(doc);
    expect([...ranges.keys()]).toEqual(['s1', 's2']);
    expect(ranges.get('s1')).toEqual(['s1', 's1-a', 's1-sub', 's1-b']);
    // Children of a listed block are not listed.
    expect(ranges.get('s2')).toEqual(['s2', 's2-a']);
  });

  it('a nested checkable heading ends at the parent level too', () => {
    const doc = [h('a', 2, true), h('b', 3, true), p('b-1'), h('c', 2), p('c-1')];
    const ranges = checkableSectionRanges(doc);
    expect(ranges.get('a')).toEqual(['a', 'b', 'b-1']);
    expect(ranges.get('b')).toEqual(['b', 'b-1']);
  });

  it('runs to the end of the list when no heading follows', () => {
    const ranges = checkableSectionRanges([h('a', 3, true), p('x'), p('y')]);
    expect(ranges.get('a')).toEqual(['a', 'x', 'y']);
  });

  it('stays within its own sibling list (columns, toggles, locked bodies)', () => {
    const doc = [
      {
        id: 'cols',
        type: 'columnList',
        children: [
          { id: 'col-a', type: 'column', children: [h('ca', 2, true), p('ca-1')] },
          { id: 'col-b', type: 'column', children: [p('cb-1')] },
        ],
      },
      locked('L', 'x', [h('lh', 3, true), p('lh-1')]),
      h('toggle-h', 2, true, [p('toggle-child')]),
      p('after-toggle'),
    ];
    const ranges = checkableSectionRanges(doc);
    expect(ranges.get('ca')).toEqual(['ca', 'ca-1']);
    expect(ranges.get('lh')).toEqual(['lh', 'lh-1']);
    expect(ranges.get('toggle-h')).toEqual(['toggle-h', 'after-toggle']);
  });

  it('skips blocks without ids, treats a missing level as 1, tolerates junk', () => {
    const doc = [
      h('a', 2, true),
      { type: 'paragraph' },
      null,
      p('x'),
      { id: 'no-level', type: 'heading', props: { checkable: true } },
      p('y'),
      h('z', 1),
    ];
    const ranges = checkableSectionRanges(doc);
    // The level-less heading counts as level 1, so it ends `a`.
    expect(ranges.get('a')).toEqual(['a', 'x']);
    expect(ranges.get('no-level')).toEqual(['no-level', 'y']);
    expect(checkableSectionRanges(null).size).toBe(0);
    expect(checkableSectionRanges([{ type: 'heading', props: { checkable: true } }]).size).toBe(0);
  });
});

describe('headingText', () => {
  it('is the plain text of the inline content, links and styles included', () => {
    expect(
      headingText({
        type: 'heading',
        content: [
          { type: 'text', text: 'Part ', styles: { bold: true } },
          { type: 'link', href: 'https://x', content: [{ type: 'text', text: 'two', styles: {} }] },
          { type: 'text', text: '  ', styles: {} },
        ],
      })
    ).toBe('Part two');
    expect(headingText({ content: 'plain' })).toBe('plain');
    expect(headingText({ content: [null, 3, {}] })).toBe('');
    expect(headingText(null)).toBe('');
  });
});

describe('lockedSectionTitle', () => {
  it('is props.title, trimmed', () => {
    expect(lockedSectionTitle(locked('L', '  Part two ', []))).toBe('Part two');
  });

  it('never reads the body or inline content', () => {
    expect(
      lockedSectionTitle({
        type: 'lockedSection',
        props: {},
        content: text('not the title'),
        children: [p('secret')],
      })
    ).toBe('');
  });

  it('is empty for a missing or odd title', () => {
    expect(lockedSectionTitle({ type: 'lockedSection' })).toBe('');
    expect(lockedSectionTitle(null)).toBe('');
    expect(lockedSectionTitle({ props: { title: 3 } })).toBe('');
    expect(lockedSectionTitle({ props: 'title' })).toBe('');
  });
});

describe('the kitchen-sink fixture', () => {
  const kitchen = parsePageContent(
    readFileSync(new URL('./fixtures/kitchen-sink.content.json', import.meta.url), 'utf8')
  );

  it('has a checkable heading and nested locked sections', () => {
    expect(checkableHeadingIds(kitchen.blocks)).toEqual(['ks-h2-checkable', 'ks-locked-h']);
    expect(lockedSectionIds(kitchen.blocks)).toEqual(['ks-locked', 'ks-locked-nested']);
    expect(checkableSectionRanges(kitchen.blocks).get('ks-h2-checkable')).toEqual([
      'ks-h2-checkable',
      'ks-h2-checkable-p',
      'ks-locked',
      'ks-nested-parent',
      'ks-empty',
    ]);
  });

  it('redacts to titles only', () => {
    const out = redactLockedSections(kitchen.blocks, () => false);
    expect(allText(out)).not.toContain('The locked body');
    expect(allText(out)).not.toContain('Hint inside the solution');
    expect(lockedSectionTitle(findBlock(out, 'ks-locked'))).toBe('Solution (unlock when stuck)');
  });
});
