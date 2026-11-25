/**
 * Steps around every kind of block, through the real reader: each step heading
 * the document numbers gets a circle with that number, and every block in its
 * section is indented, whatever the block is (a table, a column list, a locked
 * section, a toggle heading…). The fixture is `tests/matrix/steps.ts`.
 */
import { stepLayout } from '@classmoji/page-schema/sections';
import { expect, test } from '@playwright/test';

import { mountReader } from '../helpers/readerHarness.ts';
import { stepsMatrix } from '../matrix/steps.ts';

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="200"><rect width="360" height="200" fill="#9db7e8"/></svg>';

for (const dark of [false, true]) {
  test(`${dark ? 'dark' : 'light'}: every step is numbered and its section indented`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
    await page.route('https://cdn.example.com/**', r =>
      r.fulfill({ contentType: 'image/svg+xml', body: SVG })
    );
    const blocks = stepsMatrix(true);
    const layout = stepLayout(blocks);
    await page.setViewportSize({ width: 900, height: 900 });
    await mountReader(page, blocks, { width: 760 });
    if (dark) await page.evaluate(() => document.documentElement.classList.add('dark'));
    expect(errors).toEqual([]);

    const read = await page.evaluate(
      ids => {
        const numbers: Record<string, string> = {};
        const indents: Record<string, string> = {};
        for (const id of ids) {
          const outer = document.querySelector(`.bn-block-outer[data-id="${id}"]`);
          const place = outer ?? document.querySelector(`.bn-block-column-list[data-id="${id}"]`);
          if (place) indents[id] = getComputedStyle(place).paddingLeft;
          const content = outer?.querySelector('[data-content-type="heading"]');
          if (content) numbers[id] = getComputedStyle(content, '::before').content;
        }
        return { numbers, indents };
      },
      [...new Set([...layout.values()].flatMap(step => step.ids))]
    );

    for (const [headingId, step] of layout) {
      expect(read.numbers[headingId], `circle of step ${headingId}`).toBe(`"${step.number}"`);
      for (const id of step.ids) {
        const pad = parseFloat(read.indents[id] ?? '0');
        expect(pad, `block ${id} in step ${headingId} is indented`).toBeGreaterThanOrEqual(52);
      }
    }
    // The matrix has twelve top-level steps and four inner ones.
    expect(layout.size).toBe(16);
  });
}
