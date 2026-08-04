import { Page, expect } from '@playwright/test';

/**
 * Wait for the page to be fully loaded (no spinners, loading states).
 */
export async function waitForPageLoad(page: Page): Promise<void> {
  // Wait for network to be idle
  await page.waitForLoadState('networkidle');

  // Wait for any loading spinners to disappear
  const loadingSpinner = page.locator('[data-testid="loading"], .animate-spin, .loading');
  await expect(loadingSpinner)
    .toHaveCount(0, { timeout: 10000 })
    .catch(() => {
      // Loading spinner might not exist, that's fine
    });
}

/**
 * Reload the page until `predicate` reports the saved state is visible, or
 * attempts run out (the last attempt's state is left for the caller's own
 * assertions to fail loudly).
 *
 * Why: the dual-write save path commits deck.json + index.html via the git
 * data API (uploadBatch). GitHub's Contents API GETs can serve a cached
 * pre-save copy for a short window after a git-data commit (read-after-write
 * consistency across API families), so an immediate reload can render
 * pre-save content even though the commit landed. The save itself is
 * verified-correct; this helper absorbs the bounded consistency window.
 */
export async function reloadUntil(
  page: Page,
  predicate: () => Promise<boolean>,
  { attempts = 4, delayMs = 3000 }: { attempts?: number; delayMs?: number } = {}
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await page.reload();
    await waitForReveal(page);
    if (await predicate()) return;
    if (attempt < attempts) await page.waitForTimeout(delayMs);
  }
}

/**
 * Wait for Reveal.js to be initialized on the page.
 * This is important for slide presentation pages.
 */
export async function waitForReveal(page: Page): Promise<void> {
  // Wait for the reveal container to be visible
  await expect(page.locator('.reveal')).toBeVisible({ timeout: 15000 });

  // Wait for slides to be rendered
  await expect(page.locator('.reveal .slides')).toBeVisible({ timeout: 10000 });

  // Give Reveal.js a moment to initialize
  await page.waitForTimeout(500);
}

/**
 * Wait for a toast notification to appear.
 */
export async function waitForToast(page: Page, textPattern?: string | RegExp): Promise<void> {
  const toastLocator = page.locator('.Toastify__toast, [role="alert"]');
  await expect(toastLocator).toBeVisible({ timeout: 10000 });

  if (textPattern) {
    if (typeof textPattern === 'string') {
      await expect(toastLocator).toContainText(textPattern);
    } else {
      await expect(toastLocator).toHaveText(textPattern);
    }
  }
}

/**
 * Wait for navigation to a specific URL pattern.
 */
export async function waitForNavigation(page: Page, urlPattern: string | RegExp): Promise<void> {
  await page.waitForURL(urlPattern, { timeout: 15000 });
  await waitForPageLoad(page);
}

/**
 * Wait for content to be saved (after editing).
 * Looks for save indicators or network requests completing.
 */
export async function waitForSave(page: Page): Promise<void> {
  // The save button (handleSave) saves AND exits edit mode, and edit mode only
  // exits after the save fetcher's response arrives — so the button detaching
  // is the deterministic "save completed" signal. The old implementation waited
  // on networkidle, which is sticky per navigation and resolves immediately on
  // an already-idle page: tests reloaded while the save POST was still in
  // flight, so the loader read pre-save content and "persists after reload"
  // assertions failed against the slower dual-write save path.
  await expect(page.locator('button.save-button')).toHaveCount(0, { timeout: 30000 });

  // Wait for any pending save indicators (belt and suspenders)
  const saveIndicator = page.locator('[data-testid="saving"], .saving');
  await expect(saveIndicator)
    .toHaveCount(0, { timeout: 10000 })
    .catch(() => {
      // Save indicator might not exist
    });

  // Let the post-save state (savedContent swap, sha token update) settle
  await page.waitForTimeout(500);
}

/**
 * Retry an action until it succeeds or times out.
 */
export async function retry<T>(
  action: () => Promise<T>,
  options: { maxAttempts?: number; delayMs?: number; timeoutMs?: number } = {}
): Promise<T> {
  const { maxAttempts = 3, delayMs = 1000, timeoutMs = 30000 } = options;
  const startTime = Date.now();

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (Date.now() - startTime > timeoutMs) {
      break;
    }

    try {
      return await action();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError || new Error('Retry failed');
}
