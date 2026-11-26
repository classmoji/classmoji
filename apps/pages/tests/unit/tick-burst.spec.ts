/**
 * The tick burst (`viewer/sections/tickBurst.ts`, the shared click burst's
 * rays from `@classmoji/ui-components/click-burst`): its ray geometry, and
 * when the real reader plays it (`tests/helpers/readerHarness.ts`): once on
 * the reader's own tick of a heading box or a student check list item (never
 * also the click burst every control gives), never on untick, never from an
 * inert "View as" box, never under reduced motion; its colour (`--pg-burst`,
 * lighter in dark mode), the heading tooltip it hides, and the student item's
 * check colour. And the click burst itself on a plain reader control (a
 * toggle's button): once per click, in the same green.
 */
import { test, expect, type Page } from '@playwright/test';

import { burstRays } from '@classmoji/ui-components/click-burst';
import { mountReader, siteIslandData } from '../helpers/readerHarness.ts';

test.describe('burst geometry', () => {
  test('four rays fanning upward, 10%–25% out, sliding a quarter of the size', () => {
    const size = 60;
    const rays = burstRays(size);
    expect(rays).toHaveLength(4);
    const angles = rays.map(ray =>
      Math.round((Math.atan2(-(ray.y2 - size / 2), ray.x2 - size / 2) * 180) / Math.PI)
    );
    expect(angles).toEqual([45, 80, 115, 150]);
    for (const ray of rays) {
      // Every ray points up (−y) and slides further along its own direction.
      expect(ray.y2).toBeLessThan(ray.y1);
      expect(Math.hypot(ray.x1 - 30, ray.y1 - 30)).toBeCloseTo(6);
      expect(Math.hypot(ray.x2 - 30, ray.y2 - 30)).toBeCloseTo(15);
      expect(Math.hypot(ray.dx, ray.dy)).toBeCloseTo(15);
      expect(Math.sign(ray.dx)).toBe(Math.sign(ray.x2 - ray.x1));
      expect(Math.sign(ray.dy)).toBe(Math.sign(ray.y2 - ray.y1));
    }
  });
});

const text = (value: string) => [{ type: 'text', text: value, styles: {} }];
const blocks = [
  {
    id: 'h-done',
    type: 'heading',
    props: { level: 2, checkable: true },
    content: text('Setup'),
    children: [],
  },
  { id: 'p-1', type: 'paragraph', content: text('Do the setup.') },
  {
    id: 'h-todo',
    type: 'heading',
    props: { level: 2, checkable: true },
    content: text('Next'),
    children: [],
  },
  {
    id: 'item-todo',
    type: 'checkListItem',
    props: { checked: false, personal: true },
    content: text('Install Git'),
  },
  {
    id: 'item-author',
    type: 'checkListItem',
    props: { checked: true },
    content: text('An author’s item'),
  },
  {
    id: 'toggle',
    type: 'toggleListItem',
    content: text('More'),
    children: [{ id: 'toggle-body', type: 'paragraph', content: text('Hidden') }],
  },
];

/** The student's own view (`live`), or "View as" them (inert). */
function readerData(live: boolean, checked: string[]) {
  const data = siteIslandData(blocks);
  data.payload.readerSections = {
    staff: false,
    signedIn: true,
    member: true,
    showChecks: true,
    showUnlock: true,
    canCheck: live,
    canUnlock: live,
    checked,
    unlocked: {},
  };
  return data;
}

/**
 * Mount (in dark mode with `dark`), answer the section API, and record every
 * burst appended to <body>.
 */
