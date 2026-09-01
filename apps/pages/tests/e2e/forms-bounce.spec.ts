import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';

import { getClassroomIdBySlug, getTestClassroomSlug, getTestPrisma } from '../helpers';
import { parseFormDefinition } from '@classmoji/services/form-contract';
import { presetByKey } from '../../app/components/forms/presets.ts';

/**
 * "That email bounced" — told to the respondent while they are still here, and
 * to staff long after they have gone.
 *
 * ── What is simulated, and what is real ────────────────────────────────────
 * The webhook's own behaviour — signature, replay, unknown ids, idempotency —
 * is covered against real HMACs in `apps/hook-station/tests/resend.test.ts`.
 * This file starts one step later: the delivery state is written straight onto
 * the token row, exactly as the verified webhook writes it, and everything
 * downstream of that is the real stack — the real cookie, the real polling
 * endpoint, the real page, the real staff drawer.
 *
 * Simulating the write rather than the delivery is not a shortcut around the
 * interesting part; it IS the interesting part. Nobody can make Resend bounce a
 * message on demand inside a test, and the property worth proving here is what
 * this application does once it knows.
 *
 * ── THE ORACLE PROPERTY ────────────────────────────────────────────────────
 * The status endpoint must answer only for the browser's OWN pending
 * verification, and must never become a way to ask "did mail to <address>
 * bounce?". Three of the tests below are about that and nothing else: there is
 * no parameter to carry an address, a browser with no cookie learns nothing,
 * and a cookie naming a send that does not exist is answered exactly as one
 * naming a send in flight.
 */

const CLASS = getTestClassroomSlug();
const FORM_SLUG = 'zz-e2e-bounce';
const fillPath = `/${CLASS}/forms/${FORM_SLUG}`;
const deliveryPath = `${fillPath}/delivery`;

