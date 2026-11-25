/**
 * Steps: the generated CSS (pure), and the real reader's DOM for a page of
 * step headings.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { stepLayout } from '@classmoji/page-schema/sections';

import { stepStylesheet } from '~/utils/stepStyles.ts';
import { mountReader } from '../helpers/readerHarness.ts';

const text = (value: string) => [{ type: 'text', text: value, styles: {} }];
const heading = (id: string, level: number, step?: boolean) => ({
  id,
  type: 'heading',
  props: { level, ...(step ? { step: true } : {}) },
  content: text(id),
  children: [],
});
const paragraph = (id: string) => ({
  id,
  type: 'paragraph',
  props: {},
  content: text(id),
  children: [],
});
const css = (blocks: unknown[]) => stepStylesheet(stepLayout(blocks));

test.describe('stepStylesheet', () => {
  test('a document without steps has no CSS', () => {
    expect(css([heading('a', 1), paragraph('p')])).toBe('');
    expect(css([heading('a', 3, true)])).toBe('');
  });

  test('numbers each step, indents its section and draws the line between steps only', () => {
    const out = css([
      paragraph('intro'),
      heading('s1', 1, true),
      paragraph('a'),
      heading('s2', 1, true),
      paragraph('b'),
    ]);
    expect(out).toContain(
      '[data-id="s1"] > .bn-block > .bn-block-content[data-content-type="heading"]::before { content: "1";'
    );
    expect(out).toContain(
      '[data-id="s2"] > .bn-block > .bn-block-content[data-content-type="heading"]::before { content: "2";'
    );
    // Every block in a section is indented 52px.
    for (const id of ['s1', 'a', 's2', 'b']) {
      expect(out).toMatch(new RegExp(`\\[data-id="${id}"\\] \\{ padding-left: 52px`));
    }
    // The first step has a line below it (a section block carries a full-height slice);
    // the last has none.
    expect(out).toMatch(/\[data-id="a"\] \{[^}]*background-size: 1px 100%/);
    expect(out).not.toMatch(/\[data-id="b"\] \{[^}]*background-image/);
    // The second step has a slice above its circle.
    expect(out).toMatch(/\[data-id="s2"\] \{[^}]*background-position: 17.5px 0px/);
  });

  test('an H2 step inside an H1 step is indented twice and draws its own line one level in', () => {
    const out = css([heading('a', 1, true), heading('a1', 2, true), heading('a2', 2, true)]);
    expect(out).toMatch(/\[data-id="a1"\] \{ padding-left: 104px/);
    expect(out).toMatch(/\[data-id="a2"\] \{ padding-left: 104px/);
    // a1's line sits one indent in (52 + 17.5).
    expect(out).toMatch(/\[data-id="a1"\] \{[^}]*69.5px/);
  });

  test('a step at the top of a list takes no extra padding; one below it takes a fixed gap', () => {
    const out = css([heading('first', 1, true), paragraph('p'), heading('second', 1, true)]);
    expect(out).not.toContain('[data-id="first"] > .bn-block {');
    expect(out).toContain('[data-id="second"] > .bn-block { padding-top: 48px !important; }');
  });

  test('ids with quotes cannot break out of the selector', () => {
    const out = css([{ ...heading('x"] { color: red } [data-id="y', 1, true) }]);
    expect(out).not.toContain('[data-id="x"] {');
    expect(out).toContain('x\\"]');
  });
});

test.describe('steps in the reader', () => {
  const load = (page: Page, blocks: unknown[]) => mountReader(page, blocks, { width: 760 });

  /** The `content` of a heading's `::before`, by heading text. */
  const circle = (page: Page, label: string) =>
    page.evaluate(label => {
      const el = [
        ...document.querySelectorAll('.bn-block-content[data-content-type="heading"]'),
      ].find(e => e.textContent === label)!;
      return getComputedStyle(el, '::before').content;
    }, label);

  test('draws a numbered circle on each step heading and none elsewhere', async ({ page }) => {
    await load(page, [
      heading('one', 1, true),
      paragraph('a'),
      heading('two', 1, true),
      heading('plain', 2),
      heading('deep', 3, true),
    ]);
    expect(await circle(page, 'one')).toBe('"1"');
    expect(await circle(page, 'two')).toBe('"2"');
    // No number (a heading may carry an empty pseudo-element from other rules).
    expect(await circle(page, 'plain')).not.toMatch(/\d/);
    // H3 carries the prop but is not a step.
    expect(await circle(page, 'deep')).not.toMatch(/\d/);
  });

  test('indents a step and its section by the circle, and joins steps with a line', async ({
    page,
  }) => {
    await load(page, [
      heading('one', 1, true),
      paragraph('a'),
      heading('two', 1, true),
      paragraph('b'),
    ]);
    const read = (label: string) =>
      page.evaluate(label => {
        const content = [...document.querySelectorAll('.bn-block-content')].find(
          e => e.textContent === label
        )!;
        const outer = content.closest('.bn-block-outer') as HTMLElement;
        const cs = getComputedStyle(outer);
        return { pad: cs.paddingLeft, image: cs.backgroundImage !== 'none' };
      }, label);
    expect(await read('one')).toEqual({ pad: '52px', image: true });
    expect(await read('a')).toEqual({ pad: '52px', image: true });
    expect(await read('two')).toEqual({ pad: '52px', image: true });
    // The last step's section draws no line below it.
    expect((await read('b')).pad).toBe('52px');
    expect((await read('b')).image).toBe(false);
  });

  test('the circle is centred on the heading text and sits at the page margin', async ({
    page,
  }) => {
    await load(page, [paragraph('intro'), heading('one', 1, true), paragraph('a')]);
    const { circleCentre, textCentre, circleLeft, textLeft } = await page.evaluate(() => {
      const content = [...document.querySelectorAll('.bn-block-content')].find(
        e => e.textContent === 'one'
      ) as HTMLElement;
      const rect = content.getBoundingClientRect();
      const cs = getComputedStyle(content, '::before');
      const top = parseFloat(cs.top);
      return {
        circleCentre: rect.top + top + parseFloat(cs.height) / 2,
        // The heading's first line (the box also holds BlockNote's 3px of bottom padding).
        textCentre: rect.top + parseFloat(getComputedStyle(content).lineHeight) / 2,
        circleLeft: rect.left + parseFloat(cs.left),
        textLeft: rect.left,
      };
    });
    expect(Math.abs(circleCentre - textCentre)).toBeLessThan(1);
    // 52px left of the text: the circle starts where the page's text column starts.
    expect(textLeft - circleLeft).toBe(52);
  });

  test('a page with no steps gets no step stylesheet', async ({ page }) => {
    await load(page, [heading('one', 1), paragraph('a')]);
    expect(await page.locator('[data-testid="step-styles"]').count()).toBe(0);
  });
});

