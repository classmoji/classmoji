/**
 * Every block type in the page schema, once, through the real reader in both
 * themes: nothing throws, every block draws, nothing overflows the page, and
 * the shapes the text restyle touched keep their geometry.
 *
 * The fixture (`tests/matrix/blocks.ts`) holds the default blocks, the custom
 * blocks, and the heading variants (toggle, colored, checkable). A block type
 * added to the schema without an entry there is the gap this exists to catch:
 * `schema block types` below fails until it has one.
 */
import { expect, test, type Page } from '@playwright/test';

import { mountReader } from '../helpers/readerHarness.ts';
import { everyBlock, li, p } from '../matrix/blocks.ts';

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="200"><rect width="360" height="200" fill="#9db7e8"/></svg>';

/** The `data-content-type` / `data-node-type` of every block the page draws. */
const typesOnPage = (page: Page) =>
  page.evaluate(() => {
    const types = new Set<string>();
    for (const el of document.querySelectorAll('[data-content-type]'))
      types.add(el.getAttribute('data-content-type')!);
    if (document.querySelector('[data-node-type="columnList"]')) types.add('columnList');
    return [...types].sort();
  });

/** What `everyBlock()` holds, by block type (the document's own `type`s). */
const typesInFixture = (blocks: unknown[]): string[] => {
  const types = new Set<string>();
  const visit = (list: unknown[]) => {
    for (const block of list as Array<{ type: string; children?: unknown[] }>) {
      types.add(block.type);
      if (block.children) visit(block.children);
    }
  };
  visit(blocks);
  return [...types].sort();
};

for (const dark of [false, true]) {
  test.describe(dark ? 'dark' : 'light', () => {
    test('every block type draws, with no errors and no sideways overflow', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
      await page.route('https://cdn.example.com/**', r =>
        r.fulfill({ contentType: 'image/svg+xml', body: SVG })
      );
      await page.route('https://example.com/**', r =>
        r.fulfill({ contentType: 'text/html', body: '<p>embedded</p>' })
      );
      const blocks = everyBlock();
      await page.setViewportSize({ width: 900, height: 900 });
      await mountReader(page, blocks, { width: 760 });
      await page.evaluate(d => {
        if (d) document.documentElement.classList.add('dark');
      }, dark);

      expect(errors).toEqual([]);
      const drawn = await typesOnPage(page);
      // Every block type the fixture holds is on the page (a column list is a
      // node type, not a content type).
      for (const type of typesInFixture(blocks)) {
        if (type === 'column' || type === 'columnList') continue;
        expect(drawn, `block type ${type} was not drawn`).toContain(type);
      }
      expect(drawn).toContain('columnList');
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow, 'the page scrolls sideways').toBeLessThanOrEqual(0);
    });
  });
}

test('the fixture holds every block type the schema has', async () => {
  // The types the editor's schema defines (apps/pages/app/components/editor/blocks).
  const schemaTypes = [
    'audio',
    'bulletListItem',
    'callout',
    'checkListItem',
    'codeBlock',
    'column',
    'columnList',
    'divider',
    'embed',
    'file',
    'heading',
    'image',
    'lockedSection',
    'navGrid',
    'numberedListItem',
    'pageLink',
    'paragraph',
    'profile',
    'quote',
    'table',
    'terminal',
    'toggleListItem',
    'video',
  ];
  expect(typesInFixture(everyBlock())).toEqual(expect.arrayContaining(schemaTypes));
});

test('every list type starts its text the same distance in', async ({ page }) => {
  await mountReader(
    page,
    [
      li('bulletListItem', 'Bullet'),
      li('numberedListItem', 'Numbered'),
      li('checkListItem', 'Check', [], { checked: false }),
      li('toggleListItem', 'Toggle', [p('child')]),
    ].map((block, i) => ({ ...block, id: 'l' + i })),
    { width: 700 }
  );
  const lefts = await page.evaluate(() =>
    [0, 1, 2, 3].map(i => {
      const outer = document.querySelector(`.bn-block-outer[data-id="l${i}"]`)!;
      const inline = outer.querySelector('.bn-inline-content') as HTMLElement;
      return Math.round(inline.getBoundingClientRect().left - outer.getBoundingClientRect().left);
    })
  );
  // 32px: the marker (a dot, a numbered circle, a tick box, a chevron) and its gap.
  expect(lefts).toEqual([32, 32, 32, 32]);
});
