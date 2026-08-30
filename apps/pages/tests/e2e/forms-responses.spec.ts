/**
 * The staff responses surface, over real HTTP.
 *
 * ── What this file is for ──────────────────────────────────────────────────
 * This is the one surface in the forms subtree that serves OTHER PEOPLE'S
 * personal data: names, addresses, and whatever a form asked. Every other test
 * in the suite can afford to describe behaviour; these describe who is allowed
 * to see it. The properties, in order of how badly each would matter:
 *
 *  1. an anonymous request for any responses path is a login redirect, not data;
 *  2. a signed-in STUDENT — who holds a valid session, so no redirect can catch
 *     them — is refused the page, the single-fetch `.data` request, both triage
 *     actions, and the CSV export on both verbs;
 *  3. a student WHO HAS SUBMITTED to the form is refused exactly the same way.
 *     Having a row in the table is not a claim on the table. This is the case
 *     `findOwnResponse` exists for, and the case a self-read route would have
 *     to get right — the responses route has no self-read path at all;
 *  4. an ASSISTANT is refused too: forms compose `requireClassroomStaff`
 *     (OWNER | TEACHER), deliberately not the TA-visible tier;
 *  5. and an OWNER gets the page, uncacheable, with the export intact.
 *
 * Requests go through `page.request` so they share the page's cookie jar, and
 * `maxRedirects: 0` because the redirect target is the WEBAPP, which this
 * harness does not run.
 *
 * The fixture is created and destroyed here. Deleting the form cascades to its
 * revision and its responses, which is what leaves the database as it was
 * found.
 */

import { test, expect } from '@playwright/test';
import { getTestClassroomSlug, getTestPrisma, getClassroomIdBySlug, loginAs } from '../helpers';

const CLASS = getTestClassroomSlug();
const FORM_SLUG = 'zz-e2e-responses';

/** Field ids are what answers key on; fixed here so the assertions can read them. */
const NAME_FIELD = '11111111-1111-4111-8111-111111111111';
const SCALE_FIELD = '22222222-2222-4222-8222-222222222222';

let formId: string | null = null;

const responsesPath = `/${CLASS}/forms/${FORM_SLUG}/responses`;
const exportPath = `${responsesPath}/export`;

test.beforeAll(async () => {
  const prisma = await getTestPrisma();
  const classroomId = await getClassroomIdBySlug(CLASS);

  const owner = await prisma.classroomMembership.findFirst({
    where: { classroom_id: classroomId, role: 'OWNER' },
    select: { user_id: true },
  });
  if (!owner) throw new Error('no OWNER membership — is the dev database seeded?');

  // Left over from an interrupted run: remove it rather than colliding on the
  // (classroom_id, slug) unique index.
  await prisma.form.deleteMany({ where: { classroom_id: classroomId, slug: FORM_SLUG } });

  const form = await prisma.form.create({
    data: {
      classroom_id: classroomId,
      title: 'ZZ E2E Responses',
      slug: FORM_SLUG,
      access: 'PUBLIC',
      status: 'OPEN',
      created_by: owner.user_id,
    },
  });
  formId = form.id;

  const revision = await prisma.formRevision.create({
    data: {
      form_id: form.id,
      version: 1,
      fields: {
        definition_version: 1,
        fields: [
          { id: NAME_FIELD, type: 'short_text', label: 'Full name', required: true },
          {
            id: SCALE_FIELD,
            type: 'opinion_scale',
            label: 'Familiarity',
            required: false,
            scale: { min: 1, max: 10 },
          },
        ],
      },
    },
  });
  await prisma.form.update({
    where: { id: form.id },
    data: { current_revision_id: revision.id },
  });

  // An anonymous applicant, with a formula-shaped name: the export must keep it
  // as text.
  await prisma.formResponse.create({
    data: {
      form_id: form.id,
      revision_id: revision.id,
      email: 'zz-e2e-applicant@example.edu',
      email_normalized: 'zz-e2e-applicant@example.edu',
      name: '=Applicant Zero',
      answers: { [NAME_FIELD]: '=Applicant Zero', [SCALE_FIELD]: 7 },
      submission_state: 'SUBMITTED',
      verified_at: new Date(),
      staff_status: 'Responded to',
      staff_note: 'e2e fixture',
    },
  });

  // One response per student in the classroom, so that whichever account
  // `loginAs(page, 'student')` resolves to has demonstrably submitted.
  const students = await prisma.classroomMembership.findMany({
    where: { classroom_id: classroomId, role: 'STUDENT' },
    select: { user_id: true, user: { select: { email: true, name: true } } },
  });
  for (const student of students) {
    const email = student.user.email ?? `${student.user_id}@example.invalid`;
    await prisma.formResponse.create({
      data: {
        form_id: form.id,
        revision_id: revision.id,
        user_id: student.user_id,
        email,
        email_normalized: email.toLowerCase(),
        name: student.user.name,
        answers: { [NAME_FIELD]: student.user.name ?? 'Student', [SCALE_FIELD]: 4 },
        submission_state: 'SUBMITTED',
        verified_at: new Date(),
      },
    });
  }
});