let formId: string | null = null;

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

  const definition = parseFormDefinition(presetByKey('waitlist').fields());

  const form = await prisma.form.create({
    data: {
      classroom_id: classroomId,
      title: 'ZZ E2E Bounce',
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

const freshEmail = (label: string) => `zz-e2e-${label}-${randomUUID().slice(0, 8)}@example.edu`;

async function typeEmailAndLeave(page: Page, email: string) {
  await page.getByLabel(EMAIL_LABEL, { exact: true }).fill(email);
  await page.getByLabel(NAME_LABEL, { exact: true }).click();
}

/** Write the delivery state the verified webhook would have written. */
async function markDelivery(email: string, state: string, detail: string | null = null) {
  const prisma = await getTestPrisma();
  const response = await prisma.formResponse.findFirstOrThrow({
    where: { form_id: formId!, email_normalized: email.toLowerCase() },
    select: { id: true },
  });
  await prisma.formMagicToken.updateMany({
    where: { response_id: response.id },
    data: { delivery_state: state, delivery_detail: detail },
  });
}

test.describe('the respondent is told, while they are still on the form', () => {
  test('the reassuring line is REPLACED by an honest one', async ({ page }) => {
    const email = freshEmail('bounce');
    await page.goto(fillPath);
    await typeEmailAndLeave(page, email);

    // The optimistic line first — this is the state a bounce has to overturn.
    await expect(page.getByTestId('forms-link-sent')).toBeVisible();

    await markDelivery(email, 'BOUNCED', 'The recipient does not exist.');

    const bounced = page.getByTestId('forms-bounced');
    await expect(bounced).toBeVisible({ timeout: 20_000 });
    await expect(bounced).toContainText(email);

    /**
     * Both must not be on screen at once. Telling somebody to go and check an
     * inbox that rejected the message is worse than saying nothing, and an
     * "added" warning rather than a "replaced" one would do exactly that.
     */
    await expect(page.getByTestId('forms-link-sent')).toHaveCount(0);
  });

  test('does not block the form — the address can be fixed and submitted', async ({ page }) => {
    const email = freshEmail('fixable');
    await page.goto(fillPath);
    await typeEmailAndLeave(page, email);
    await expect(page.getByTestId('forms-link-sent')).toBeVisible();

    await markDelivery(email, 'BOUNCED');
    await expect(page.getByTestId('forms-bounced')).toBeVisible({ timeout: 20_000 });

    // Everything they typed is still here, and the form still works.
    const corrected = freshEmail('corrected');
    await page.getByLabel(EMAIL_LABEL, { exact: true }).fill(corrected);
    await page.getByLabel(NAME_LABEL, { exact: true }).fill('Fixed It');
    await page.getByRole('radio', { name: '7', exact: true }).click();
    await page.getByRole('button', { name: 'Submit' }).click();

    await expect(page.getByText('Check your email')).toBeVisible();
  });
});

test.describe('the status endpoint is not a mailbox oracle', () => {
  /**
   * THE CENTRAL PROPERTY.
   *
   * A browser that never triggered a send holds no cookie, and there is no
   * parameter through which one could name an address, a response or a token.
   * The endpoint has exactly one input and the server minted it.
   */
  test('tells a browser with no cookie nothing at all', async ({ page }) => {
    const response = await page.request.get(deliveryPath);
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ state: 'pending' });
  });

  test('cannot be asked about an address, however the question is phrased', async ({ page }) => {
    const email = freshEmail('victim');
    // Cause a real send and a real bounce, so there IS something to find.
    await page.goto(fillPath);
    await typeEmailAndLeave(page, email);
    await expect(page.getByTestId('forms-link-sent')).toBeVisible();
    await markDelivery(email, 'BOUNCED');

    // Now ask from a CLEAN context — no cookie — naming the address every way
    // the endpoint might have been tempted to accept.
    const clean = await page.context().browser()!.newContext();
    try {
      for (const query of [
        `?email=${encodeURIComponent(email)}`,
        `?address=${encodeURIComponent(email)}`,
        `?to=${encodeURIComponent(email)}`,
      ]) {
        const response = await clean.request.get(`${deliveryPath}${query}`);
        expect(await response.json()).toEqual({ state: 'pending' });
      }
    } finally {
      await clean.close();
    }
  });

  /**
   * The substitution that keeps "already responded" from leaking.
   *
   * An address that has already verified is mailed nothing, and the action
   * still sets a watch cookie — carrying an id that names no send. If this
   * endpoint answered differently for that id than for a real one in flight,
   * the whole "every outcome looks the same" property would unravel through a
   * GET. Both must be the identical `pending`.
   */
  test('answers an id that names nothing exactly as it answers one in flight', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    try {
      await context.addCookies([
        {
          name: `forms_watch_${FORM_SLUG}`,
          // A well-formed id that names no send — exactly what the action sets
          // when there was nothing real to point at.
          value: randomUUID(),
          domain: 'localhost',
          path: `/${CLASS}/forms`,
        },
      ]);
      const response = await context.request.get(deliveryPath);
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({ state: 'pending' });
    } finally {
      await context.close();
    }
  });

  test('never reports a DELIVERED message, which would make it an address probe', async ({
    page,
  }) => {
    const email = freshEmail('delivered');
    await page.goto(fillPath);
    await typeEmailAndLeave(page, email);
    await expect(page.getByTestId('forms-link-sent')).toBeVisible();

    await markDelivery(email, 'DELIVERED');

    // Delivered is flattened into `pending` on purpose: if success were
    // reportable, typing an address and watching for it would answer "does this
    // mailbox exist?" for anyone.
    const response = await page.request.get(deliveryPath);
    expect(await response.json()).toEqual({ state: 'pending' });
    await expect(page.getByTestId('forms-bounced')).toHaveCount(0);
  });

  test('reports a bounce to the browser that caused it', async ({ page }) => {
    const email = freshEmail('own');
    await page.goto(fillPath);
    await typeEmailAndLeave(page, email);
    await expect(page.getByTestId('forms-link-sent')).toBeVisible();

    await markDelivery(email, 'BOUNCED');

    const response = await page.request.get(deliveryPath);
    expect(await response.json()).toEqual({ state: 'bounced' });
  });

  test('is never cached', async ({ page }) => {
    const response = await page.request.get(deliveryPath);
    expect(response.headers()['cache-control']).toContain('no-store');
  });

  /**
   * A BUSY SHARED ADDRESS IS NOT LOCKED OUT.
   *
   * The distinct-address ceiling is what bounds self-probing — a sweeper types
   * addresses they are curious about and reads their own bounces, which every
   * cookie check in the world would happily allow. The ceiling's arithmetic is
   * covered as a unit (`tests/unit/forms-submission-rate.spec.ts`), including
   * the refusal and the IPv6 /64 bucketing; it cannot be driven to its limit
   * from here, because the request limiter refuses at 20 per ten minutes long
   * before 50 distinct addresses are reachable.
   *
   * What this covers instead is the failure mode that would actually hurt
   * somebody: an institutional NAT during course-selection week, where many
   * real students share one exit address. That must keep working, and this is
   * the end-to-end proof that it does.
   */
  test('keeps reporting for a busy shared address, as a campus NAT would be', async ({
    page,
    request,
  }) => {
    /**
     * The send is made THROUGH THE FORM, because that is the only path that
     * hands this browser a watch cookie — a scripted document POST does not get
     * one at all, which narrows the oracle rather than widening it.
     *
     * The probing is then done over HTTP, because the budget is per CLIENT and
     * `Fly-Client-IP` is the only attribution the server trusts: a header a
     * browser cannot set on its own navigations. `page.request` shares the
     * browser's cookie jar, so the reads still carry the real cookie.
     */
    /**
     * A FRESH client address per run.
     *
     * The ceiling lives in memory in a dev server that outlives any one test
     * run, and its window is ten minutes — so a fixed address would carry the
     * previous run's sweep into this one and the first assertion would fail
     * against a budget it never spent. The octets come from 203.0.113.0/24,
     * which RFC 5737 reserves for documentation.
     */
    const client = { 'fly-client-ip': `203.0.113.${Math.floor(Math.random() * 200) + 20}` };
    const email = freshEmail('sweeper');

    await page.goto(fillPath);
    await typeEmailAndLeave(page, email);
    await expect(page.getByTestId('forms-link-sent')).toBeVisible();
    await markDelivery(email, 'BOUNCED');

    // Reportable while this client still looks like a person fixing a typo.
    const first = await page.request.get(deliveryPath, { headers: client });
    expect(await first.json()).toEqual({ state: 'bounced' });

    const { current_revision_id: revisionId } = await (
      await getTestPrisma()
    ).form.findUniqueOrThrow({
      where: { id: formId! },
      select: { current_revision_id: true },
    });

    /**
     * A dozen more students on the same exit address, each with their own
     * address — an ordinary lab, not a sweep.
     *
     * Sent from a SEPARATE request context, which is what a different student
     * on a different machine actually is. It also matters mechanically: each
     * send hands its own browser a fresh watch cookie, so issuing these through
     * `page` would overwrite this test's cookie with a classmate's and the
     * final read would be about the wrong send.
     */
    for (let i = 0; i < 12; i += 1) {
      await request.post(fillPath, {
        maxRedirects: 0,
        headers: { ...client, 'content-type': 'application/json' },
        data: {
          intent: 'verify-email',
          identity: { email: `classmate-${i}-${randomUUID().slice(0, 6)}@example.edu` },
          revisionId,
          trap: '',
        },
      });
    }

    /**
     * STILL REPORTING. A ceiling that silenced a lecture hall would have taken
     * the feature away from precisely the busiest legitimate hour this form
     * ever sees, which is the wrong side of the trade — the enhancement
     * degrades for a sweeper, never for a class.
     */
    const after = await page.request.get(deliveryPath, { headers: client });
    expect(await after.json()).toEqual({ state: 'bounced' });
  });
});
