import { test as base, expect } from '@playwright/test';
import * as helpers from '../helpers';

/**
 * Extended test fixture with pre-imported helpers.
 * This makes tests cleaner by providing helper functions in the test context.
 */
export const test = base.extend<{
  helpers: typeof helpers;
}>({
  helpers: async ({}, use) => {
    await use(helpers);
  },
});

// Re-export expect for convenience
export { expect };

// Re-export helpers for direct imports
export * from '../helpers';