test.afterAll(async () => {
  if (!formId) return;
  const prisma = await getTestPrisma();
  // Cascades to the revision and every response.
  await prisma.form.delete({ where: { id: formId } }).catch(() => {});
});

test.describe('forms responses — anonymous', () => {
  test('the responses page is a login redirect, not data', async ({ page }) => {
    const response = await page.request.get(responsesPath, { maxRedirects: 0 });
    expect(response.status()).toBe(302);
    expect(response.headers()['location'] ?? '').toContain('redirect=');
    expect(await response.text()).not.toContain('zz-e2e-applicant@example.edu');
  });

  test('the triage action is a login redirect', async ({ page }) => {
    const response = await page.request.post(responsesPath, {
      maxRedirects: 0,
      data: { intent: 'set-status', responseIds: ['whatever'], status: 'pwned' },
    });
    expect(response.status()).toBe(302);
  });

  test('the CSV export is a login redirect on both verbs', async ({ page }) => {
    for (const response of [
      await page.request.get(exportPath, { maxRedirects: 0 }),
      await page.request.post(exportPath, { maxRedirects: 0, form: { kind: 'wide' } }),
    ]) {
      expect(response.status()).toBe(302);
      expect(await response.text()).not.toContain('zz-e2e-applicant');
    }
  });
});

test.describe('forms responses — signed in without staff access', () => {
  test('a STUDENT who has submitted is still refused the page and the .data fetch', async ({
    page,
  }) => {
    await loginAs(page, 'student');

    const document = await page.request.get(responsesPath, { maxRedirects: 0 });
    expect(document.status()).toBe(403);
    expect(await document.text()).not.toContain('zz-e2e-applicant@example.edu');

    // The single-fetch request a client-side navigation would make. A gate that
    // only guarded the document would hand the whole loader payload over here.
    const single = await page.request.get(`${responsesPath}.data`, { maxRedirects: 0 });
    expect(single.status()).toBe(403);
    expect(await single.text()).not.toContain('zz-e2e-applicant@example.edu');
  });

  test('a STUDENT cannot set a staff status or delete a response', async ({ page }) => {
    await loginAs(page, 'student');
    const prisma = await getTestPrisma();
    const target = await prisma.formResponse.findFirst({
      where: { form_id: formId! },
      select: { id: true },
    });

    for (const body of [
      { intent: 'set-status', responseIds: [target!.id], status: 'pwned' },
      { intent: 'set-note', responseIds: [target!.id], note: 'pwned' },
      { intent: 'delete', responseIds: [target!.id] },
    ]) {
      const response = await page.request.post(responsesPath, { maxRedirects: 0, data: body });
      expect(response.status()).toBe(403);
    }

    // Not merely refused: nothing changed, and the row is still there.
    const after = await prisma.formResponse.findUnique({ where: { id: target!.id } });
    expect(after).not.toBeNull();
    expect(after?.staff_status).not.toBe('pwned');
    expect(after?.staff_note).not.toBe('pwned');
  });

  test('a STUDENT cannot export the CSV on either verb', async ({ page }) => {
    await loginAs(page, 'student');
    for (const response of [
      await page.request.get(exportPath, { maxRedirects: 0 }),
      await page.request.post(exportPath, { maxRedirects: 0, form: { kind: 'wide' } }),
    ]) {
      expect(response.status()).toBe(403);
      expect(await response.text()).not.toContain('zz-e2e-applicant');
    }
  });

  test('an ASSISTANT is refused as well', async ({ page }) => {
    // Deliberate: forms compose `requireClassroomStaff` (OWNER | TEACHER), not
    // the teaching-team tier. Applicant PII is not TA-visible by default.
    await loginAs(page, 'ta');
    expect((await page.request.get(responsesPath, { maxRedirects: 0 })).status()).toBe(403);
    expect(
      (await page.request.post(exportPath, { maxRedirects: 0, form: { kind: 'wide' } })).status()
    ).toBe(403);
  });
});