async function mount(page: Page, live: boolean, dark = false, checked = ['h-done']) {
  await mountReader(page, blocks, { data: readerData(live, checked) });
  await page.route('**/api/page-sections', async route => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { intent: string };
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, checked: body.intent === 'check' }),
    });
  });
  // Recorded as each burst lands: it removes itself 400 ms later.
  await page.evaluate(dark => {
    if (dark) document.documentElement.classList.add('dark');
    const seen: Burst[] = [];
    (window as unknown as { __bursts: Burst[] }).__bursts = seen;
    new MutationObserver(records => {
      for (const record of records)
        for (const node of record.addedNodes) {
          if (!(node instanceof SVGElement) || !node.classList.contains('cm-burst')) continue;
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          seen.push({
            lines: node.querySelectorAll('line').length,
            ariaHidden: node.getAttribute('aria-hidden'),
            position: style.position,
            pointerEvents: style.pointerEvents,
            cx: rect.left + rect.width / 2,
            cy: rect.top + rect.height / 2,
            color: style.color,
            tooltips: [...document.querySelectorAll('.pg-section-check--burst')].map(
              button => getComputedStyle(button, '::after').opacity
            ),
          });
        }
    }).observe(document.body, { childList: true });
  }, dark);
}

interface Burst {
  lines: number;
  ariaHidden: string | null;
  position: string;
  pointerEvents: string;
  cx: number;
  cy: number;
  /** The rays' colour (computed). */
  color: string;
  /** The ::after (tooltip) opacity of every heading box marked as bursting. */
  tooltips: string[];
}

const bursts = (page: Page) =>
  page.evaluate(() => (window as unknown as { __bursts: Burst[] }).__bursts.slice());
const lineCounts = async (page: Page) => (await bursts(page)).map(burst => burst.lines);
const live = (page: Page) => page.locator('body > svg.cm-burst').count();
const bursting = (page: Page) => page.locator('.pg-section-check--burst').count();
/** `--pg-primary`'s colour (#1f883d without the page's tailwind tokens) and the dark burst's. */
const GREEN = 'rgb(31, 136, 61)';
const DARK_BURST = 'rgb(63, 185, 80)';
const headingBox = (page: Page, id: string) =>
  page.locator(`.bn-block[data-id="${id}"] .pg-section-check`);
const itemBox = (page: Page, id: string) =>
  page.locator(`.bn-block[data-id="${id}"] input[type="checkbox"]`);
const toggleButton = (page: Page) =>
  page.locator('.bn-block[data-id="toggle"] .bn-toggle-button').first();

test.describe('the tick burst in the reader', () => {
  test('ticking a heading on bursts once, tooltip hidden, and both are back after it plays', async ({
    page,
  }) => {
    await mount(page, true);
    const box = headingBox(page, 'h-todo');
    const tooltip = () => box.evaluate(el => getComputedStyle(el, '::after').opacity);
    // The tooltip is fully shown under the hover before the tick.
    await box.hover();
    await expect.poll(tooltip).toBe('1');
    await box.click();
    await expect(box).toHaveAttribute('aria-checked', 'true');
    const [burst, ...more] = await bursts(page);
    expect(more).toEqual([]);
    expect(burst).toMatchObject({
      lines: 4,
      ariaHidden: 'true',
      position: 'fixed',
      pointerEvents: 'none',
      color: GREEN,
      // The ticked box hides its tooltip (shown under the hover) while the rays fly.
      tooltips: ['0'],
    });
    // Centred on the box.
    const at = await box.boundingBox();
    if (!at) throw new Error('not drawn');
    expect(burst.cx).toBeCloseTo(at.x + at.width / 2, 0);
    expect(burst.cy).toBeCloseTo(at.y + at.height / 2, 0);
    await expect.poll(() => live(page)).toBe(0);
    await expect.poll(() => bursting(page)).toBe(0);
    await expect.poll(tooltip).toBe('1');
  });

  test('dark mode: the rays are the lighter burst green', async ({ page }) => {
    await mount(page, true, true);
    await headingBox(page, 'h-todo').click();
    const item = itemBox(page, 'item-todo');
    await item.click();
    await expect(item).toBeChecked();
    expect((await bursts(page)).map(burst => burst.color)).toEqual([DARK_BURST, DARK_BURST]);
  });

  test('unticking a heading bursts nothing', async ({ page }) => {
    await mount(page, true);
    const box = headingBox(page, 'h-done');
    await box.click();
    await expect(box).toHaveAttribute('aria-checked', 'false');
    await page.waitForTimeout(100);
    expect(await lineCounts(page)).toEqual([]);
  });

  test('ticking a student check list item on bursts once', async ({ page }) => {
    await mount(page, true);
    const item = itemBox(page, 'item-todo');
    await item.click();
    await expect(item).toBeChecked();
    const [burst] = await bursts(page);
    expect(burst).toMatchObject({ lines: 4, color: GREEN, tooltips: [] });
    expect(await lineCounts(page)).toEqual([4]);
    await expect.poll(() => live(page)).toBe(0);
  });

  test('unticking a student check list item bursts nothing', async ({ page }) => {
    await mount(page, true, false, ['h-done', 'item-todo']);
    const item = itemBox(page, 'item-todo');
    await expect(item).toBeChecked();
    await item.click();
    await expect(item).not.toBeChecked();
    await page.waitForTimeout(100);
    expect(await lineCounts(page)).toEqual([]);
  });

  test('a student’s item ticks in the check green; an author’s item keeps BlockNote’s box', async ({
    page,
  }) => {
    await mount(page, true);
    const accent = (id: string) =>
      itemBox(page, id).evaluate(el => getComputedStyle(el).accentColor);
    expect(await accent('item-todo')).toBe(GREEN);
    expect(await accent('item-author')).toBe('auto');
  });

  test('"View as": clicking the inert boxes bursts nothing', async ({ page }) => {
    await mount(page, false);
    await headingBox(page, 'h-todo').click({ force: true });
    await itemBox(page, 'item-todo').click({ force: true });
    await page.waitForTimeout(100);
    expect(await lineCounts(page)).toEqual([]);
    expect(await bursting(page)).toBe(0);
  });

  test('reduced motion: ticking on bursts nothing', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mount(page, true);
    const box = headingBox(page, 'h-todo');
    await box.click();
    await expect(box).toHaveAttribute('aria-checked', 'true');
    const item = itemBox(page, 'item-todo');
    await item.click();
    await expect(item).toBeChecked();
    await page.waitForTimeout(100);
    expect(await lineCounts(page)).toEqual([]);
    expect(await bursting(page)).toBe(0);
  });
});

