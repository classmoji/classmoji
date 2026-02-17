import { Page, expect } from '@playwright/test';
import { waitForPageLoad, waitForReveal, waitForSave } from './wait.helpers';
import { getTestClassroomSlug } from './env.helpers';

/**
 * Slide visibility options
 */
export type SlideVisibility = 'draft' | 'private' | 'public';

/**
 * Create a new slide presentation.
 * Navigates to the create page, fills the form, and submits.
 *
 * @param page - Playwright page
 * @param title - Slide title
 * @param moduleIndex - Index of the module to select (0-based)
 * @returns The new slide's ID
 */
export async function createSlide(
  page: Page,
  title: string,
  moduleIndex: number = 0
): Promise<string> {
  const classroomSlug = getTestClassroomSlug();

  // Navigate to create page
  await page.goto(`/${classroomSlug}/new`);
  await waitForPageLoad(page);

  // Fill title
  await page.fill('input[name="title"]', title);

  // Select module (first option after the placeholder)
  const moduleSelect = page.locator('select[name="module"]');
  await moduleSelect.selectOption({ index: moduleIndex + 1 }); // +1 to skip "Select a module..." placeholder

  // Submit form
  await page.click('button[type="submit"]');

  // Wait for redirect to edit mode
  await page.waitForURL(/\/[a-f0-9-]+\?mode=edit/, { timeout: 30000 });

  // Extract slide ID from URL
  const url = new URL(page.url());
  const slideId = url.pathname.split('/')[1];

  // Wait for the editor to load
  await waitForReveal(page);

  return slideId;
}

/**
 * Navigate to a slide in view mode.
 */
export async function viewSlide(page: Page, slideId: string): Promise<void> {
  await page.goto(`/${slideId}`);
  await waitForReveal(page);
}

/**
 * Navigate to a slide in edit mode.
 */
export async function editSlide(page: Page, slideId: string): Promise<void> {
  await page.goto(`/${slideId}?mode=edit`);
  await waitForReveal(page);
}

/**
 * Navigate to present mode for a slide.
 */
export async function presentSlide(page: Page, slideId: string): Promise<void> {
  await page.goto(`/${slideId}/present`);
  await waitForReveal(page);
}

/**
 * Navigate to speaker view for a slide.
 */
export async function speakerView(page: Page, slideId: string): Promise<void> {
  await page.goto(`/${slideId}/speaker`);
  // Speaker view has a different layout
  await expect(page.locator('.speaker-view, #current-slide')).toBeVisible({ timeout: 15000 });
}

/**
 * Navigate to follow (audience sync) mode for a slide.
 */
export async function followSlide(
  page: Page,
  slideId: string,
  shareCode?: string
): Promise<void> {
  let url = `/${slideId}/follow`;
  if (shareCode) {
    url += `?shareCode=${shareCode}`;
  }
  await page.goto(url);
  await waitForReveal(page);
}

/**
 * Save the current slide content.
 * Clicks the save button in the navbar (green checkmark button).
 */
export async function saveSlide(page: Page): Promise<void> {
  // The save button is the green button (bg-green-600) with a checkmark icon
  const saveButton = page.locator('button.bg-green-600');
  await saveButton.click();
  await waitForSave(page);
}

/**
 * Toggle edit mode on the current slide view.
 */
export async function toggleEditMode(page: Page): Promise<void> {
  // Look for edit button
  const editButton = page.locator('[data-testid="edit-button"], button:has-text("Edit"), a[href*="mode=edit"]').first();
  await editButton.click();
  await waitForPageLoad(page);
}

/**
 * Add a text block to the current slide using the toolbar.
 */
export async function addTextBlock(page: Page, text: string = 'New text block...'): Promise<void> {
  // Find and click the insert text button
  const insertTextButton = page.locator('button[title="Add text block"]');
  await insertTextButton.click();

  // Wait for the new paragraph to appear and be selected
  await page.waitForTimeout(300);

  // Type the new text (replaces selected placeholder text)
  await page.keyboard.type(text);
}

/**
 * Add a title (H1) to the current slide.
 */
export async function addHeading(
  page: Page,
  level: 1 | 2 | 3 = 1,
  text: string = 'Heading'
): Promise<void> {
  // Click heading button
  const headingButton = page.locator(`button:has-text("H${level}")`);
  await headingButton.click();

  // Type the heading text
  await page.keyboard.type(text);
}

/**
 * Add a code block to the current slide.
 */
export async function addCodeBlock(page: Page, code: string = '// Your code here'): Promise<void> {
  // Find and click the insert code button
  const insertCodeButton = page.locator('button[title="Add code block"]');
  await insertCodeButton.click();

  // Wait for the code block to appear
  await page.waitForTimeout(300);

  // The code element is contenteditable, so we can type into it
  // First, clear the default content
  await page.keyboard.press('Control+A');
  await page.keyboard.type(code);
}

/**
 * Add a new slide to the right.
 */
export async function addSlideRight(page: Page): Promise<void> {
  // Button displays "→ Add" text
  const addRightButton = page.locator('button:has-text("→ Add")');
  await addRightButton.click();
  await page.waitForTimeout(500); // Wait for Reveal.js to sync
}

/**
 * Add a new slide below (vertical stack).
 */
export async function addSlideBelow(page: Page): Promise<void> {
  // Button displays "↓ Add" text
  const addBelowButton = page.locator('button:has-text("↓ Add")');
  await addBelowButton.click();
  await page.waitForTimeout(500); // Wait for Reveal.js to sync
}

/**
 * Open the speaker notes panel.
 */
