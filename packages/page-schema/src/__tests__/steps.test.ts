import { describe, expect, it } from 'vitest';

import { isStepHeading, stepLayout } from '../sections.ts';
import { validatePageBlocks } from '../validateContent.ts';

const heading = (id: string, level: number, step?: boolean, children: unknown[] = []) => ({
  id,
  type: 'heading',
  props: { level, ...(step === undefined ? {} : { step }) },
  content: [{ type: 'text', text: id, styles: {} }],
  children,
});
const para = (id: string) => ({ id, type: 'paragraph', props: {}, content: [], children: [] });

describe('isStepHeading', () => {
  it('is a heading with step true at level 1 or 2', () => {
    expect(isStepHeading(heading('a', 1, true))).toBe(true);
    expect(isStepHeading(heading('a', 2, true))).toBe(true);
  });

  it('ignores the prop on a deeper heading, a plain heading and other blocks', () => {
    expect(isStepHeading(heading('a', 3, true))).toBe(false);
    expect(isStepHeading(heading('a', 6, true))).toBe(false);
    expect(isStepHeading(heading('a', 1))).toBe(false);
    expect(isStepHeading(heading('a', 1, false))).toBe(false);
    expect(isStepHeading({ ...para('p'), props: { step: true } })).toBe(false);
  });
});

describe('stepLayout', () => {
  it('numbers consecutive step headings and gives each its section', () => {
    const layout = stepLayout([
      para('intro'),
      heading('s1', 1, true),
      para('a'),
      para('b'),
      heading('s2', 1, true),
      para('c'),
      heading('s3', 1, true),
    ]);
    expect([...layout.keys()]).toEqual(['s1', 's2', 's3']);
    expect(layout.get('s1')).toMatchObject({
      number: 1,
      ids: ['s1', 'a', 'b'],
      hasPrev: false,
      hasNext: true,
      firstInList: false,
    });
    expect(layout.get('s2')).toMatchObject({
      number: 2,
      ids: ['s2', 'c'],
      hasPrev: true,
      hasNext: true,
    });
    expect(layout.get('s3')).toMatchObject({
      number: 3,
      ids: ['s3'],
      hasPrev: true,
      hasNext: false,
    });
  });

  it('starts again at 1 after a plain heading of the same level', () => {
    const layout = stepLayout([
      heading('s1', 2, true),
      heading('s2', 2, true),
      heading('plain', 2),
      heading('s3', 2, true),
    ]);
    expect(layout.get('s1')).toMatchObject({ number: 1, firstInList: true });
    expect(layout.get('s2')?.number).toBe(2);
    expect(layout.get('s3')).toMatchObject({ number: 1, hasPrev: false });
    expect(layout.get('s2')?.hasNext).toBe(false);
  });

  it('keeps a run going through deeper headings and ends it at a higher one', () => {
    const layout = stepLayout([
      heading('s1', 2, true),
      heading('sub', 3),
      heading('s2', 2, true),
      heading('chapter', 1),
      heading('s3', 2, true),
    ]);
    expect(layout.get('s1')?.ids).toEqual(['s1', 'sub']);
    expect(layout.get('s2')?.number).toBe(2);
    expect(layout.get('s3')?.number).toBe(1);
    expect(layout.get('s2')?.hasNext).toBe(false);
  });

  it('counts an H2 step inside an H1 step as one level in, with its own run', () => {
    const layout = stepLayout([
      heading('a', 1, true),
      heading('a1', 2, true),
      heading('a2', 2, true),
      heading('b', 1, true),
      heading('b1', 2, true),
    ]);
    expect(layout.get('a')).toMatchObject({ number: 1, depth: 1, ids: ['a', 'a1', 'a2'] });
    expect(layout.get('a1')).toMatchObject({ number: 1, depth: 2 });
    expect(layout.get('a2')).toMatchObject({ number: 2, depth: 2 });
    expect(layout.get('b1')).toMatchObject({ number: 1, depth: 2 });
    expect(layout.get('b')?.number).toBe(2);
  });

  it("numbers steps inside a block's children within their own list", () => {
    const layout = stepLayout([
      heading('s1', 1, true),
      { ...para('wrap'), children: [heading('t1', 2, true), heading('t2', 2, true)] },
    ]);
    expect(layout.get('t1')).toMatchObject({ number: 1, firstInList: true });
    expect(layout.get('t2')?.number).toBe(2);
    expect(layout.get('s1')?.number).toBe(1);
  });

  it('skips headings without an id and non-step headings, and survives junk', () => {
    expect(stepLayout(undefined).size).toBe(0);
    expect(stepLayout([null, 3, { type: 'heading', props: { level: 1, step: true } }]).size).toBe(
      0
    );
    expect(stepLayout([heading('x', 1)]).size).toBe(0);
    expect(stepLayout([heading('x', 3, true)]).size).toBe(0);
  });
});

describe('step headings and the content rules', () => {
  it('a document with step headings is valid, and so is one with the prop on an H3', () => {
    expect(validatePageBlocks([heading('a', 1, true), para('p'), heading('b', 2, true)])).toEqual(
      []
    );
    expect(validatePageBlocks([heading('c', 3, true)])).toEqual([]);
  });
});
