import { Page, expect, Locator } from '@playwright/test';

/**
 * Wait for the page to finish loading data
 * Checks for common loading indicators (Ant Design Skeleton, Spin, etc.)
 */
export async function waitForDataLoad(page: Page, timeout = 15000): Promise<void> {
  // Wait for Ant Design Skeleton components to disappear
  await expect(page.locator('.ant-skeleton')).toHaveCount(0, { timeout });

  // Wait for any loading spinners
  await expect(page.locator('.ant-spin-spinning')).toHaveCount(0, { timeout });

  // Wait for React Router loading states
  await expect(page.locator('[data-loading="true"]')).toHaveCount(0, { timeout });
}

/**
 * Wait for a toast notification to appear
 */
export async function waitForToast(
  page: Page,
  message: string | RegExp,
  type?: 'success' | 'error' | 'warning' | 'info',
  timeout = 5000
): Promise<Locator> {
  let toastSelector = '.Toastify__toast-body';

  if (type) {
    const typeClass = `.Toastify__toast--${type}`;
    toastSelector = `${typeClass} .Toastify__toast-body`;
  }

  const toast = page.locator(toastSelector).filter({ hasText: message });
  await expect(toast).toBeVisible({ timeout });
  return toast;
}

/**
 * Wait for navigation to complete and data to load
 */
export async function waitForNavigation(
  page: Page,
  urlPattern: string | RegExp,
  timeout = 10000
): Promise<void> {
  await page.waitForURL(urlPattern, { timeout });
  await waitForDataLoad(page);
}

/**
 * Wait for a modal to open
 */
export async function waitForModal(
  page: Page,
  title?: string | RegExp,
  timeout = 5000
): Promise<Locator> {
  const modal = title
    ? page.locator('.ant-modal').filter({ hasText: title })
    : page.locator('.ant-modal');

  await expect(modal).toBeVisible({ timeout });
  return modal;
}

/**
 * Wait for a modal to close
 */
export async function waitForModalClose(page: Page, timeout = 5000): Promise<void> {
  await expect(page.locator('.ant-modal')).toHaveCount(0, { timeout });
}

/**
 * Wait for a table to have at least N rows
 */
export async function waitForTableRows(
  page: Page,
  tableSelector: string,
  minRows: number,
  timeout = 10000
): Promise<void> {
  const table = page.locator(tableSelector);
  const rows = table.locator('tbody tr');

  await expect(async () => {
    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(minRows);
  }).toPass({ timeout });
}

/**
 * Wait for an element to be enabled
 */
export async function waitForEnabled(locator: Locator, timeout = 5000): Promise<void> {
  await expect(locator).toBeEnabled({ timeout });
}

/**
 * Wait for network idle (no pending requests)
 */
export async function waitForNetworkIdle(page: Page, timeout = 10000): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout });
}

/**
 * Retry an action until it succeeds or times out
 */
export async function retry<T>(
  action: () => Promise<T>,
  options: { attempts?: number; delay?: number } = {}
): Promise<T> {
  const { attempts = 3, delay = 1000 } = options;
  let lastError: Error | undefined;

  for (let i = 0; i < attempts; i++) {
    try {
      return await action();
    } catch (error) {
      lastError = error as Error;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}