test.describe('the guide line beside a nested list', () => {
  const item = (id: string, type: string, children: unknown[] = []) => ({
    id,
    type,
    props: {},
    content: text(id),
    children,
  });

  for (const type of ['bulletListItem', 'numberedListItem']) {
    test(`${type}: centred under the parent's marker, in the steps line's style`, async ({
      page,
    }) => {
      await mountReader(page, [item('parent', type, [item('child', type)])], { width: 700 });
      const read = await page.evaluate(() => {
        const parent = [...document.querySelectorAll('.bn-block-content')].find(e =>
          e.textContent?.startsWith('parent')
        ) as HTMLElement;
        const childOuter = document.querySelector(
          '.bn-block-group .bn-block-group > .bn-block-outer'
        ) as HTMLElement;
        const guide = getComputedStyle(childOuter, '::before');
        const root = document.querySelector('.page-editor') as HTMLElement;
        return {
          // The marker's centre line: 10px into the parent's content.
          marker: parent.getBoundingClientRect().left + 10,
          line:
            childOuter.getBoundingClientRect().left +
            parseFloat(guide.left) +
            parseFloat(guide.borderLeftWidth) / 2,
          width: guide.borderLeftWidth,
          colour: guide.borderLeftColor,
          steps: getComputedStyle(root).getPropertyValue('--st-line').trim(),
        };
      });
      expect(Math.abs(read.line - read.marker)).toBeLessThan(0.5);
      expect(read.width).toBe('1px');
      // `--st-line` is #dcdee6 in the light theme.
      expect(read.steps.toLowerCase()).toBe('#dcdee6');
      expect(read.colour).toBe('rgb(220, 222, 230)');
    });
  }
});

test.describe('a heading that is both a step and checkable', () => {
  const read = (page: Page, level: number, editor: boolean) =>
    page.evaluate(
      ({ level, editor }) => {
        const content = document.querySelector('.bn-block-content') as HTMLElement;
        const mark = content.querySelector(
          editor ? '.pg-checkable-badge' : '.pg-section-check'
        ) as HTMLElement;
        const box = mark.getBoundingClientRect();
        const circle = getComputedStyle(content, '::before');
        const content_ = content.getBoundingClientRect();
        const circleLeft = content_.left + parseFloat(circle.left);
        const circleTop = content_.top + parseFloat(circle.top);
        return {
          gap: circleLeft - box.right,
          circleHasNumber: /\d/.test(circle.content),
          boxCentre: box.top + box.height / 2,
          circleCentre: circleTop + parseFloat(circle.height) / 2,
          level,
        };
      },
      { level, editor }
    );

  const mount = async (page: Page, level: number, surface: 'reader' | 'editor') => {
    const blocks = [heading('h', level, true)];
    (blocks[0].props as Record<string, unknown>).checkable = true;
    const generated = stepStylesheet(stepLayout(blocks));
    const files = ['blocknote-overrides.css', 'page-sections.css'].map(f =>
      readFileSync(new URL(`../../app/styles/${f}`, import.meta.url), 'utf-8')
    );
    const mark =
      surface === 'editor'
        ? '<span class="pg-checkable-badge"></span>'
        : '<button class="pg-section-check"></button>';
    await page.setContent(
      `<style>${files.join('\n')}</style><style>${generated}</style>` +
        `<div class="bn-editor ${surface === 'reader' ? 'pg-reader-sections' : ''}" contenteditable="${surface === 'editor'}">` +
        `<div class="page-editor ${surface === 'reader' ? 'pg-reader-sections' : ''}" style="margin-left:140px">` +
        `<div class="bn-block-group"><div class="bn-block-outer" data-id="h"><div class="bn-block">` +
        `<div class="bn-block-content" data-content-type="heading" data-level="${level}" data-step="true" data-checkable="true"><h${level}>Title</h${level}>${mark}</div>` +
        `</div></div></div></div></div>`
    );
  };

  for (const level of [1, 2]) {
    test(`H${level}: the reader's tick box sits 8px left of the circle, on its centre line`, async ({
      page,
    }) => {
      await mount(page, level, 'reader');
      const r = await read(page, level, false);
      expect(r.circleHasNumber).toBe(true);
      expect(r.gap).toBeCloseTo(8, 0);
      expect(Math.abs(r.boxCentre - r.circleCentre)).toBeLessThan(1);
    });

    test(`H${level}: the editor's badge sits 8px left of the circle`, async ({ page }) => {
      await mount(page, level, 'editor');
      const r = await read(page, level, true);
      expect(r.gap).toBeCloseTo(8, 0);
      expect(Math.abs(r.boxCentre - r.circleCentre)).toBeLessThan(1);
    });
  }
});
