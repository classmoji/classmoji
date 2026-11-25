/**
 * The stylesheets every page surface shares (blocknote-overrides.css,
 * page-sections.css, the class site's inline sheet), held against each other
 * and against BlockNote's DOM.
 *
 * These used to live in site-render.spec.ts, beside the class site's static
 * renderer. The renderer is gone (the site mounts the app's reader); what it
 * tested about shared CSS still ships everywhere, so it stays here.
 */

import * as fs from 'fs';

import { test, expect, type Page } from '@playwright/test';

import { siteArticleWidthClass } from '~/site/articleWidth.ts';
import { SITE_STYLES } from '~/site/styles.ts';
import { AGENT_CURSOR_LABEL_CSS } from '~/components/editor/collab/liveCursor.ts';
import { mountReader } from '../helpers/readerHarness.ts';

const text = (value: string) => [{ type: 'text', text: value, styles: {} }];

/**
 * The site, the reader and the editor are renderings of ONE page, and the
 * places where they are styled by different stylesheets are where they drift
 * apart in ways no unit test would otherwise see.
 */
test.describe('editor parity', () => {
  /** Every `height:` declared for `.page-header-image`, in source order. */
  const coverHeights = (css: string): string[] => {
    const heights: string[] = [];
    const blocks = css.matchAll(/\.page-header-image\s*\{([^}]*)\}/g);
    for (const [, body] of blocks) {
      const height = body.match(/height:\s*([^;]+);/);
      if (height) heights.push(height[1].trim());
    }
    return heights;
  };

  test('the cover band is the same height on the site as in the editor', () => {
    // A viewport-relative band on the site (20vh, 140-280px) against the
    // editor's fixed 12/16/18rem meant the same cover was cropped differently
    // in the two surfaces — so an author positioned an image against one crop
    // and published another.
    const editorCss = fs.readFileSync(
      new URL('../../app/styles/page-viewer.css', import.meta.url),
      'utf-8'
    );

    const editor = coverHeights(editorCss);
    expect(editor, 'page-viewer.css should still size .page-header-image').not.toHaveLength(0);
    expect(coverHeights(SITE_STYLES)).toEqual(editor);
  });

  /** Comments stripped, so prose in these files cannot be parsed as selectors. */
  const uncommented = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

  /** Every `rule { … }` pair in a stylesheet, as [selector, body]. */
  const rules = (css: string): [string, string][] =>
    [...uncommented(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => [sel, body]);

  /**
   * The shared heading scale, keyed by level: every `--level` in
   * blocknote-overrides.css.
   *
   * An H1 carries no `data-level` — BlockNote omits a prop equal to its default
   * and heading's default level is 1 — so the `:not([data-level])` selector is
   * the H1 rule, and the `[data-level="1"]` twin covers any export path that
   * ever does write the attribute.
   */
  const sharedScale = (css: string): Record<string, string> => {
    const scale: Record<string, string> = {};
    for (const [selector, body] of rules(css)) {
      const level = body.match(/--level:\s*([^;]+)/);
      if (!level) continue;
      const value = level[1].trim();
      if (selector.includes(':not([data-level])')) scale['1'] = value;
      for (const [, n] of selector.matchAll(/\[data-level="([1-6])"\]/g)) scale[n] = value;
    }
    return scale;
  };

  /** BlockNote's one-tick "old size" during a type or level change, keyed by level. */
  const prevScale = (css: string): Record<string, string> => {
    const scale: Record<string, string> = {};
    for (const [selector, body] of rules(css)) {
      const prev = body.match(/--prev-level:\s*([^;]+)/);
      if (!prev) continue;
      for (const [, n] of selector.matchAll(/\[data-prev-level="([1-6])"\]/g)) {
        scale[n] = prev[1].trim();
      }
    }
    return scale;
  };

  /** The block sizing in a stylesheet: rules that set font-size or line-height
   *  on the block box, its inline content or a heading tag. */
  const blockSizing = (css: string): string[] =>
    rules(css)
      .filter(
        ([selector, body]) =>
          /\.bn-block-content|\.bn-inline-content|(?:^|[\s>+~,])h[1-6]\b/.test(selector) &&
          /(?:^|[;\s])(?:font-size|line-height):/.test(body)
      )
      .map(([selector]) => selector.trim());

  /** The `<style>` PageEditor renders around the editor. */
  const pageEditorInlineCss = (): string => {
    const source = fs.readFileSync(
      new URL('../../app/components/editor/PageEditor.tsx', import.meta.url),
      'utf-8'
    );
    const style = source.match(/<style>\{`([\s\S]*?)`\}<\/style>/);
    expect(style, 'PageEditor should still render an inline <style>').not.toBeNull();
    return style![1];
  };

  const overridesCss = (): string =>
    fs.readFileSync(new URL('../../app/styles/blocknote-overrides.css', import.meta.url), 'utf-8');

  test('the heading scale is shared, not scoped to the editor', () => {
    // The bug this pins: the sizes lived only under `.page-editor`, a class the
    // old server-rendered site page did not have, so the site fell through to
    // BlockNote's 3em/2em/1.3em and published a 48px H1 where the editor showed
    // 30px (#288). The scale is now unscoped `--level`, which reaches every
    // surface — so a scoped selector here would re-break exactly one of them.
    const scale = sharedScale(overridesCss());

    expect(Object.keys(scale).sort()).toEqual(['1', '2', '3', '4', '5', '6']);

    for (const [selector, body] of rules(overridesCss())) {
      if (!/--level:/.test(body)) continue;
      expect(selector, '--level must not be scoped to one surface').not.toMatch(
        /\.page-editor|\.site-article|\.page-viewer/
      );
    }
  });

  test('the editor is sized by the shared scale, not a copy of it', () => {
    // PageEditor's inline <style> used to pin every block to 16px / 1.6 with
    // `!important`, which defeated `--level`, so the editor kept its own
    // tag-level copy of the heading sizes and drew body text, headings and code
    // differently from the viewer students read. The editor now reads the same
    // rules as the viewer and the site; a size here would fork it again.
    expect(blockSizing(pageEditorInlineCss()), 'PageEditor inline <style>').toEqual([]);

    expect(
      blockSizing(overridesCss()).filter(selector => selector.includes('.page-editor')),
      'blocknote-overrides.css sizing scoped to .page-editor'
    ).toEqual([]);
  });

  /** Editing chrome: live carets and their labels, which only the editor draws. */
  const EDITOR_CHROME = /\.bn-collaboration-cursor__/;

  /** Every selector in `css` that styles something other than editing chrome.
   *  `${…}` interpolations are dropped first; the one PageEditor uses is
   *  checked on its own below. */
  const nonChromeSelectors = (css: string): string[] =>
    rules(css.replace(/\$\{[^}]*\}/g, ''))
      .flatMap(([selector]) => selector.split(','))
      .map(selector => selector.trim())
      .filter(selector => !EDITOR_CHROME.test(selector));

  test('PageEditor styles editing chrome only, never a block', () => {
    // The callout card, the divider rule and the diff / file-tree widths lived
    // in PageEditor's inline <style> under `.page-editor`, a wrapper only the
    // editor has. Students (the read-only viewer) and the class site never got
    // them: the emoji stacked above bare text and dividers drew nothing. How a
    // block looks belongs in blocknote-overrides.css, which all three load.
    const inline = pageEditorInlineCss();
    expect(rules(inline.replace(/\$\{[^}]*\}/g, '')).length).toBeGreaterThan(0);
    expect(nonChromeSelectors(inline), 'PageEditor inline <style>').toEqual([]);
    expect(nonChromeSelectors(AGENT_CURSOR_LABEL_CSS), 'AGENT_CURSOR_LABEL_CSS').toEqual([]);

    // The check is not vacuous: a block rule is caught.
    expect(
      nonChromeSelectors(`.page-editor .bn-block:has(> .bn-collaboration-cursor__base) { top: 0; }
        .page-editor .callout-block, .page-editor .divider-block hr { padding: 0; }`)
    ).toEqual(['.page-editor .callout-block', '.page-editor .divider-block hr']);
  });

  test('callout and divider styling is shared, not scoped to one surface', () => {
    const blockRules = (css: string) =>
      rules(css).filter(([selector]) => /callout|divider|\bhr\b/.test(selector));

    const shared = blockRules(overridesCss()).map(([selector]) => selector.trim());
    expect(shared).toEqual(expect.arrayContaining(['.callout-block', '.divider-block hr']));
    for (const selector of shared) {
      expect(selector, 'block styling scoped to one surface').not.toMatch(
        /\.page-editor|\.site-article|\.page-viewer/
      );
    }

    // A site-only `hr` rule outranked the shared dark divider colour.
    expect(blockRules(SITE_STYLES), 'SITE_STYLES block styling').toEqual([]);
  });

  test('inline code is a chip in table cells, never inside <pre>', async ({ page }) => {
    // The chip rule was `.bn-inline-content code`. The editor and the reader
    // render a table cell as a bare `<p>` (only the old static site render's
    // `<table>` carried `.bn-inline-content`), so `code` in a cell was plain
    // text for authors and students and a chip on the class site.

    /** A selector list split on top-level commas (not the ones inside `:not(…)`). */
    const splitList = (list: string): string[] => {
      const out: string[] = [];
      let depth = 0;
      let start = 0;
      for (let i = 0; i < list.length; i++) {
        if (list[i] === '(') depth++;
        else if (list[i] === ')') depth--;
        else if (list[i] === ',' && depth === 0) {
          out.push(list.slice(start, i).trim());
          start = i + 1;
        }
      }
      out.push(list.slice(start).trim());
      return out;
    };
    /** Selectors of every rule that paints a background on a `code` element. */
    const chipSelectors = rules(overridesCss())
      .filter(([, body]) => /background-color:/.test(body))
      .flatMap(([selector]) => splitList(selector))
      .filter(selector => /(?:^|[\s>~+(])code(?=$|[\s:.[)])/.test(selector));
    const light = chipSelectors.filter(selector => !selector.startsWith('.dark '));
    const dark = chipSelectors.filter(selector => selector.startsWith('.dark '));
    expect(light, 'light inline-code rule').not.toHaveLength(0);
    expect(dark, 'dark inline-code rule').not.toHaveLength(0);

    // The reader's own DOM (the editor draws the same blocks), in a browser.
    const codeText = (value: string) => [{ type: 'text', text: value, styles: { code: true } }];
    await mountReader(page, [
      {
        type: 'table',
        content: { type: 'tableContent', rows: [{ cells: [codeText('PERMISSION_DENIED')] }] },
      },
      { type: 'paragraph', content: codeText('npm run dev') },
      { type: 'codeBlock', props: { language: 'js' }, content: text('const a = 1;') },
      { type: 'terminal', props: { code: 'npm run dev', title: 'Terminal' } },
    ]);

    for (const [theme, selectors] of [
      ['light', light],
      ['dark', dark],
    ] as const) {
      const found = await page.evaluate(
        ({ theme, selectors, all }) => {
          document.documentElement.classList.toggle('dark', theme === 'dark');
          const isChip = (el: Element | null) => !!el && selectors.some(s => el.matches(s));
          const isAnyChip = (el: Element) => all.some(s => el.matches(s));
          const cell = document.querySelector('[data-content-type="table"] td code');
          const para = document.querySelector('[data-content-type="paragraph"] code');
          const pres = [...document.querySelectorAll('pre code')];
          return {
            cell: isChip(cell),
            para: isChip(para),
            pres: pres.length,
            preChips: pres.filter(isAnyChip).length,
          };
        },
        { theme, selectors: [...selectors], all: chipSelectors }
      );
      expect(found, theme).toEqual({ cell: true, para: true, pres: 2, preChips: 0 });
    }
  });

  test("a heading changing level animates from the shared scale's size", () => {
    // BlockNote holds the old size for one tick through `--prev-level`, from
    // its own 3em/2em/1.3em ladder. Without these an H1 turned into an H2 grows
    // to 48px before shrinking to 24. They are the one copy of the scale that
    // has to exist, so this keeps it equal to `--level`.
    expect(prevScale(overridesCss())).toEqual(sharedScale(overridesCss()));
  });

  test('the site stylesheet does not fork the heading scale', () => {
    // The recurrence this guards: "site headings look wrong" is a tempting
    // one-line fix in SITE_STYLES, and it would move the site alone while the
    // editor and the in-app viewer stayed on the shared scale.
    for (const [selector, body] of rules(SITE_STYLES)) {
      if (!/heading/.test(selector) && !/--level:/.test(body)) continue;
      expect(body, `SITE_STYLES should not size headings (${selector.trim()})`).not.toMatch(
        /font-size:|--level:/
      );
    }
  });
});

