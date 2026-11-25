/**
 * The agent-edit preview's mark on toggle blocks, in a real browser (the
 * reader island, blocknote-overrides.css and the generated stylesheet).
 *
 * Since BlockNote 0.56 a toggle's chevron sits in a frame beside the block's
 * content instead of inside it. The mark must still look as it did: the
 * tinted bar starts in the gutter left of the chevron and covers it, the
 * chevron stays visible on top, and the text does not move.
 */
import { test, expect, type Page } from '@playwright/test';

import { previewHighlightCss } from '~/components/preview/previewHighlight.ts';
import { mountReader } from '../helpers/readerHarness.ts';

const text = (value: string) => [{ type: 'text', text: value, styles: {} }];
const BLOCKS = [
  { id: 'p', type: 'paragraph', props: {}, content: text('Plain paragraph'), children: [] },
  {
    id: 'th',
    type: 'heading',
    props: { level: 2, isToggleable: true },
    content: text('Toggle heading'),
    children: [{ id: 'th-c', type: 'paragraph', props: {}, content: text('child'), children: [] }],
  },
  {
    id: 'tl',
    type: 'toggleListItem',
    props: {},
    content: text('Toggle list'),
    children: [{ id: 'tl-c', type: 'paragraph', props: {}, content: text('child'), children: [] }],
  },
];

type Box = { left: number; right: number; top: number; bottom: number };

function geometry(page: Page, id: string) {
  return page.evaluate(id => {
    const block = document.querySelector(`.bn-block[data-id="${id}"]`)!;
    const box = (el: Element | null): Box | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    const content = block.querySelector('.bn-block-content')!;
    const chevron = block.querySelector(':scope > .bn-toggle-frame > .bn-toggle-button');
    const chevronBox = box(chevron);
    const onTop = chevronBox
      ? (() => {
          const hit = document.elementFromPoint(
            (chevronBox.left + chevronBox.right) / 2,
            (chevronBox.top + chevronBox.bottom) / 2
          );
          return !!hit && !!chevron && chevron.contains(hit);
        })()
      : null;
    return {
      text: box(content.querySelector('.bn-inline-content')),
      content: box(content),
      chevron: chevronBox,
      chevronOnTop: onTop,
      tint: getComputedStyle(content).backgroundColor,
    };
  }, id);
}

test('a marked toggle heading and toggle list item look as before', async ({ page }) => {
  await mountReader(page, BLOCKS);
  const before = {
    p: await geometry(page, 'p'),
    th: await geometry(page, 'th'),
    tl: await geometry(page, 'tl'),
  };

  const css = previewHighlightCss(
    { changed: ['th', 'p'], added: ['tl'], removed: 0 },
    'preview-highlight'
  );
  await page.evaluate(css => {
    document.body.classList.add('preview-highlight');
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }, css);

  for (const id of ['p', 'th', 'tl'] as const) {
    const after = await geometry(page, id);
    // The text stays where it was.
    expect(after.text!.left, `${id}: text`).toBeCloseTo(before[id].text!.left, 0);
    // The mark is drawn.
    expect(after.tint, `${id}: tint`).not.toBe('rgba(0, 0, 0, 0)');
    if (id === 'p') continue;
    // It reaches into the gutter left of the chevron, which stays visible.
    expect(after.content!.left, `${id}: mark starts left of the chevron`).toBeLessThan(
      after.chevron!.left - 4
    );
    expect(after.chevron!.left, `${id}: chevron`).toBeCloseTo(before[id].chevron!.left, 0);
    expect(after.chevronOnTop, `${id}: chevron on top`).toBe(true);
  }
});
