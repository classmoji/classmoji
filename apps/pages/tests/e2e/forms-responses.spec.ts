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
 *  5. and an OWNER gets the page, uncacheable, with the export intact;
 *  6. answers to an IDENTITY QUESTION are withheld from the owner too: absent
 *     from the HTML, the `.data` payload, the table, the search and the CSV,
 *     always. The drawer shows them for its one response when asked, and each
 *     such request writes one audit row naming that response. A response name
 *     that is one of those answers is not shown as the name.
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
/**
 * The fixture asks for an address as a QUESTION, the way a public form has to:
 * the magic link is its entire authentication, so `identityPlan` reads the
 * response's email out of this answer. Together with "Full name" that makes this
 * the waitlist shape — the one whose table used to print both twice.
 */
const EMAIL_FIELD = '33333333-3333-4333-8333-333333333333';
/**
 * An identity question. A short text on purpose: its answer is free text that
 * appears nowhere but in the response, so "not in the HTML" is a real claim. A
 * dropdown's option label also sits in the field definitions the page ships,
 * whether or not anybody's answer is shown. The label avoids "name", which
 * `identityPlan` would lift into the response's Name column.
 */
const IDENTITY_FIELD = '55555555-5555-4555-8555-555555555555';
const IDENTITY_LABEL = 'Self-description';
const IDENTITY_ANSWER = 'zz-e2e-identity-answer';

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
          { id: EMAIL_FIELD, type: 'email', label: 'School email', required: true },
          {
            id: SCALE_FIELD,
            type: 'opinion_scale',
            label: 'Familiarity',
            required: false,
            scale: { min: 1, max: 10 },
          },
          {
            id: IDENTITY_FIELD,
            type: 'short_text',
            label: IDENTITY_LABEL,
            required: false,
            identity_question: true,
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
      answers: {
        [NAME_FIELD]: '=Applicant Zero',
        [EMAIL_FIELD]: 'zz-e2e-applicant@example.edu',
        [SCALE_FIELD]: 7,
        [IDENTITY_FIELD]: IDENTITY_ANSWER,
      },
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
        answers: {
          [NAME_FIELD]: student.user.name ?? 'Student',
          [EMAIL_FIELD]: email,
          [SCALE_FIELD]: 4,
        },
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

    // Asking for identity answers changes nothing: the gate runs first.
    const asked = await page.request.get(`${responsesPath}.data?identity=shown`, {
      maxRedirects: 0,
    });
    expect(asked.status()).toBe(403);
    expect(await asked.text()).not.toContain(IDENTITY_ANSWER);
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
      { intent: 'reveal-identity', responseId: target!.id },
    ]) {
      const response = await page.request.post(responsesPath, { maxRedirects: 0, data: body });
      expect(response.status()).toBe(403);
      expect(await response.text()).not.toContain(IDENTITY_ANSWER);
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

    // Asking for one response's identity answers is refused the same way, and
    // discloses nothing: no answer in the body, no reveal row in the log.
    const prisma = await getTestPrisma();
    const target = await prisma.formResponse.findFirst({
      where: { form_id: formId!, answers: { path: [IDENTITY_FIELD], equals: IDENTITY_ANSWER } },
      select: { id: true },
    });
    expect(target, 'a response with an identity answer').not.toBeNull();
    const reveals = () =>
      prisma.auditLog.count({
        where: {
          resource_type: 'FORMS',
          resource_id: target!.id,
          data: { path: ['identity_answers'], equals: true },
        },
      });
    const before = await reveals();
    const reveal = await page.request.post(responsesPath, {
      maxRedirects: 0,
      data: { intent: 'reveal-identity', responseId: target!.id },
    });
    expect(reveal.status()).toBe(403);
    expect(await reveal.text()).not.toContain(IDENTITY_ANSWER);
    expect(await reveals()).toBe(before);
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
    // Never exported: no identity column, no answer.
    expect(csv).not.toContain(IDENTITY_LABEL);
    expect(csv).not.toContain(IDENTITY_ANSWER);
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

  /**
   * ── "Unverified" is three different situations wearing one chip ──────────
   *
   * Somebody who has not got round to clicking, somebody whose mail bounced,
   * and somebody whose mail NEVER LEFT US all show as Unverified, and a course
   * would chase all three the same way. The third is the one this row exists
   * for: the address may be perfectly good, the person is waiting for something
   * that was never sent, and telling an instructor to go and check their email
   * address would send them after a mistake nobody made.
   *
   * Its own words, therefore — "Not sent" on the row, and the reason the
   * dispatch gave in the drawer — rather than being folded into "Bounced".
   */
  test('a response whose verification mail never went out says so, in its own words', async ({
    page,
  }) => {
    const prisma = await getTestPrisma();
    const revision = await prisma.formRevision.findFirstOrThrow({
      where: { form_id: formId! },
      select: { id: true },
    });

    const email = 'zz-e2e-neversent@example.edu';
    const response = await prisma.formResponse.create({
      data: {
        form_id: formId!,
        revision_id: revision.id,
        email,
        email_normalized: email,
        name: 'Never Sent',
        answers: { [NAME_FIELD]: 'Never Sent', [SCALE_FIELD]: 3 },
        submission_state: 'PENDING_VERIFICATION',
        submitted_at: new Date(),
      },
    });
    await prisma.formMagicToken.create({
      data: {
        response_id: response.id,
        token_hash: `zz-e2e-neversent-${response.id}`,
        expires_at: new Date(Date.now() + 3_600_000),
        delivery_state: 'FAILED',
        delivery_detail: 'Resend send failed: Template not found',
      },
    });

    try {
      await loginAs(page, 'owner');
      await page.goto(responsesPath);

      const chip = page.getByTestId(`forms-bounce-chip-${response.id}`);
      await expect(chip).toBeVisible();
      // NOT "Bounced" — the address was never tried.
      await expect(chip).toHaveText('Not sent');

      await page.getByText(email).first().click();
      const drawer = page.getByRole('dialog', { name: 'Response details' });
      const delivery = drawer.getByTestId('forms-response-delivery');
      await expect(delivery).toContainText('Never sent');
      // The reason, for whoever has to work out why.
      await expect(delivery).toContainText('Template not found');
    } finally {
      await prisma.formResponse.delete({ where: { id: response.id } }).catch(() => {});
    }
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

  test('the answer columns do not repeat the identity columns', async ({ page }) => {
    await loginAs(page, 'owner');
    await page.goto(responsesPath);

    // A public form asks for a name and an address as QUESTIONS, and the
    // response's Name and Email are lifted out of those two answers. Showing
    // them again as answer columns printed the same data twice and is most of
    // why this table outgrew its container.
    // `allInnerTexts` reports the RENDERED text, which this header row
    // uppercases in CSS — hence the comparison in upper case.
    const headings = (await page.locator('table thead th').allInnerTexts()).map(heading =>
      heading.trim()
    );

    // The whole header row, exactly: the two identity columns, the form's one
    // remaining question, and the triage columns. Asserting the WHOLE list
    // rather than a couple of absences is what would catch a future duplicate
    // arriving under a label nobody thought to exclude.
    expect(headings).toEqual([
      '',
      'NAME',
      'EMAIL',
      'FAMILIARITY',
      'SUBMITTED',
      'STATUS',
      'NOTE',
      '',
    ]);
    expect(headings).not.toContain('FULL NAME');
    expect(headings).not.toContain('SCHOOL EMAIL');

    // Not merely absent from the header — the address appears once per row, in
    // the Email column, rather than in two cells of the same row.
    const applicantRow = page.locator('tr', { hasText: 'zz-e2e-applicant@example.edu' });
    await expect(
      applicantRow.locator('td', { hasText: 'zz-e2e-applicant@example.edu' })
    ).toHaveCount(1);
  });

  test('the status suggestions escape the table’s scroll container on the last row', async ({
    page,
  }) => {
    await loginAs(page, 'owner');
    // Short on purpose: the last row sits near the bottom edge, which is the
    // case in the bug report — the list had nowhere to go and was sliced off by
    // the table's own `overflow-x-auto` (a scroll container clips in BOTH axes).
    await page.setViewportSize({ width: 1024, height: 560 });
    await page.goto(responsesPath);

    const lastRow = page.locator('tbody tr').last();
    await lastRow.getByRole('button', { name: /^(Set a status|Status: )/ }).click();

    const popover = page.locator('[data-status-suggestions]');
    await expect(popover).toBeVisible();

    const escaped = await popover.evaluate(node => {
      const rect = node.getBoundingClientRect();
      return {
        // Portalled out of the clipping ancestor entirely, not merely painted
        // above it — `z-index` orders painting; this is clipping.
        insideScrollContainer: Boolean(node.closest('.overflow-x-auto')),
        fullyVisible:
          rect.top >= 0 &&
          rect.left >= 0 &&
          rect.bottom <= window.innerHeight &&
          rect.right <= window.innerWidth,
        height: rect.height,
      };
    });
    expect(escaped.insideScrollContainer).toBe(false);
    expect(escaped.fullyVisible).toBe(true);
    expect(escaped.height).toBeGreaterThan(0);

    // And still commits: a portal that could not be clicked through would be a
    // different bug wearing the same screenshot.
    const suggestion = page.locator('[data-status-suggestion="Responded to"]');
    await expect(suggestion).toBeVisible();
    await suggestion.click();
    await expect(
      lastRow.getByRole('button', { name: 'Status: Responded to. Change it.' })
    ).toBeVisible();
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

  test('two different exports in quick succession are two audit rows; the same one twice is one', async ({
    page,
  }) => {
    await loginAs(page, 'owner');
    const prisma = await getTestPrisma();
    const [a, b] = await prisma.formResponse.findMany({
      where: { form_id: formId!, name: { not: '=Applicant Zero' } },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 2,
    });
    expect(b, 'two responses to select').toBeDefined();
    // Selections no other test exports, so no earlier row inside the audit
    // window can stand in for these.
    const exportOf = (kind: string, ids: string[]) =>
      page.request.post(exportPath, {
        maxRedirects: 0,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        data: new URLSearchParams([
          ['kind', kind],
          ...ids.map(id => ['responseId', id]),
        ]).toString(),
      });
    const since = new Date();

    for (const [kind, ids] of [
      ['wide', [a!.id, b!.id]],
      ['wide', [b!.id]],
      ['long', [a!.id, b!.id]],
      ['wide', [b!.id, a!.id]],
    ] as const) {
      const response = await exportOf(kind, [...ids]);
      expect(response.status()).toBe(200);
    }

    const rows = await prisma.auditLog.findMany({
      where: {
        resource_type: 'FORMS',
        action: 'VIEW',
        timestamp: { gte: since },
        AND: [
          { data: { path: ['form_id'], equals: formId! } },
          { data: { path: ['tool'], equals: 'forms.responses.export' } },
        ],
      },
      select: { data: true },
      orderBy: { timestamp: 'asc' },
    });
    const values = rows.map(row => (row.data as { value?: unknown }).value as string);
    // The fourth export is the first again (same sheet, same responses): one row.
    expect(values).toHaveLength(3);
    expect(values[0]).toMatch(/^wide:[0-9a-f]{12}$/);
    expect(values[1]).toMatch(/^wide:[0-9a-f]{12}$/);
    expect(values[1]).not.toBe(values[0]);
    expect(values[2]).toBe(values[0].replace(/^wide:/, 'long:'));
    // The value names what was covered, never a response.
    expect(JSON.stringify(values)).not.toContain(a!.id);
    expect(JSON.stringify(values)).not.toContain(b!.id);
  });
});

test.describe('forms responses — identity questions', () => {
  /** This form's VIEW audit rows since `since` that disclosed identity answers. */
  const disclosures = async (since: Date, tool: string) => {
    const prisma = await getTestPrisma();
    return prisma.auditLog.findMany({
      where: {
        resource_type: 'FORMS',
        action: 'VIEW',
        timestamp: { gte: since },
        AND: [
          { data: { path: ['form_id'], equals: formId! } },
          { data: { path: ['tool'], equals: tool } },
          { data: { path: ['identity_answers'], equals: true } },
        ],
      },
      select: { resource_id: true, data: true },
      orderBy: { timestamp: 'asc' },
    });
  };

  const applicantId = async () => {
    const prisma = await getTestPrisma();
    const row = await prisma.formResponse.findFirstOrThrow({
      where: { form_id: formId!, email: 'zz-e2e-applicant@example.edu' },
      select: { id: true },
    });
    return row.id;
  };

  test('the Edit · Responses switcher marks Responses as the current page', async ({ page }) => {
    await loginAs(page, 'owner');
    await page.goto(responsesPath);

    const nav = page.getByRole('navigation', { name: 'Form' });
    const current = nav.locator('a[aria-current="page"]');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveAttribute('href', responsesPath);
    await expect(current).toContainText('Responses');
    await expect(nav.getByRole('link', { name: 'Edit' })).toHaveAttribute(
      'href',
      `/${CLASS}/forms/${FORM_SLUG}/edit`
    );
    // A PUBLIC form's respondents are on no roster, so it has no Teams tab.
    await expect(nav.getByRole('link', { name: 'Teams' })).toHaveCount(0);
  });

  test('hidden: not in the HTML, the .data payload, the table or the drawer', async ({ page }) => {
    await loginAs(page, 'owner');
    const since = new Date();

    // The raw responses, not the rendered page: a value stripped on the server
    // is absent from the hydration payload too. The old page-wide parameter
    // changes nothing.
    for (const path of [
      responsesPath,
      `${responsesPath}.data`,
      `${responsesPath}?identity=shown`,
      `${responsesPath}.data?identity=shown`,
    ]) {
      const response = await page.request.get(path, { maxRedirects: 0 });
      expect(response.status(), path).toBe(200);
      expect(await response.text(), path).not.toContain(IDENTITY_ANSWER);
    }

    await page.goto(responsesPath);
    // Nothing on the page reveals them for every response at once.
    await expect(page.getByText('Show identity answers')).toHaveCount(0);
    // Not a column either: the header row is exactly what it was without it.
    const headings = (await page.locator('table thead th').allInnerTexts()).map(heading =>
      heading.trim()
    );
    expect(headings).not.toContain(IDENTITY_LABEL.toUpperCase());

    await page.getByText('zz-e2e-applicant@example.edu').first().click();
    const drawer = page.getByRole('dialog', { name: 'Response details' });
    await expect(drawer.getByText(IDENTITY_LABEL)).toBeVisible();
    // "Hidden", not "No answer": it says nothing about whether it was answered.
    await expect(drawer.getByTestId('forms-answer-hidden')).toHaveText('Hidden');
    await expect(drawer.getByTestId('forms-identity-reveal')).toHaveText('Show identity answers');
    expect(await page.content()).not.toContain(IDENTITY_ANSWER);

    // The export form carries no request for them.
    await expect(page.locator('form input[name="identity"]')).toHaveCount(0);

    expect(await disclosures(since, 'forms.responses.view')).toHaveLength(0);
  });

  test('shown for the one response in the drawer, on request, and audited with its id', async ({
    page,
  }) => {
    await loginAs(page, 'owner');
    const responseId = await applicantId();

    await page.goto(responsesPath);
    await page.getByText('zz-e2e-applicant@example.edu').first().click();
    const drawer = page.getByRole('dialog', { name: 'Response details' });

    // A reveal changes no data, so this route's loader does not run again (the
    // root's may: single fetch names the routes it reloads in `_routes`).
    const reloads: string[] = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (request.method() !== 'GET' || !url.pathname.endsWith('/responses.data')) return;
      const routes = url.searchParams.get('_routes');
      if (routes === null || routes.split(',').includes('forms/admin/responses')) {
        reloads.push(url.href);
      }
    });

    const since = new Date();
    const [revealResponse] = await Promise.all([
      page.waitForResponse(
        response =>
          response.request().method() === 'POST' && response.url().includes('/responses.data')
      ),
      drawer.getByTestId('forms-identity-reveal').click(),
    ]);
    expect(revealResponse.status()).toBe(200);
    expect(revealResponse.headers()['cache-control']).toBe('no-store');

    await expect(drawer.getByText(IDENTITY_ANSWER)).toBeVisible();
    await expect(drawer.getByTestId('forms-answer-hidden')).toHaveCount(0);
    await expect(drawer.getByTestId('forms-identity-reveal')).toHaveText('Hide identity answers');

    // Revealed answers belong to one response, never to a column beside all.
    await expect(page.locator('table')).not.toContainText(IDENTITY_ANSWER);
    // The export still carries no request for them.
    await expect(page.locator('form input[name="identity"]')).toHaveCount(0);

    const rows = await disclosures(since, 'forms.responses.view');
    expect(rows).toHaveLength(1);
    expect(rows[0].resource_id).toBe(responseId);
    expect(rows[0].data).toMatchObject({
      value: responseId,
      response_id: responseId,
      identity_field_ids: [IDENTITY_FIELD],
    });
    expect(reloads).toEqual([]);

    // Hide, then close: gone from the page.
    await drawer.getByTestId('forms-identity-reveal').click();
    await expect(drawer.getByTestId('forms-answer-hidden')).toHaveText('Hidden');
    await drawer.getByRole('button', { name: 'Close the response' }).click();
    expect(await page.content()).not.toContain(IDENTITY_ANSWER);
  });

  test('reveals of two responses in quick succession are two audit rows', async ({ page }) => {
    await loginAs(page, 'owner');
    const prisma = await getTestPrisma();
    // Two responses no other test here reveals: a second reveal of the SAME
    // response inside the audit window is one row, by design.
    const pair = await prisma.formResponse.findMany({
      where: { form_id: formId!, user_id: { not: null } },
      select: { id: true, email: true },
      orderBy: { submitted_at: 'asc' },
      take: 2,
    });
    expect(pair, 'the fixture needs two student responses').toHaveLength(2);
    const [first, second] = pair;

    await page.goto(responsesPath);
    const since = new Date();
    for (const email of [first.email, second.email]) {
      await page.getByText(email).first().click();
      const drawer = page.getByRole('dialog', { name: 'Response details' });
      await drawer.getByTestId('forms-identity-reveal').click();
      await expect(drawer.getByTestId('forms-identity-reveal')).toHaveText('Hide identity answers');
      await drawer.getByRole('button', { name: 'Close the response' }).click();
    }

    const rows = await disclosures(since, 'forms.responses.view');
    expect(rows.map(row => (row.data as { value?: string }).value)).toEqual([first.id, second.id]);
    expect(rows.map(row => row.resource_id)).toEqual([first.id, second.id]);
  });

  test('the export never carries them, whatever the request says', async ({ page }) => {
    await loginAs(page, 'owner');
    const since = new Date();

    const posts: Array<Record<string, string>> = [
      { kind: 'wide' },
      { kind: 'wide', identity: 'shown' },
    ];
    for (const form of posts) {
      const response = await page.request.post(exportPath, { maxRedirects: 0, form });
      expect(response.status()).toBe(200);
      const csv = await response.text();
      expect(csv).not.toContain(IDENTITY_LABEL);
      expect(csv).not.toContain(IDENTITY_ANSWER);
    }

    expect(await disclosures(since, 'forms.responses.export')).toHaveLength(0);
  });

  /**
   * A public fill copies a short-text "name" answer into the response's name.
   * A response stored before that question was flagged keeps the answer there;
   * the name that equals a hidden answer is not shown as the name.
   */
  test('a name that is an identity answer is not shown, searched or exported', async ({ page }) => {
    const LIFTED = 'zz-e2e-lifted-name';
    const email = 'zz-e2e-lifted@example.edu';
    const prisma = await getTestPrisma();
    const revision = await prisma.formRevision.findFirstOrThrow({
      where: { form_id: formId! },
      select: { id: true },
    });
    const response = await prisma.formResponse.create({
      data: {
        form_id: formId!,
        revision_id: revision.id,
        email,
        email_normalized: email,
        name: LIFTED,
        answers: { [EMAIL_FIELD]: email, [IDENTITY_FIELD]: LIFTED },
        submission_state: 'SUBMITTED',
        verified_at: new Date(),
      },
    });

    try {
      await loginAs(page, 'owner');
      for (const path of [responsesPath, `${responsesPath}.data`]) {
        const body = await (await page.request.get(path, { maxRedirects: 0 })).text();
        expect(body, path).toContain(email);
        expect(body, path).not.toContain(LIFTED);
      }

      await page.goto(responsesPath);
      const row = page.locator('tbody tr', { hasText: email });
      await expect(row).toHaveCount(1);
      await expect(row.locator('td').nth(1)).toHaveText('—');

      const search = page.getByLabel('Search responses by name or email');
      await search.fill(LIFTED);
      await expect(page.getByText(`No responses match “${LIFTED}”.`)).toBeVisible();
      await search.fill('zz-e2e-lifted@');
      await expect(row).toHaveCount(1);

      const csv = await (
        await page.request.post(exportPath, { maxRedirects: 0, form: { kind: 'wide' } })
      ).text();
      expect(csv).toContain(email);
      expect(csv).not.toContain(LIFTED);
    } finally {
      await prisma.formResponse.delete({ where: { id: response.id } }).catch(() => {});
    }
  });
});
