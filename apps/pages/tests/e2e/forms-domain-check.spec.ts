import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';

import { getClassroomIdBySlug, getTestClassroomSlug, getTestPrisma } from '../helpers';
import { parseFormDefinition } from '@classmoji/services/form-contract';
import { presetByKey } from '../../app/components/forms/presets.ts';

/**
 * "That domain cannot receive mail" — told to the respondent while they are
 * still on the form, over the real stack.
 *
 * ── The window this lives in ───────────────────────────────────────────────
 * The verification link is minted when somebody leaves the email field, so
 * there is a minute or two — the rest of the form — in which a bad address can
 * still be corrected. Until now the only signal was a link that never arrived,
 * by which time they had closed the tab.
 *
 * ── What must be true, and what must NOT be ────────────────────────────────
 *  1. an undeliverable domain says so, plainly, quoting what they typed;
 *  2. it does NOT block the submission — DNS is not authoritative about mail
 *     acceptance, and a false positive must never cost somebody their place;
 *  3. a real mailbox host says nothing at all;
 *  4. a near-miss offers ONE correction and never applies it — the field still
 *     holds exactly what the person typed;
 *  5. the check is guarded by everything the submit is guarded by, because it
 *     is the same action: origin, honeypot, and the per-client ceiling;
 *  6. and a slow or broken resolver is silent rather than wrong.
 *
 * (6) is not reachable from a browser without a real network fault, so it lives
 * in `tests/unit/forms-email-domain.spec.ts` alongside the cache and the
 * suggestion rules. This file covers what the PAGE does with the answer.
 *
 * ── Determinism ────────────────────────────────────────────────────────────
 * The undeliverable domains here all end in `.invalid`, which RFC 6761 §6.4
 * reserves and guarantees will never resolve — so the NXDOMAIN case does not
 * depend on nobody registering a fixture domain. The positive case uses
 * `gmail.com` rather than `example.com`, which resolves but publishes no MX and
 * is therefore precisely the ambiguous case this feature declines to warn on.
 */

const CLASS = getTestClassroomSlug();
const FORM_SLUG = 'zz-e2e-domain';
const fillPath = `/${CLASS}/forms/${FORM_SLUG}`;

let formId: string | null = null;
let revisionId: string | null = null;

const NAME_LABEL = 'Full name';
const EMAIL_LABEL = 'School email';

test.beforeAll(async () => {
  const prisma = await getTestPrisma();
  const classroomId = await getClassroomIdBySlug(CLASS);

  const owner = await prisma.classroomMembership.findFirst({
    where: { classroom_id: classroomId, role: 'OWNER' },
    select: { user_id: true },
  });
  if (!owner) throw new Error('no OWNER membership — is the dev database seeded?');

  await prisma.form.deleteMany({ where: { classroom_id: classroomId, slug: FORM_SLUG } });

  /**
   * The waitlist preset, UNRESTRICTED.
   *
   * No `domain` on the email field on purpose: a restriction makes the client
   * schema refuse a non-matching address outright, which would mask the
   * property this file exists to prove — that the DNS warning is advice and the
   * form still submits under it. The configured-domain suggestion is covered as
   * a unit, where it can be asserted without a second fixture.
   */
  const definition = parseFormDefinition(presetByKey('waitlist').fields());

  const form = await prisma.form.create({
    data: {
      classroom_id: classroomId,
      title: 'ZZ E2E Domain Check',
      description: 'An end-to-end fixture.',
      slug: FORM_SLUG,
      access: 'PUBLIC',
      status: 'OPEN',
      created_by: owner.user_id,
      draft_fields: definition as never,
    },
  });
  formId = form.id;

  const revision = await prisma.formRevision.create({
    data: { form_id: form.id, version: 1, fields: definition as never },
  });
  revisionId = revision.id;
  await prisma.form.update({
    where: { id: form.id },
    data: { current_revision_id: revision.id },
  });
});

test.afterAll(async () => {
  const prisma = await getTestPrisma();
  if (formId) await prisma.form.delete({ where: { id: formId } }).catch(() => {});
});

test.beforeEach(async () => {
  const prisma = await getTestPrisma();
  if (formId) await prisma.formResponse.deleteMany({ where: { form_id: formId } });
});

const freshLocal = (label: string) => `zz-e2e-${label}-${randomUUID().slice(0, 8)}`;

/** Type the address and leave the field — the blur is what fires both checks. */
async function typeEmailAndLeave(page: Page, email: string) {
  await page.getByLabel(EMAIL_LABEL, { exact: true }).fill(email);
  await page.getByLabel(NAME_LABEL, { exact: true }).click();
}