test.describe('article width', () => {
  test('mirrors the editor width map', () => {
    // Same numbers as `widthClasses` in the editor's page route. A page
    // authored at width 3 and served at max-w-3xl is the cramping this fixes.
    expect(siteArticleWidthClass(1)).toBe('max-w-2xl');
    expect(siteArticleWidthClass(2)).toBe('max-w-4xl');
    expect(siteArticleWidthClass(3)).toBe('max-w-5xl');
    expect(siteArticleWidthClass(4)).toBe('max-w-7xl');
  });

  test('an unreadable width keeps the width the site has always used', () => {
    for (const width of [null, undefined, 0, 9, -1]) {
      expect(siteArticleWidthClass(width)).toBe('max-w-3xl');
    }
  });
});

/* ------------------------------------------------------------------ *
 * Room above headings and around cards
 * ------------------------------------------------------------------ */

/**
 * Measured in a browser, in the real reader (the island the class site
 * mounts, `tests/helpers/readerHarness.ts`) with BlockNote's stylesheets
 * loaded under ours, because the bug was an interaction between the two:
 * BlockNote spaces a heading with `padding-top: 18px`, and our colored-heading
 * rule cut that to 3px, so blue H2s and grey H3s sat flush against the block
 * above (#717).
 */
test.describe('heading spacing', () => {
  const heading = (level: number, label: string, backgroundColor?: string) => ({
    type: 'heading',
    props: { level, ...(backgroundColor ? { backgroundColor } : {}) },
    content: text(label),
  });
  const paragraph = (label: string) => ({ type: 'paragraph', content: text(label) });

  /** Mount the blocks in the real reader, in a 700px class-site article. */
  const load = (page: Page, blocks: unknown[]) => mountReader(page, blocks, { width: 700 });

  /**
   * The space above each block's own content: from the bottom of whatever
   * came before it (the previous block's content, or its last child's) to the
   * top of this one. The first block is measured from the top of the page.
   */
  const gaps = (page: Page) =>
    page.evaluate(() => {
      const contents = [...document.querySelectorAll('.bn-editor .bn-block-content')];
      const top = document
        .querySelector('.bn-editor > .bn-block-group')!
        .getBoundingClientRect().top;
      return contents.map((content, i) => {
        const before = i === 0 ? top : contents[i - 1].getBoundingClientRect().bottom;
        return [
          content.textContent,
          Math.round(content.getBoundingClientRect().top - before),
        ] as const;
      });
    });

  test('a heading gets room above it by level, colored or not', async ({ page }) => {
    await load(page, [
      paragraph('intro'),
      heading(2, 'H2', 'blue'),
      paragraph('a'),
      heading(3, 'H3', 'gray'),
      paragraph('b'),
      heading(4, 'H4'),
      paragraph('c'),
      heading(1, 'H1'),
      paragraph('d'),
    ]);

    // Padding above each heading is its gap less the 8px a paragraph pads
    // under itself: H2 and H3 22 - 8 = 14px, H4 16 - 8 = 8px, H1 56 - 8 = 48px.
    // Under the heading: 8px (H2, H3), 4px (H4), 10px (H1).
    expect(await gaps(page)).toEqual([
      ['intro', 0],
      ['H2', 14],
      ['a', 8],
      ['H3', 14],
      ['b', 8],
      ['H4', 8],
      ['c', 4],
      ['H1', 48],
      ['d', 10],
    ]);
  });

  test('a heading right after a heading stays with it, and the first block has no gap', async ({
    page,
  }) => {
    await load(page, [heading(2, 'first', 'blue'), heading(3, 'under it', 'gray'), paragraph('x')]);

    // The H2's 8px under it plus the H3's 8px step: 16px, then 8px under the H3.
    expect(await gaps(page)).toEqual([
      ['first', 0],
      ['under it', 16],
      ['x', 8],
    ]);
  });

  test("a heading with children (a toggle's body) keeps the gap to the next heading", async ({
    page,
  }) => {
    await load(page, [
      { ...heading(2, 'Week 1', 'blue'), children: [paragraph('notes')] },
      heading(2, 'Week 2', 'blue'),
    ]);

    expect(await gaps(page)).toEqual([
      ['Week 1', 0],
      ['notes', 8],
      ['Week 2', 14],
    ]);
  });

  test('the space above and below a heading belongs to the heading', async ({ page }) => {
    // BlockNote's side menu finds the hovered block by walking up to its
    // `.bn-block` (getDraggableBlockFromElement), and the section fade goes by
    // the block too, so space outside that box hides the drag handle and dims
    // a ticked section while the pointer crosses it.
    await load(page, [paragraph('p'), heading(2, 'colored', 'blue'), paragraph('q')]);

    const owners = await page.evaluate(() => {
      const bar = document.querySelector('.bn-block-content[data-content-type="heading"]')!;
      const { left, top, bottom } = bar.getBoundingClientRect();
      const ownerAt = (y: number) =>
        document.elementFromPoint(left + 20, y)?.closest('.bn-block')?.textContent;
      return [ownerAt(top - 14), ownerAt(bottom + 3)];
    });
    expect(owners).toEqual(['colored', 'colored']);
  });

  test('the gap is outside a colored bar, not padding inside it', async ({ page }) => {
    await load(page, [paragraph('p'), heading(2, 'colored', 'blue'), heading(4, 'plain')]);

    const paddingTop = await page.$$eval('.bn-block-content[data-content-type="heading"]', els =>
      els.map(el => getComputedStyle(el).paddingTop)
    );
    expect(paddingTop).toEqual(['3px', '0px']);

    // BlockNote tints a colored block's whole `.bn-block`, which now holds the
    // gap: left on, a blue H2 would paint 28px of blue above its bar.
    const blockBackground = await page.$eval(
      '.bn-block:has(> [data-content-type="heading"][data-background-color])',
      el => getComputedStyle(el).backgroundColor
    );
    expect(blockBackground).toBe('rgba(0, 0, 0, 0)');
  });

  test("the reader's tick box sits on the heading's first line", async ({ page }) => {
    // It used to assume BlockNote's 18px top padding, so on a colored heading
    // (3px) it sat 15px below the text.
    await load(page, [paragraph('p'), heading(2, 'colored', 'blue'), heading(3, 'plain')]);

    const offsets = await page.evaluate(() =>
      [...document.querySelectorAll('.bn-block-content[data-content-type="heading"]')].map(el => {
        el.setAttribute('data-checkable', 'true');
        const box = document.createElement('button');
        box.className = 'pg-section-check';
        el.appendChild(box);
        const line = el.querySelector('h1, h2, h3, h4, h5, h6')!.getBoundingClientRect();
        const check = box.getBoundingClientRect();
        return Math.round(Math.abs((check.top + check.bottom) / 2 - (line.top + line.bottom) / 2));
      })
    );
    expect(offsets).toEqual([0, 0]);
  });

  /* Room around code and terminal blocks: BlockNote gives them none, so the
     dark card touched the paragraph above and below it. */
  const code = (source: string) => ({
    type: 'codeBlock',
    props: { language: 'typescript' },
    content: text(source),
  });
  const terminal = (command: string) => ({ type: 'terminal', props: { code: command } });

  /** The gaps alone; a card's text also holds its language or title bar. */
  const spacing = async (page: Page) => (await gaps(page)).map(([, gap]) => gap);

  test('a code or terminal block gets room above and below it', async ({ page }) => {
    await load(page, [
      paragraph('a'),
      code('const a = 1;'),
      paragraph('b'),
      terminal('npm run dev'),
      paragraph('c'),
    ]);

    // 16px (1em of the 16px body) on each side of each card.
    expect(await spacing(page)).toEqual([0, 16, 16, 16, 16]);
  });

  test('two cards in a row share one gap; a heading keeps its own', async ({ page }) => {
    await load(page, [code('one'), terminal('two'), heading(2, 'next', 'blue'), paragraph('x')]);

    // No gap on the first block, one 16px gap between the cards (padding does
    // not collapse, so this is not 32), and the H2's full 22px after a card
    // (a card pads nothing under itself).
    expect(await spacing(page)).toEqual([0, 16, 22, 8]);
  });

  test('a card under a heading stays with it', async ({ page }) => {
    await load(page, [paragraph('p'), heading(3, 'Example', 'gray'), code('const a = 1;')]);

    expect(await spacing(page)).toEqual([0, 14, 8]);
  });

  test("a card in a list item's children gets the gap on both sides", async ({ page }) => {
    const step = (label: string, source: string) => ({
      type: 'numberedListItem',
      content: text(label),
      children: [code(source)],
    });
    await load(page, [step('Install', 'npm install'), step('Run', 'npm run dev'), paragraph('x')]);

    expect(await spacing(page)).toEqual([0, 16, 16, 16, 16]);
  });

  test("a card opening a toggle heading's body stays with the heading", async ({ page }) => {
    await load(page, [{ ...heading(2, 'Week 1', 'blue'), children: [code('const a = 1;')] }]);

    expect(await spacing(page)).toEqual([0, 8]);
  });

  test('a terminal, inside its .react-renderer, gets the gap too', async ({ page }) => {
    // The editor and the reader wrap a React block's content in a
    // `.react-renderer`; the gap rules have to see through it.
    await load(page, [
      paragraph('a'),
      terminal('one'),
      paragraph('b'),
      heading(3, 'H3'),
      terminal('two'),
    ]);
    expect(
      await page.$$eval('[data-content-type="terminal"]', els =>
        els.every(el => el.parentElement?.classList.contains('react-renderer'))
      ),
      'the reader wraps the terminal in a .react-renderer'
    ).toBe(true);

    expect(await spacing(page)).toEqual([0, 16, 16, 14, 8]);
  });

  test('the space around a card belongs to the card', async ({ page }) => {
    // As with headings: space outside `.bn-block` hides the drag handle and
    // dims a ticked section while the pointer crosses it.
    await load(page, [paragraph('p'), code('const a = 1;'), paragraph('q')]);

    const owners = await page.evaluate(() => {
      const card = document.querySelector('.bn-block-content[data-content-type="codeBlock"]')!;
      const { left, top, bottom } = card.getBoundingClientRect();
      const ownerAt = (y: number) =>
        document
          .elementFromPoint(left + 20, y)
          ?.closest('.bn-block')
          ?.querySelector(':scope > .bn-block-content')
          ?.getAttribute('data-content-type');
      return [ownerAt(top - 8), ownerAt(bottom + 8)];
    });
    // Above the card is its own padding; below it is the next paragraph's.
    expect(owners).toEqual(['codeBlock', 'paragraph']);
  });
});
