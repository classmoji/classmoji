/**
 * Inline code stored beside other marks, drawn by the real reader (the island
 * the class site, the in-app reader and the MCP's page render mount).
 *
 * BlockNote's `code` mark excludes every other formatting mark and the link,
 * and from 0.57 the editor checks the document it is given, so a stored run
 * that is code AND bold, or code inside a link, would throw "Invalid
 * collection of marks" and the whole page would fall to the island's error
 * state. The reader cleans such runs before BlockNote sees them
 * (`drawableBlocks`): bold code draws as code only, code inside a link draws
 * as the link without the code.
 */
import { test, expect } from '@playwright/test';

import { mountReader, siteIslandData } from '../helpers/readerHarness.ts';

const BLOCKS = [
  {
    type: 'paragraph',
    content: [
      { type: 'text', text: 'Wrap it in ', styles: {} },
      {
        type: 'link',
        href: 'https://react.dev/reference/react/StrictMode',
        content: [{ type: 'text', text: '<StrictMode>', styles: { code: true } }],
      },
    ],
  },
  {
    type: 'bulletListItem',
    content: [{ type: 'text', text: 'useFetcher', styles: { bold: true, code: true } }],
  },
];

for (const surface of ['site', 'app', 'render'] as const) {
  test(`bold code draws as code, code in a link as the link (${surface})`, async ({ page }) => {
    const data = { ...siteIslandData(BLOCKS), surface };
    await mountReader(page, BLOCKS, { data });

    const link = page.locator('a[href="https://react.dev/reference/react/StrictMode"]');
    await expect(link).toHaveCount(1);
    await expect(link).toHaveText('<StrictMode>');
    // The link stays, the code inside it goes.
    expect(await link.evaluate(a => Boolean(a.closest('code') ?? a.querySelector('code')))).toBe(
      false
    );

    // The code stays, the bold beside it goes.
    await expect(page.locator('code', { hasText: 'useFetcher' })).toHaveCount(1);
    await expect(page.locator('strong', { hasText: 'useFetcher' })).toHaveCount(0);
  });
}