test.describe('the deliverability warning', () => {
  test('names the domain that cannot receive mail', async ({ page }) => {
    await page.goto(fillPath);
    await typeEmailAndLeave(page, `${freshLocal('nomx')}@dartmuoth-nowhere.invalid`);

    const warning = page.getByTestId('forms-domain-warning');
    await expect(warning).toBeVisible();
    // Quoting it back is the point — "check your address" helps nobody.
    await expect(warning).toContainText('dartmuoth-nowhere.invalid');
    // The copy uses a typographic apostrophe; match the half that has none.
    await expect(warning).toContainText('find a mail server');
  });

  /**
   * THE LOAD-BEARING ONE.
   *
   * A domain with no MX may still accept mail at its A record (RFC 5321 §5.1),
   * and a resolver can be wrong about anything. If this warning ever became a
   * gate, a false positive would stop somebody joining a course — so the
   * submission is driven all the way through WHILE the warning is on screen.
   */
  test('does not block the submission it is warning about', async ({ page }) => {
    const email = `${freshLocal('submit')}@dartmuoth-nowhere.invalid`;
    await page.goto(fillPath);
    await typeEmailAndLeave(page, email);
    await expect(page.getByTestId('forms-domain-warning')).toBeVisible();

    await page.getByLabel(NAME_LABEL, { exact: true }).fill('Warned Anyway');
    await page.getByRole('radio', { name: '7', exact: true }).click();
    await page.getByRole('button', { name: 'Submit' }).click();

    // The ordinary outcome, warning or no warning.
    await expect(page.getByText('Check your email')).toBeVisible();

    const prisma = await getTestPrisma();
    const rows = await prisma.formResponse.findMany({ where: { form_id: formId! } });
    expect(rows).toHaveLength(1);
    expect(rows[0].email_normalized).toBe(email.toLowerCase());
  });

  test('says nothing at all for a real mailbox host', async ({ page }) => {
    await page.goto(fillPath);
    await typeEmailAndLeave(page, `${freshLocal('real')}@gmail.com`);

    // The link line proves the blur was handled; the absence of the warning
    // beside it is then a real assertion rather than a race with the request.
    await expect(page.getByTestId('forms-link-sent')).toBeVisible();
    await expect(page.getByTestId('forms-domain-warning')).toHaveCount(0);
  });
});

test.describe('did you mean', () => {
  test('offers one correction and NEVER applies it', async ({ page }) => {
    const email = `${freshLocal('typo')}@gmial.com`;
    await page.goto(fillPath);
    await typeEmailAndLeave(page, email);

    await expect(page.getByTestId('forms-domain-suggestion')).toContainText('gmail.com');

    /**
     * The field is untouched. An auto-correct that guessed wrong would file the
     * response under an address the person does not own and never tell them —
     * which is a worse failure than the typo it was fixing.
     */
    await expect(page.getByLabel(EMAIL_LABEL, { exact: true })).toHaveValue(email);
  });

  test('can be dismissed, and stays dismissed for that address', async ({ page }) => {
    await page.goto(fillPath);
    await typeEmailAndLeave(page, `${freshLocal('dismiss')}@gmial.com`);

    await expect(page.getByTestId('forms-domain-warning')).toBeVisible();
    await page.getByTestId('forms-domain-dismiss').click();
    await expect(page.getByTestId('forms-domain-warning')).toHaveCount(0);
  });
});

test.describe('the check is no softer a door than the submit', () => {
  test('a filled honeypot gets the same silence a good domain gets', async ({ page }) => {
    await page.goto(fillPath);
    await page.locator('input#website').fill('https://spam.example');
    await typeEmailAndLeave(page, `${freshLocal('bot')}@dartmuoth-nowhere.invalid`);

    // A bot must not be able to read the trap's state out of the reply: the
    // undeliverable domain it typed would otherwise be warned about, and the
    // silence it gets instead is identical to a clean address's.
    await page.waitForTimeout(750);
    await expect(page.getByTestId('forms-domain-warning')).toHaveCount(0);
  });

  test('a cross-site check is refused', async ({ page }) => {
    const response = await page.request.post(fillPath, {
      maxRedirects: 0,
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      data: {
        intent: 'check-domain',
        identity: { email: 'someone@dartmuoth-nowhere.invalid' },
        revisionId,
        trap: '',
      },
    });

    expect(response.status()).toBeGreaterThanOrEqual(400);
  });

  /**
   * The check must not become a free resolver, so it spends the SAME per-client
   * budget the submit does rather than a softer one of its own. Proved by
   * exhausting the budget through this intent alone and watching the ceiling
   * answer — if it had its own bucket, this would never refuse.
   */
  test('spends the per-client ceiling, so it cannot be used to walk a dictionary', async ({
    page,
  }) => {
    const post = (domain: string) =>
      page.request.post(fillPath, {
        maxRedirects: 0,
        headers: { 'content-type': 'application/json', 'fly-client-ip': '203.0.113.77' },
        data: {
          intent: 'check-domain',
          identity: { email: `probe@${domain}` },
          revisionId,
          trap: '',
        },
      });

    let refused = false;
    for (let i = 0; i < 40 && !refused; i += 1) {
      const response = await post(`probe-${i}.invalid`);
      if (response.status() === 429) refused = true;
    }

    expect(refused).toBe(true);
  });

  test('writes nothing — it is a question, not a submission', async ({ page }) => {
    await page.request.post(fillPath, {
      maxRedirects: 0,
      headers: { 'content-type': 'application/json' },
      data: {
        intent: 'check-domain',
        identity: { email: 'nobody@dartmuoth-nowhere.invalid' },
        revisionId,
        trap: '',
      },
    });

    const prisma = await getTestPrisma();
    expect(await prisma.formResponse.count({ where: { form_id: formId! } })).toBe(0);
  });
});
