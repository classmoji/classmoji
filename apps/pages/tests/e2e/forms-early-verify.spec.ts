import { randomUUID } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { test, expect, type Page } from '@playwright/test';

import { getClassroomIdBySlug, getTestClassroomSlug, getTestPrisma, getTestServices } from '../helpers';
import { parseFormDefinition } from '@classmoji/services/form-contract';
import { presetByKey } from '../../app/components/forms/presets.ts';
import { SUBMISSION_RATE_LIMIT } from '../../app/utils/submissionRate.server.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Verifying the ADDRESS early, over the real stack.
 *
 * ── What moved ─────────────────────────────────────────────────────────────
 * The verification mail used to go out when the form was submitted, which made
 * "check your email" a wall every respondent hit at the end. It now goes out
 * when they finish typing their address, so by the time they press Submit the
 * link is already in their inbox — and if they opened it on the way, the submit
 * records the response in one round trip instead of sending them back.
 *
 * ── What this file is for ──────────────────────────────────────────────────
 * The properties that make that safe rather than merely quick:
 *
 *  1. the send fires on blur, once per address, and again for a different one;
 *  2. a link opened before the form is finished says so, and does not render an
 *     empty answer set as if it were a submission;
 *  3. a verified browser submits in one step — and NO second mail is sent;
 *  4. THE BINDING: a browser holding a verified link for one address cannot
 *     submit under another;
 *  5. the old two-step flow still works untouched, because the early send is an
 *     optimisation and never a requirement;
 *  6. the new endpoint is guarded exactly as hard as the submit — origin,
 *     honeypot, per-client ceiling.
 *
 * The magic links are read from the dev log, the same door
 * `forms-fill.spec.ts` uses and the same one a developer uses: the raw token is
 * returned once and stored only as a digest, so the log line is the only place
 * it exists.
 */

const CLASS = getTestClassroomSlug();
const FORM_SLUG = 'zz-e2e-early';
const fillPath = `/${CLASS}/forms/${FORM_SLUG}`;

let formId: string | null = null;
let revisionId: string | null = null;

const NAME_LABEL = 'Full name';
const EMAIL_LABEL = 'School email';
const SCALE_LABEL = 'How familiar are you with the material?';
const LONG_LABEL = 'What are you hoping to get out of the class?';

// ─── The dev log ────────────────────────────────────────────────────────────

function devLogPath(): string {
  const devContext = fs.readFileSync(path.join(__dirname, '../../../../.dev-context'), 'utf-8');
  const match = devContext.match(/File:\s+(\/\S+\.log)/);
  if (!match) throw new Error('no dev log path in .dev-context — is the stack running?');
  return match[1];
}

/**
 * Every DISTINCT link logged for one address, oldest first.
 *
 * De-duplicated, and that is not tidiness. The dev stack multiplexes each
 * service's stdout into the shared log and a single line can land in it more
 * than once — harmless for `forms-fill.spec.ts`, which only ever reads the most
 * recent link, and fatal here, where the assertions are counts. A token is
 * minted exactly once per send and never reused, so unique URLs ARE the number
 * of mails, however many times the line was written.
 */
function linksFor(email: string): string[] {
  const urls = fs
    .readFileSync(devLogPath(), 'utf-8')
    .split('\n')
    .filter(line => line.includes(`[forms:magic-link] to=${email} `))
    .map(line => line.match(/(https?:\/\/\S+)/)?.[1])
    .filter((url): url is string => Boolean(url));
  return [...new Set(urls)];
}

/**
 * Wait until at least `count` links have been logged for an address.
 *
 * POLLED: the line is written by another process through a pipe, so it lags the
 * HTTP response it belongs to by a few milliseconds.
 */
async function waitForLinks(email: string, count: number, timeoutMs = 10_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const links = linksFor(email);
    if (links.length >= count) return links;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(
    `expected ${count} link(s) for ${email} within ${timeoutMs}ms, saw ${linksFor(email).length}`
  );
}

const linkTarget = (url: string): string => {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
};

// ─── Fixture ────────────────────────────────────────────────────────────────

