/**
 * A link stored as a text style (`styles.href`), drawn by the real reader (the
 * island the class site, the in-app reader and the MCP's page render mount).
 *
 * No schema knows an `href` style, so BlockNote threw "style href not found
 * in styleSchema" on the whole document and the page fell to the island's
 * error state. A page holds such runs in numbered list items; the reader
 * turns them into links before BlockNote sees them (`drawableBlocks`).
 */
import { test, expect } from '@playwright/test';

import { mountReader, siteIslandData } from '../helpers/readerHarness.ts';

const BLOCKS = [
  {
    type: 'numberedListItem',
    content: [
      { type: 'text', text: 'Follow the ', styles: {} },
      {
        type: 'text',
        text: 'coding conventions',
        styles: { href: 'https://kotlinlang.org/docs/coding-conventions.html' },
      },
      { type: 'text', text: ' before review.', styles: {} },
    ],
  },
  {
    type: 'numberedListItem',
    content: [
      {
        type: 'text',
        text: 'Android',
        styles: { href: 'https://developer.android.com/kotlin', bold: true },
      },
      { type: 'text', text: ' docs', styles: { href: 'https://developer.android.com/kotlin' } },
    ],
  },
];

for (const surface of ['site', 'app', 'render'] as const) {
  test(`a link stored as a text style draws as a link (${surface})`, async ({ page }) => {
    const data = { ...siteIslandData(BLOCKS), surface };
    await mountReader(page, BLOCKS, { data });

    const conventions = page.locator(
      'a[href="https://kotlinlang.org/docs/coding-conventions.html"]'
    );
    await expect(conventions).toHaveText('coding conventions');
    // Neighbouring runs with the same href are one link, the bold kept (the
    // DOM may split it around the <strong>).
    const android = page.locator('a[href="https://developer.android.com/kotlin"]');
    expect((await android.allTextContents()).join('')).toBe('Android docs');
    await expect(page.locator('strong', { hasText: 'Android' })).toHaveCount(1);
    await expect(page.locator('ol, [data-content-type="numberedListItem"]').first()).toContainText(
      'before review.'
    );
  });
}