test.describe('forms responses — owner', () => {
  test('gets the page, uncacheable, with the triage columns', async ({ page }) => {
    await loginAs(page, 'owner');
    const response = await page.request.get(responsesPath, { maxRedirects: 0 });
    expect(response.status()).toBe(200);
    // The whole page is other people's personal data; it must never be held by
    // any cache, shared or private.
    expect(response.headers()['cache-control']).toBe('no-store');

    const html = await response.text();
    expect(html).toContain('zz-e2e-applicant@example.edu');
    expect(html).toContain('Responded to');
    // Form-aware columns: the table's headers are the form's own field labels.
    expect(html).toContain('Familiarity');
  });

  test('exports a CSV that keeps a formula-shaped answer as text', async ({ page }) => {
    await loginAs(page, 'owner');
    const response = await page.request.post(exportPath, {
      maxRedirects: 0,
      form: { kind: 'wide' },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/csv');
    expect(response.headers()['content-disposition']).toContain('attachment');
    expect(response.headers()['cache-control']).toBe('no-store');

    const csv = await response.text();
    expect(csv).toContain('Full name');
    expect(csv).toContain('Staff status');
    // The shared text-cell handling, end to end.
    expect(csv).toContain("'=Applicant Zero");
    // A scale carries its range on the HEADER so the column stays averageable;
    // the cell is the bare number.
    expect(csv).toContain('Familiarity (1–10)');
    expect(csv).toMatch(/,7,|,7$|,7\r/);
  });

  test('opens a response in the drawer and renders its answers read-only', async ({ page }) => {
    await loginAs(page, 'owner');
    await page.goto(responsesPath);

    // The tiles are counts per label and nothing else — no status vocabulary is
    // hardcoded anywhere, so this one exists only because the fixture used it.
    await expect(page.getByText('Responded to').first()).toBeVisible();

    await page.getByText('zz-e2e-applicant@example.edu').first().click();

    // The drawer renders the response against the revision it was filled
    // against, through the same FieldShell the builder preview uses.
    const drawer = page.getByRole('dialog', { name: 'Response details' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText('Staff only — never shown to the respondent')).toBeVisible();
    await expect(drawer.getByText('Full name')).toBeVisible();
    await expect(drawer.getByText('7 / 10')).toBeVisible();
    // Read-only: the drawer renders answers, never inputs for them.
    await expect(drawer.locator('input[type="text"], textarea, select')).toHaveCount(0);
  });

  test('inline status editing writes through and suggests labels already in use', async ({
    page,
  }) => {
    await loginAs(page, 'owner');
    await page.goto(responsesPath);

    const prisma = await getTestPrisma();
    const target = await prisma.formResponse.findFirst({
      where: { form_id: formId!, staff_status: null },
      select: { id: true, email: true },
    });
    expect(target).not.toBeNull();

    const row = page.locator('tr', { hasText: target!.email });
    await row.getByRole('button', { name: 'Set a status' }).click();

    // The suggestion list is drawn from the labels already used ON THIS FORM —
    // there is no status enum anywhere in the stack for it to come from.
    const suggestion = page.locator('[data-status-suggestion="Responded to"]');
    await expect(suggestion).toBeVisible();
    await suggestion.click();

    await expect(
      row.getByRole('button', { name: 'Status: Responded to. Change it.' })
    ).toBeVisible();
    const after = await prisma.formResponse.findUnique({ where: { id: target!.id } });
    expect(after?.staff_status).toBe('Responded to');
  });

  test('the export honours a selection', async ({ page }) => {
    await loginAs(page, 'owner');
    const prisma = await getTestPrisma();
    const only = await prisma.formResponse.findFirst({
      where: { form_id: formId!, name: '=Applicant Zero' },
      select: { id: true },
    });

    const response = await page.request.post(exportPath, {
      maxRedirects: 0,
      form: { kind: 'wide', responseId: only!.id },
    });
    const csv = await response.text();
    // Header + exactly one body row.
    expect(csv.trim().split('\r\n')).toHaveLength(2);
    expect(csv).toContain('zz-e2e-applicant@example.edu');
  });
});