test.beforeAll(async () => {
  const prisma = await getTestPrisma();
  const classroomId = await getClassroomIdBySlug(CLASS);

  const owner = await prisma.classroomMembership.findFirst({
    where: { classroom_id: classroomId, role: 'OWNER' },
    select: { user_id: true },
  });
  if (!owner) throw new Error('no OWNER membership — is the dev database seeded?');

  await prisma.form.deleteMany({ where: { classroom_id: classroomId, slug: FORM_SLUG } });

  const definition = parseFormDefinition(presetByKey('waitlist').fields());

  const form = await prisma.form.create({
    data: {
      classroom_id: classroomId,
      title: 'ZZ E2E Early Verify',
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

async function responsesOf(id: string) {
  const services = await getTestServices();
  return services.formResponse.listByFormId(id);
}

/**
 * A fresh address per test.
 *
 * The dev log is append-only and shared by every service in the stack, so a
 * fixed address would carry links from previous runs into "how many mails were
 * sent?" — which is the assertion this file rests on.
 */
const freshEmail = (label: string) => `zz-e2e-${label}-${randomUUID().slice(0, 8)}@example.edu`;

/** Type the address and leave the field, which is what triggers the send. */
async function typeEmailAndLeave(page: Page, email: string) {
  await page.getByLabel(EMAIL_LABEL, { exact: true }).fill(email);
  // Moving focus is the trigger — a person tabs on, or clicks the next question.
  await page.getByLabel(NAME_LABEL, { exact: true }).click();
}

async function fillTheRest(page: Page, name = 'Maya Chen') {
  await page.getByLabel(NAME_LABEL, { exact: true }).fill(name);
  await page
    .getByRole('radiogroup', { name: SCALE_LABEL })
    .getByRole('radio', { name: '7' })
    .click();
  await page.getByLabel(LONG_LABEL, { exact: true }).fill('Everything, ideally.');
}

// ─── The early send ─────────────────────────────────────────────────────────

test.describe('the link goes out when the address does', () => {
  test('leaving the email field sends the link, once per address', async ({ page }) => {
    const email = freshEmail('blur');
    await page.goto(fillPath);

    await typeEmailAndLeave(page, email);

    await expect(page.getByTestId('forms-link-sent')).toBeVisible();
    await expect(page.getByTestId('forms-link-sent')).toContainText(email);
    expect(await waitForLinks(email, 1)).toHaveLength(1);

    // A row exists, holding the address and nothing else — no answers, nothing
    // counted, invisible to the cap.
    const rows = await responsesOf(formId!);
    expect(rows).toHaveLength(1);
    expect(rows[0].submission_state).toBe('PENDING_VERIFICATION');
    expect(rows[0].answers).toEqual({});
    expect(rows[0].verified_at).toBeNull();

    // Tabbing back through the same address is NOT a request for another link.
    // Three more visits to the field, and still one mail.
    for (let n = 0; n < 3; n++) {
      await page.getByLabel(EMAIL_LABEL, { exact: true }).click();
      await page.getByLabel(NAME_LABEL, { exact: true }).click();
    }
    await page.waitForTimeout(750);
    expect(linksFor(email)).toHaveLength(1);
  });

  test('correcting the address to a different one sends again', async ({ page }) => {
    const typo = freshEmail('typo');
    const real = freshEmail('real');
    await page.goto(fillPath);

    await typeEmailAndLeave(page, typo);
    await waitForLinks(typo, 1);

    await typeEmailAndLeave(page, real);
    await waitForLinks(real, 1);

    // The typo's row is still there — it is an address somebody typed, and the
    // sweep is what removes it, not the next keystroke.
    const rows = await responsesOf(formId!);
    expect(rows.map(row => row.email).sort()).toEqual([typo, real].sort());
  });

  test('a half-typed address sends nothing at all', async ({ page }) => {
    await page.goto(fillPath);
    await page.getByLabel(EMAIL_LABEL, { exact: true }).fill('maya@');
    await page.getByLabel(NAME_LABEL, { exact: true }).click();
    await page.waitForTimeout(750);

    await expect(page.getByTestId('forms-link-sent')).toHaveCount(0);
    expect(await responsesOf(formId!)).toHaveLength(0);
  });
});

// ─── Clicking the link on the way through ───────────────────────────────────

test.describe('the link, opened before the form is finished', () => {
  test('says the address is verified and sends them back to finish', async ({ page }) => {
    const email = freshEmail('gofinish');
    await page.goto(fillPath);
    await typeEmailAndLeave(page, email);
    const [link] = await waitForLinks(email, 1);

    await page.goto(linkTarget(link));

    await expect(page.getByRole('heading', { name: 'Your email is verified' })).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();
    // NOT a review page. There is no response to review, and rendering an empty
    // answer set as one would tell somebody they had applied when they had not.
    await expect(page.getByRole('button', { name: 'Confirm' })).toHaveCount(0);
    await expect(page.getByTestId('forms-go-finish')).toBeVisible();

    const rows = await responsesOf(formId!);
    expect(rows).toHaveLength(1);
    expect(rows[0].verified_at).not.toBeNull();
    // Verified is not submitted: still nothing recorded.
    expect(rows[0].submission_state).toBe('PENDING_VERIFICATION');

    // Reloading must not burn the link — mail scanners open these before people
    // do, and the reload after that must not be "already used".
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Your email is verified' })).toBeVisible();
  });

  test('and the submit that follows is the last step — no second email', async ({ page }) => {
    const email = freshEmail('oneshot');
    await page.goto(fillPath);
    await typeEmailAndLeave(page, email);
    const [link] = await waitForLinks(email, 1);

    await page.goto(linkTarget(link));
    await page.getByTestId('forms-go-finish').click();

    // Back on the form, and it says so rather than looking like nothing
    // happened.
    await expect(page.getByTestId('forms-verified-here')).toBeVisible();

    await page.getByLabel(EMAIL_LABEL, { exact: true }).fill(email);
    await fillTheRest(page);
    await page.getByRole('button', { name: 'Submit' }).click();

    // Straight to the end. No "check your email" in between.
    await expect(page.getByRole('heading', { name: "You're in" })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toHaveCount(0);

    const rows = await responsesOf(formId!);
    expect(rows).toHaveLength(1);
    expect(rows[0].submission_state).toBe('SUBMITTED');
    expect(rows[0].verified_at).not.toBeNull();
    expect(Object.values(rows[0].answers as Record<string, unknown>)).toContain(
      'Everything, ideally.'
    );

    // THE POINT OF THE WHOLE FEATURE: exactly one mail for the whole journey.
    await page.waitForTimeout(750);
    expect(linksFor(email)).toHaveLength(1);
  });

  test('submitting without ever opening the link still works the old way', async ({ page }) => {
    const email = freshEmail('oldway');
    await page.goto(fillPath);
    await typeEmailAndLeave(page, email);
    await waitForLinks(email, 1);

    await page.getByLabel(EMAIL_LABEL, { exact: true }).fill(email);
    await fillTheRest(page, 'Old Way');
    await page.getByRole('button', { name: 'Submit' }).click();

    // The early send is an optimisation, never a requirement — an unopened link
    // leaves the two-step flow exactly as it was.
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

    const links = await waitForLinks(email, 2);
    await page.goto(linkTarget(links[links.length - 1]));
    await expect(page.getByRole('button', { name: 'Confirm' })).toBeVisible();
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByRole('heading', { name: "You're in" })).toBeVisible();

    const rows = await responsesOf(formId!);
    expect(rows).toHaveLength(1);
    expect(rows[0].submission_state).toBe('SUBMITTED');
  });
});

// ─── The binding ────────────────────────────────────────────────────────────

test.describe('the binding between a verified link and an address', () => {
  /**
   * THE ATTACK THE SHORTCUT COULD HAVE OPENED.
   *
   * The browser holds a credential that says "this address is verified". If the
   * submit believed the browser about WHICH address, anyone could verify a
   * throwaway of their own and then submit under somebody else's name — on a
   * capped waitlist, taking their place.
   *
   * It does not believe the browser. The cookie is resolved to a response row
   * server-side, and that row's address must equal the one being submitted; a
   * different address simply is not bound, and the request falls back to the
   * ordinary check-your-email flow. Asserted through a real browser holding a
   * real cookie, because that is the only way to know the cookie is not being
   * trusted for more than it says.
   */
  test('a verified browser cannot submit under a different address', async ({ page }) => {
    const mine = freshEmail('binder');
    const victim = freshEmail('victim');

    await page.goto(fillPath);
    await typeEmailAndLeave(page, mine);
    const [link] = await waitForLinks(mine, 1);
    await page.goto(linkTarget(link));
    await expect(page.getByRole('heading', { name: 'Your email is verified' })).toBeVisible();

    // The cookie is HttpOnly and form-scoped, so it rides along automatically.
    await page.goto(fillPath);
    await expect(page.getByTestId('forms-verified-here')).toBeVisible();

    await page.getByLabel(EMAIL_LABEL, { exact: true }).fill(victim);
    await fillTheRest(page, 'Not Me');
    await page.getByRole('button', { name: 'Submit' }).click();

    // No shortcut. The victim's address gets the ordinary treatment: a link to
    // their own inbox, and nothing recorded until they click it.
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await expect(page.getByRole('heading', { name: "You're in" })).toHaveCount(0);

    const rows = await responsesOf(formId!);
    const victimRow = rows.find(row => row.email === victim);
    expect(victimRow?.submission_state).toBe('PENDING_VERIFICATION');
    expect(victimRow?.verified_at).toBeNull();
    expect(
      rows.filter(row => row.submission_state === 'SUBMITTED')
    ).toHaveLength(0);
  });

  test('a spent link does not let the same browser submit twice', async ({ page }) => {
    const email = freshEmail('spent');
    await page.goto(fillPath);
    await typeEmailAndLeave(page, email);
    const [link] = await waitForLinks(email, 1);
    await page.goto(linkTarget(link));
    await page.getByTestId('forms-go-finish').click();

    await page.getByLabel(EMAIL_LABEL, { exact: true }).fill(email);
    await fillTheRest(page, 'First Go');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByRole('heading', { name: "You're in" })).toBeVisible();

    // The token is spent and the cookie cleared, so a second pass is an
    // ordinary edit request: a link to the mailbox, not a silent overwrite.
    await page.goto(fillPath);
    await expect(page.getByTestId('forms-verified-here')).toHaveCount(0);
    await page.getByLabel(EMAIL_LABEL, { exact: true }).fill(email);
    await fillTheRest(page, 'Second Go');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

    const rows = await responsesOf(formId!);
    expect(rows).toHaveLength(1);
    // The stored answers are still the confirmed ones — an unconfirmed edit
    // request does not change what is on file.
    expect(Object.values(rows[0].answers as Record<string, unknown>)).toContain('First Go');
  });
});

// ─── The check-email screen's two escape hatches ────────────────────────────

test.describe('resend and wrong-address', () => {
  test('resend sends another link, and is throttled honestly', async ({ page }) => {
    const email = freshEmail('resend');

    /**
     * The fake clock is installed BEFORE the page loads, because Playwright can
     * only control timers it replaced — an interval created by an earlier real
     * render keeps ticking on the real clock. The throttle is client-side by
     * design (a server-side one would answer "how many links has this mailbox
     * had this hour?", which is the oracle the whole flow avoids), so advancing
     * the browser's clock is exactly what waiting does.
     */
    await page.clock.install();
    await page.goto(fillPath);

    await page.getByLabel(NAME_LABEL, { exact: true }).fill('Resender');
    await page.getByLabel(EMAIL_LABEL, { exact: true }).fill(email);
    await page
      .getByRole('radiogroup', { name: SCALE_LABEL })
      .getByRole('radio', { name: '7' })
      .click();
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

    // Two links so far: the blur send when focus left the address, and the
    // submit. Waited for explicitly, so "did the resend send one?" below is a
    // question about the resend and not about log flushing.
    const before = (await waitForLinks(email, 2)).length;

    // Throttled the moment the screen appears, and it SAYS how long — a
    // disabled button with no explanation is the thing people click twice.
    const resend = page.getByTestId('forms-resend');
    await expect(resend).toBeDisabled();
    await expect(resend).toContainText(/Send it again in \d+s/);

    await page.clock.runFor(31_000);

    await expect(resend).toBeEnabled();
    await resend.click();
    await expect(page.getByText('Sent again')).toBeVisible();

    const after = await waitForLinks(email, before + 1);
    expect(after.length).toBe(before + 1);
    // And it is throttled again straight away.
    await expect(page.getByTestId('forms-resend')).toBeDisabled();
  });

  test('wrong address comes back to the form with every answer intact', async ({ page }) => {
    const typo = freshEmail('wrongaddr');
    await page.goto(fillPath);

    await page.getByLabel(NAME_LABEL, { exact: true }).fill('Typo Victim');
    await page.getByLabel(EMAIL_LABEL, { exact: true }).fill(typo);
    await page
      .getByRole('radiogroup', { name: SCALE_LABEL })
      .getByRole('radio', { name: '7' })
      .click();
    await page.getByLabel(LONG_LABEL, { exact: true }).fill('A long answer I do not want to retype.');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

    await page.getByTestId('forms-wrong-address').click();

    // Back on the form, and nothing has been lost — which is the entire point.
    await expect(page.getByLabel(NAME_LABEL, { exact: true })).toHaveValue('Typo Victim');
    await expect(page.getByLabel(LONG_LABEL, { exact: true })).toHaveValue(
      'A long answer I do not want to retype.'
    );
    await expect(page.getByLabel(EMAIL_LABEL, { exact: true })).toHaveValue(typo);

    // Correcting it sends to the new address, and submitting files it there.
    const real = freshEmail('rightaddr');
    await typeEmailAndLeave(page, real);
    await waitForLinks(real, 1);
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await expect(page.getByText(real)).toBeVisible();
  });
});

// ─── The new endpoint is guarded like the old one ───────────────────────────

test.describe('the early send is no softer a door than the submit', () => {
  test('a filled honeypot sends nothing and writes nothing', async ({ page }) => {
    const email = freshEmail('bot');
    await page.goto(fillPath);
    await page.locator('input#website').fill('https://spam.example');
    await typeEmailAndLeave(page, email);

    // Same view a person gets — telling a bot it failed is how it learns to
    // leave the field alone.
    await expect(page.getByTestId('forms-link-sent')).toBeVisible();
    await page.waitForTimeout(750);
    expect(linksFor(email)).toHaveLength(0);
    expect(await responsesOf(formId!)).toHaveLength(0);
  });

  test('a cross-site early send is refused', async ({ page }) => {
    const email = freshEmail('csrf');
    const response = await page.request.post(fillPath, {
      maxRedirects: 0,
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      data: { intent: 'verify-email', identity: { email }, revisionId, trap: '' },
    });

    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(await responsesOf(formId!)).toHaveLength(0);
  });

  test('parameter tampering on the new endpoint is scoped to what it can say', async ({ page }) => {
    const email = freshEmail('tamper');

    // A body carrying everything an attacker might hope the server reads:
    // somebody else's response id, a verified flag, a state, a stolen token,
    // answers. None of it is a field this endpoint has — it takes an address
    // and a revision, and writes a placeholder.
    const response = await page.request.post(fillPath, {
      maxRedirects: 0,
      headers: { 'content-type': 'application/json' },
      data: {
        intent: 'verify-email',
        identity: { email },
        revisionId,
        trap: '',
        responseId: randomUUID(),
        userId: randomUUID(),
        verified: true,
        verified_at: new Date().toISOString(),
        submission_state: 'SUBMITTED',
        token: 'not-a-real-token',
        answers: { anything: 'should not be stored' },
        staff_status: 'on roster',
      },
    });
    expect(response.status()).toBe(200);

    const rows = await responsesOf(formId!);
    expect(rows).toHaveLength(1);
    expect(rows[0].submission_state).toBe('PENDING_VERIFICATION');
    expect(rows[0].verified_at).toBeNull();
    expect(rows[0].user_id).toBeNull();
    expect(rows[0].staff_status).toBeNull();
    // The answers a blur cannot carry: this endpoint stores a placeholder, and
    // the submit is the only thing that fills one in.
    expect(rows[0].answers).toEqual({});
  });

  test('a stale revision is answered with silence, not an interruption', async ({ page }) => {
    const email = freshEmail('stalerev');
    const response = await page.request.post(fillPath, {
      maxRedirects: 0,
      headers: { 'content-type': 'application/json' },
      data: { intent: 'verify-email', identity: { email }, revisionId: randomUUID(), trap: '' },
    });

    // 200, and nothing rendered: somebody mid-form must not be interrupted by a
    // republish they cannot do anything about. The submit will explain it.
    expect(response.status()).toBe(200);
    expect(await responsesOf(formId!)).toHaveLength(0);
    await page.waitForTimeout(250);
    expect(linksFor(email)).toHaveLength(0);
  });

  /**
   * The blur endpoint is now the cheapest way to make this product send mail —
   * no answers to fabricate, just an address and a focus change. It has to be
   * metered by the same budget as the submit, or the per-client ceiling has a
   * door beside it.
   */
  test('a burst of distinct addresses through the blur endpoint is cut off', async ({ page }) => {
    const ip = `e2e-early-${randomUUID()}`;

    const post = (n: number) =>
      page.request.post(fillPath, {
        maxRedirects: 0,
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        data: {
          intent: 'verify-email',
          identity: { email: `zz-e2e-blast-${n}@example.edu`, name: `Victim ${n}` },
          revisionId,
          trap: '',
        },
      });

    for (let n = 0; n < SUBMISSION_RATE_LIMIT; n++) {
      expect((await post(n)).status(), `send ${n}`).toBe(200);
    }
    const refused = await post(SUBMISSION_RATE_LIMIT);
    expect(refused.status()).toBe(429);
    expect(Number(refused.headers()['retry-after'])).toBeGreaterThan(0);

    // The refusal lands before the mailer: no row for the last address.
    const rows = await responsesOf(formId!);
    expect(rows).toHaveLength(SUBMISSION_RATE_LIMIT);
    expect(
      rows.some(row => row.email === `zz-e2e-blast-${SUBMISSION_RATE_LIMIT}@example.edu`)
    ).toBe(false);
  });
});
