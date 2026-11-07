/**
 * The tick box of a checkable heading, in the inline layout (a narrow pane or
 * phone), sits inside the heading's own box, before its text. A coloured
 * heading's padding is `!important` (blocknote-overrides.css), so the room the
 * box needs has to be `!important` as well, or the box is drawn over the first
 * letters of the title (#762, #765). Pinned from source: the cascade is the
 * thing that broke.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

const css = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../app/styles/${name}`, import.meta.url)), 'utf8');

test('a coloured heading pads with !important', () => {
  expect(css('blocknote-overrides.css')).toMatch(/padding: 3px 4px !important/);
});

test('the inline tick box makes its room with !important too', () => {
  const rule = /\[data-section-checks='inline'\]\s*\.bn-block-content[^{]*\{([^}]*)\}/.exec(
    css('page-sections.css')
  );
  expect(rule?.[1]).toMatch(/padding-left:\s*32px\s*!important/);
});
