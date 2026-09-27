import { test, expect } from '@playwright/test';

import {
  formAdminTabItems,
  type FormAdminTabsProps,
} from '../../app/components/forms/FormAdminTabs.tsx';

/**
 * The Edit · Responses · Teams switcher on the builder, responses and team-set
 * pages.
 *
 * ── Why this tests the item list and not the markup ────────────────────────
 * The Playwright runner compiles JSX to its own component-testing objects, so a
 * `.tsx` component cannot be rendered with `renderToStaticMarkup` here. The
 * component is a straight map over `formAdminTabItems` (label, href,
 * `aria-current` when `current`, the count after "Responses"), so the rules
 * live in the helper: which tabs exist, where they point, which one is current.
 * Checks on the rendered markup belong in the forms admin e2e, which loads the
 * real pages.
 */

const props = (patch: Partial<FormAdminTabsProps> = {}): FormAdminTabsProps => ({
  classroomSlug: 'product-studio',
  formSlug: 'project-bidding',
  access: 'CLASSROOM',
  active: 'edit',
  responses: 21,
  ...patch,
});

test.describe('formAdminTabItems', () => {
  test('a classroom form gets Edit, Responses and Teams, each at its own path', () => {
    const items = formAdminTabItems(props());
    expect(items.map(item => [item.label, item.href])).toEqual([
      ['Edit', '/product-studio/forms/project-bidding/edit'],
      ['Responses', '/product-studio/forms/project-bidding/responses'],
      ['Teams', '/product-studio/forms/project-bidding/teams'],
    ]);
  });

  test('a public form has no Teams tab', () => {
    const items = formAdminTabItems(props({ access: 'PUBLIC' }));
    expect(items.map(item => item.tab)).toEqual(['edit', 'responses']);
    expect(items.some(item => item.href.endsWith('/teams'))).toBe(false);
  });

  test('a public form asked to show Teams as active marks nothing current', () => {
    // The teams pages refuse a PUBLIC form; the switcher never invents the tab.
    const items = formAdminTabItems(props({ access: 'PUBLIC', active: 'teams' }));
    expect(items.filter(item => item.current)).toEqual([]);
  });

  for (const active of ['edit', 'responses', 'teams'] as const) {
    test(`exactly one tab is current when ${active} is active`, () => {
      const current = formAdminTabItems(props({ active })).filter(item => item.current);
      expect(current.map(item => item.tab)).toEqual([active]);
    });
  }

  test('the count sits on Responses only', () => {
    const items = formAdminTabItems(props({ responses: 21 }));
    expect(items.map(item => [item.tab, item.count])).toEqual([
      ['edit', null],
      ['responses', 21],
      ['teams', null],
    ]);
  });

  test('zero is a count; an omitted count is none', () => {
    const count = (responses: number | null | undefined) =>
      formAdminTabItems(props({ responses })).find(item => item.tab === 'responses')?.count;
    expect(count(0)).toBe(0);
    expect(count(undefined)).toBeNull();
    expect(count(null)).toBeNull();
  });
});
