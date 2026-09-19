/**
 * The kind chip, asserted against RENDERED MARKUP and against the design
 * system's own CSS.
 *
 * Two claims, and neither survives on its own:
 *
 * 1. Each label draws its intended tone (deck mint, pdf peach, the
 *    PowerPoint/Keynote family amber, link sky) and an unknown label falls back
 *    to the neutral chip rather than borrowing a colour that means something
 *    else. `renderToStaticMarkup` needs no DOM, so this runs in the ordinary
 *    node-environment unit suite.
 *
 * 2. Those classes read correctly in dark mode. That is a CSS fact a render
 *    test cannot make, so it is checked where it lives: the tones are raw
 *    variables that `packages/ui-components/styles/tokens.css` redefines under
 *    `html.dark`, which is what makes one class pair enough for both themes.
 *
 * The border colour carries `!` on purpose: `.chip` is unlayered CSS (global.css
 * imports components.css directly) and unlayered rules beat Tailwind's
 * `utilities` layer, so its `border: 1px solid transparent` would otherwise win.
 */

import { readFileSync } from 'fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import SlideKindChip from '../SlideKindChip';

const render = (label: string) => renderToStaticMarkup(<SlideKindChip label={label} />);

describe('SlideKindChip', () => {
  it.each([
    ['deck', 'mint'],
    ['pdf', 'peach'],
    ['pptx', 'amber'],
    ['ppt', 'amber'],
    ['key', 'amber'],
    ['link', 'sky'],
  ])('draws %s in the %s tone', (label, tone) => {
    const html = render(label);

    expect(html).toContain(`bg-${tone}-bg`);
    expect(html).toContain(`text-${tone}-ink`);
    expect(html).toContain(`!border-${tone}-bord`);
    expect(html).toContain(`>${label}<`);
  });

  it('always carries the shared .chip shell', () => {
    expect(render('deck')).toMatch(/class="chip /);
  });

  it('falls back to the neutral chip for a label with no tone', () => {
    // `slideKindLabel` returns 'file' for an extension we have no colour for.
    const html = render('file');

    expect(html).toContain('chip-ghost');
    expect(html).not.toContain('-ink');
  });
});

describe('the tones it uses', () => {
  const tokens = readFileSync(
    new URL('../../../../../../../packages/ui-components/styles/tokens.css', import.meta.url),
    'utf8'
  );
  const dark = tokens.slice(tokens.indexOf('html.dark'));

  it.each([['mint'], ['peach'], ['amber'], ['sky']])(
    'redefines every %s variable for dark mode, so one class pair covers both themes',
    tone => {
      for (const part of ['bg', 'bord', 'ink']) {
        expect(dark).toContain(`--${tone}-${part}:`);
      }
    }
  );

  it('redefines the neutral chip variables too', () => {
    expect(dark).toContain('--chip-neutral-bg:');
    expect(dark).toContain('--chip-neutral-ink:');
    expect(dark).toContain('--chip-neutral-border:');
  });
});