export async function openNotesPanel(page: Page): Promise<void> {
  // Click the notes panel header to expand if collapsed
  const notesHeader = page.locator('.slide-notes-panel-header');
  const isCollapsed = await page.locator('.slide-notes-panel.collapsed').count() > 0;

  if (isCollapsed) {
    await notesHeader.click();
    await page.waitForTimeout(200);
  }
}

/**
 * Add speaker notes to the current slide.
 */
export async function addSpeakerNotes(page: Page, notes: string): Promise<void> {
  // Open notes panel if collapsed
  await openNotesPanel(page);

  // Switch to edit mode if in preview mode
  const editButton = page.locator('.notes-mode-toggle button:has-text("Edit")');
  if (await editButton.count() > 0) {
    await editButton.click();
    await page.waitForTimeout(200);
  }

  // Find and fill the notes textarea
  const textarea = page.locator('.slide-notes-panel textarea');
  await textarea.fill(notes);
}

/**
 * Get the current speaker notes content.
 */
export async function getSpeakerNotes(page: Page): Promise<string> {
  await openNotesPanel(page);

  // Check if in edit mode or preview mode
  const textarea = page.locator('.slide-notes-panel textarea');
  if (await textarea.count() > 0) {
    return await textarea.inputValue();
  }

  // In preview mode, get the markdown content
  const preview = page.locator('.notes-preview');
  return await preview.textContent() || '';
}

/**
 * Delete a slide.
 *
 * @param page - Playwright page
 * @param slideId - The slide ID to delete
 * @param classroomSlug - Optional classroom slug (defaults to test classroom)
 */
export async function deleteSlide(
  page: Page,
  slideId: string,
  classroomSlug?: string
): Promise<void> {
  const slug = classroomSlug || getTestClassroomSlug();

  // Navigate to delete page
  await page.goto(`/${slug}/${slideId}/delete`);
  await waitForPageLoad(page);

  // Click delete button - use noWaitAfter since this triggers a cross-origin redirect
  // (from slides app on port 6550 to webapp on port 3050)
  const deleteButton = page.locator('button[type="submit"]:has-text("Delete Slide")');
  await deleteButton.click({ noWaitAfter: true });

  // Wait for redirect back to slides list (cross-origin to webapp)
  await page.waitForURL(/\/admin\/.*\/slides/, { timeout: 15000 });
}

/**
 * Check if the edit button is visible on the current page.
 */
export async function isEditButtonVisible(page: Page): Promise<boolean> {
  const editButton = page.locator('[data-testid="edit-button"], button:has-text("Edit"), a[href*="mode=edit"]');
  return await editButton.count() > 0;
}

/**
 * Check if the present button is visible on the current page.
 */
export async function isPresentButtonVisible(page: Page): Promise<boolean> {
  const presentButton = page.locator('a[href*="/present"], [data-testid="present-button"]');
  return await presentButton.count() > 0;
}

/**
 * Check if speaker notes are visible on the page.
 * This checks for the notes panel in view mode.
 */
export async function areNotesVisible(page: Page): Promise<boolean> {
  const notesPanel = page.locator('.slide-notes-panel');
  return await notesPanel.count() > 0;
}

/**
 * Check if the page contains specific text (for verifying notes are stripped).
 */
export async function pageContainsText(page: Page, text: string): Promise<boolean> {
  const content = await page.content();
  return content.includes(text);
}

/**
 * Set slide visibility via the test API endpoint.
 * Uses the dev-only /api/test/update-visibility endpoint.
 * @param page - Playwright page
 * @param slideId - The slide ID
 * @param visibility - 'draft', 'private', or 'public'
 */
export async function setSlideVisibility(
  page: Page,
  slideId: string,
  visibility: SlideVisibility
): Promise<void> {
  // Get the base URL from current page
  const baseUrl = new URL(page.url()).origin;

  // Use the test-only API endpoint
  const response = await page.request.post(`${baseUrl}/api/test/update-visibility`, {
    headers: {
      'Content-Type': 'application/json',
    },
    data: {
      slideId,
      visibility,
    },
  });

  if (!response.ok()) {
    const text = await response.text();
    throw new Error(`Failed to set visibility: HTTP ${response.status()} - ${text}`);
  }

  const data = await response.json();
  if (data.error) {
    throw new Error(`Failed to set visibility: ${data.error}`);
  }
}

/**
 * Publish a slide (set is_draft=false so students can view).
 */
export async function publishSlide(page: Page, slideId: string): Promise<void> {
  await setSlideVisibility(page, slideId, 'private');
}

/**
 * Get the current slide number.
 */
export async function getCurrentSlideNumber(page: Page): Promise<{ h: number; v: number }> {
  // Reveal.js adds indices to the URL hash
  const hash = new URL(page.url()).hash;
  const match = hash.match(/#\/(\d+)(?:\/(\d+))?/);
  if (match) {
    return {
      h: parseInt(match[1], 10),
      v: match[2] ? parseInt(match[2], 10) : 0,
    };
  }
  return { h: 0, v: 0 };
}

/**
 * Navigate to a specific slide by index.
 */
export async function goToSlide(page: Page, h: number, v: number = 0): Promise<void> {
  const currentUrl = new URL(page.url());
  currentUrl.hash = v > 0 ? `#/${h}/${v}` : `#/${h}`;
  await page.goto(currentUrl.toString());
  await page.waitForTimeout(500); // Wait for Reveal.js transition
}

/**
 * Count the total number of slides in the presentation.
 */
export async function countSlides(page: Page): Promise<number> {
  return await page.locator('.reveal .slides > section').count();
}
