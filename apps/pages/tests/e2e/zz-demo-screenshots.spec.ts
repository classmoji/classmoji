import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';

import { getTestClassroomSlug, getTestPrisma, loginAs } from '../helpers';

/**
 * NOT A TEST — a scripted walkthrough that leaves Tim something to look at.
 *
 * It drives the demo setup through the real UI (so the builder wiring is
 * exercised rather than asserted about) and photographs each state in both
 * themes. Run on purpose:
 *
 *   npx playwright test tests/e2e/zz-demo-screenshots.spec.ts
 *
 * It is skipped unless FORMS_DEMO_SHOTS is set, so it never runs as part of the
 * ordinary suite: it edits a REAL form in the dev database (publishing a new
 * revision of the CS52 waitlist) and a suite that quietly republished somebody's
 * demo data on every run would be a nasty surprise.
 */

const RUN = Boolean(process.env.FORMS_DEMO_SHOTS);
const CLASS = getTestClassroomSlug();
const SHOTS =
  '/private/tmp/claude-501/-Users-tim-Sandbox-classmoji-classmoji/bcb8316f-2683-4d33-8eb4-2d2c3dc40ac5/scratchpad';

const WAITLIST = 'cs52-waitlist';
const fillPath = `/${CLASS}/forms/${WAITLIST}`;

/** Photograph one state in both themes, since every surface must work in both. */
async function shoot(page: Page, name: string) {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/${name}-light.png`, fullPage: true });

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/${name}-dark.png`, fullPage: true });

  await page.emulateMedia({ colorScheme: 'light' });
}

test.describe.configure({ mode: 'serial' });

test.describe('demo walkthrough', () => {
  // Guarded here rather than with `describe.skipIf`, which this Playwright
  // version does not have.
  test.skip(!RUN, 'set FORMS_DEMO_SHOTS=1 to run the demo walkthrough');

  test('phase 1 — the domain restriction, set in the builder', async ({ page }) => {
    await loginAs(page, 'owner', `/${CLASS}/forms/${WAITLIST}/edit`);
    await page.waitForURL(url => url.pathname.includes('/edit'));

    // Open the email field's config so the new control is on screen.
    await page.getByText('School email', { exact: true }).first().click();

    const domain = page.getByTestId('forms-field-domain');
    await expect(domain).toBeVisible();
    await domain.fill('dartmouth.edu');
    // Blur, so the help line re-renders with the domain named in it.
    await page.getByText('Restrict to a domain (optional)').first().click();

    /**
     * The demo form's close date had already lapsed, which makes the public
     * page render "This form is closed" and the phase-2 demo impossible. Pushed
     * out here, through the same builder control an instructor would use.
     */
    const closes = page.locator('input[type="datetime-local"]').first();
    if (await closes.isVisible().catch(() => false)) {
      const future = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
      const pad = (n: number) => String(n).padStart(2, '0');
      await closes.fill(
        `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T12:00`
      );
      await page.waitForTimeout(400);
    }

    await shoot(page, 'phase1-builder-domain');

    /**
     * A live form is edited by publishing a NEW VERSION, and that asks for
     * confirmation in-app (see `forms-builder-publish-confirm.spec.ts`) — so
     * the dialog's own button is the one that actually publishes.
     */
    await page.getByRole('button', { name: 'Publish new version' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Publish new version' }).click();
    await page.waitForTimeout(2000);
  });

  test('phase 1 — the three existing responses still render', async ({ page }) => {
    await loginAs(page, 'owner', `/${CLASS}/forms/${WAITLIST}/responses`);
    await page.waitForURL(url => url.pathname.includes('/responses'));
    await page.waitForTimeout(800);
    await shoot(page, 'phase1-responses-intact');
  });

  test('phase 2 — the blur warning and the did-you-mean', async ({ page }) => {
    await page.goto(fillPath);
    await page.getByLabel('School email', { exact: true }).fill('ada@dartmuoth.edu');
    await page.getByLabel('Full name', { exact: true }).click();

    await expect(page.getByTestId('forms-domain-warning')).toBeVisible({ timeout: 15_000 });
    await shoot(page, 'phase2-domain-warning-and-suggestion');
  });

  test('phase 3 — the bounced state, while they are still on the form', async ({ page }) => {
    const email = `zz-demo-${randomUUID().slice(0, 6)}@example.edu`;

    await page.goto(fillPath);
    await page.getByLabel('School email', { exact: true }).fill(email);
    await page.getByLabel('Full name', { exact: true }).click();
    await expect(page.getByTestId('forms-link-sent')).toBeVisible({ timeout: 15_000 });

    // The state the verified webhook writes, written directly.
    const prisma = await getTestPrisma();
    const response = await prisma.formResponse.findFirstOrThrow({
      where: { email_normalized: email.toLowerCase() },
      select: { id: true },
    });
    await prisma.formMagicToken.updateMany({
      where: { response_id: response.id },
      data: {
        delivery_state: 'BOUNCED',
        delivery_detail: 'Permanent/General: The recipient does not exist.',
      },
    });

    await expect(page.getByTestId('forms-bounced')).toBeVisible({ timeout: 20_000 });
    await shoot(page, 'phase3-bounced-on-form');

    /**
     * The OTHER bounced surface: the check-email takeover.
     *
     * Somebody who finished the form before the bounce landed is looking at
     * "check your email", which is now known to be false. Submitting here gets
     * them onto that screen so the replacement copy can be photographed too —
     * the in-form banner and this takeover are different states and Tim should
     * see both.
     */
    await page.getByLabel('Full name', { exact: true }).fill('Bounced Demo');
    await page.getByRole('radio', { name: '7', exact: true }).click();
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByTestId('forms-bounced')).toBeVisible({ timeout: 20_000 });
    await shoot(page, 'phase3-bounced-check-email-screen');

    // And the staff side, where the same fact survives the tab closing.
    await loginAs(page, 'owner', `/${CLASS}/forms/${WAITLIST}/responses`);
    await page.waitForURL(url => url.pathname.includes('/responses'));
    await page.getByText(email).first().click();
    await expect(page.getByTestId('forms-response-delivery')).toBeVisible({ timeout: 10_000 });
    await shoot(page, 'phase3-staff-bounce-reason');
  });
});
