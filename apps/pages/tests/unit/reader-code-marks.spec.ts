/**
 * Inline code beside other marks, drawn by the real reader (the island the
 * class site, the in-app reader and the MCP's page render mount).
 *
 * BlockNote's `code` mark excludes every other formatting mark, and from 0.57
 * the editor checks the document it is given, so a stored run that is code
 * AND bold, or code inside a link, threw "Invalid collection of marks" and the
 * whole page fell to the island's error state. Pages hold such runs;
 * `pageStyleSpecs` lets `code` sit beside other marks.
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
  test(`code inside a link and bold code draw (${surface})`, async ({ page }) => {
    const data = { ...siteIslandData(BLOCKS), surface };
    await mountReader(page, BLOCKS, { data });

    const link = page.locator('a[href="https://react.dev/reference/react/StrictMode"]');
    await expect(link).toHaveCount(1);
    await expect(link).toHaveText('<StrictMode>');
    // Both marks drawn (ProseMirror nests them by schema order: <code><a>).
    expect(await link.evaluate(a => Boolean(a.closest('code') ?? a.querySelector('code')))).toBe(
      true
    );
    await expect(page.locator('strong code, code strong')).toHaveText('useFetcher');
  });
}