test.describe('the click burst on a reader control', () => {
  test('a toggle’s button bursts once per click, at the pointer, in the check green', async ({
    page,
  }) => {
    await mount(page, true);
    const button = toggleButton(page);
    const box = await button.boundingBox();
    if (!box) throw new Error('not drawn');
    const point = { x: Math.round(box.x + 3), y: Math.round(box.y + 4) };
    await page.mouse.click(point.x, point.y);
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    const [burst, ...more] = await bursts(page);
    expect(more).toEqual([]);
    expect(burst).toMatchObject({
      lines: 4,
      ariaHidden: 'true',
      position: 'fixed',
      pointerEvents: 'none',
      color: GREEN,
    });
    // At the pointer, not the button's centre.
    expect(burst.cx).toBeCloseTo(point.x, 0);
    expect(burst.cy).toBeCloseTo(point.y, 0);
    await expect.poll(() => live(page)).toBe(0);
    await page.mouse.click(point.x, point.y);
    expect(await lineCounts(page)).toEqual([4, 4]);
  });

  test('from the keyboard it bursts at the button’s centre', async ({ page }) => {
    await mount(page, true);
    const button = toggleButton(page);
    await button.focus();
    await page.keyboard.press('Enter');
    const [burst, ...more] = await bursts(page);
    expect(more).toEqual([]);
    const at = await button.boundingBox();
    if (!at) throw new Error('not drawn');
    expect(burst.cx).toBeCloseTo(at.x + at.width / 2, 0);
    expect(burst.cy).toBeCloseTo(at.y + at.height / 2, 0);
  });

  test('dark mode: the lighter burst green', async ({ page }) => {
    await mount(page, true, true);
    await toggleButton(page).click();
    expect((await bursts(page)).map(burst => burst.color)).toEqual([DARK_BURST]);
  });

  test('a click on text bursts nothing', async ({ page }) => {
    await mount(page, true);
    await page.locator('.bn-block[data-id="p-1"]').click();
    await page.waitForTimeout(100);
    expect(await lineCounts(page)).toEqual([]);
  });

  test('reduced motion: nothing', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mount(page, true);
    await toggleButton(page).click();
    await page.waitForTimeout(100);
    expect(await lineCounts(page)).toEqual([]);
  });
});
