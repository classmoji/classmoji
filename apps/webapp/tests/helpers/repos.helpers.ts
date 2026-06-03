import { Page, Locator } from '@playwright/test';

/**
 * The repos list (`/admin/<org>/repos`) is an expandable tree table: each
 * repository row (`data-row-key="repository-<id>"`) has one or more child
 * assignment rows (`data-row-key="assignment-<id>"`) whose text repeats the
 * repository title (e.g. "qa-edit-weight" -> child "qa-edit-weight Part 1").
 *
 * A naive `getByRole('row').filter({ hasText: title })` therefore matches BOTH
 * the repository row and its assignment child, tripping Playwright's strict
 * mode. Always select the repository-level row through this helper so row-scoped
 * assertions/actions are unambiguous.
 */
export function repositoryRow(page: Page, title: string): Locator {
  return page.locator('tr[data-row-key^="repository-"]').filter({ hasText: title });
}
