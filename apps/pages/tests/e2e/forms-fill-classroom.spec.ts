import { test, expect, type Page } from '@playwright/test';
import { parseFormDefinition, type FormField } from '@classmoji/services/form-contract';

import {
  getClassroomIdBySlug,
  getTestClassroomSlug,
  getTestPrisma,
  getTestServices,
  loginAs,
  logout,
} from '../helpers';

/**
 * The CLASSROOM fill surface — Mockup 4, over real HTTP, with real sessions.
 *
 * ── What this file is for ──────────────────────────────────────────────────
 * The public path's whole security story is the magic link. This path's whole
 * security story is the SESSION, and the properties that makes load-bearing are
 * different ones:
 *
 *  1. anonymous gets an interstitial and a signed-in stranger gets told which
 *     account they used — neither gets the form;
 *  2. a member fills it, including the two field types that only exist here:
 *     `roster_select` over options materialized at publish, and `ranked_choice`;
 *  3. the draft is on the SERVER, so it survives a reload rather than a
 *     browser;
 *  4. a second submit REPLACES the row, it does not add one;
 *  5. ISOLATION. A member can load their own response and no one else's, and
 *     there is no parameter — a response id, a user id, anything — that changes
 *     which row a request touches. This is the point of the file.
 *
 * ── The fixtures ───────────────────────────────────────────────────────────
 * Published through `form.service.publish`, not hand-written into the revision
 * table, because publish is where roster options are materialized: a fixture
 * that wrote its own revision would be testing a form no instructor can create,
 * and the roster options would be whatever the fixture invented.
 *
 * Everything is namespaced `zz-e2e-classroom*` and deleted in afterAll (which
 * cascades to revisions, responses, and tokens). The demo form in this
 * classroom is not touched.
 */

const CLASS = getTestClassroomSlug();
/** A second seeded classroom, used for the signed-in-but-not-a-member state. */
const OTHER_CLASS = 'classmoji-other-class';

const MULTI_SLUG = 'zz-e2e-classroom';
const SINGLE_SLUG = 'zz-e2e-classroom-once';
const CAPPED_SLUG = 'zz-e2e-classroom-capped';
const OTHER_SLUG = 'zz-e2e-classroom-elsewhere';

const multiPath = `/${CLASS}/forms/${MULTI_SLUG}`;
const singlePath = `/${CLASS}/forms/${SINGLE_SLUG}`;
const cappedPath = `/${CLASS}/forms/${CAPPED_SLUG}`;
const otherPath = `/${OTHER_CLASS}/forms/${OTHER_SLUG}`;

/** Fixed field ids, so stored answers can be read back by name. */
const F = {
  name: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01',
  email: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb02',
  partner: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb03',
  crew: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb04',
  ranked: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb05',
  note: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb06',
} as const;

const IDEA = {
  copilot: 'cccccccc-cccc-4ccc-8ccc-cccccccccc01',
  trails: 'cccccccc-cccc-4ccc-8ccc-cccccccccc02',
  ledger: 'cccccccc-cccc-4ccc-8ccc-cccccccccc03',
} as const;

let multiFormId: string | null = null;
let singleFormId: string | null = null;
let cappedFormId: string | null = null;
let otherFormId: string | null = null;
let multiRevisionId = '';
/** The roster options publish froze into the fixture — labels and user ids. */
let rosterOptions: Array<{ id: string; label: string }> = [];

/**
 * The field list of the resubmittable fixture.
 *
 * It deliberately CONTAINS a name and an email question. Those are the ones the
 * classroom path answers from the session and removes from the page, and a
 * fixture without them would never exercise that rule.
 */
const multiFields = [
  { id: F.name, type: 'short_text', label: 'Name', required: true },
  { id: F.email, type: 'email', label: 'School email', required: true },
  {
    id: F.partner,
    type: 'roster_select',
    label: 'Your partner',
    optionSource: 'roster',
    multiple: false,
  },
  {
    id: F.crew,
    type: 'roster_select',
    label: 'People you would like to work with',
    optionSource: 'roster',
    multiple: true,
  },
  {
    id: F.ranked,
    type: 'ranked_choice',
    label: 'Rank your project choices',
    required: true,
    ranks: 2,
    options: [
      { id: IDEA.copilot, label: 'Course Copilot' },
      { id: IDEA.trails, label: 'Trail Conditions App' },
      { id: IDEA.ledger, label: 'Lab Ledger' },
    ],
  },
  { id: F.note, type: 'long_text', label: 'Anything else?' },
];

// ─── Fixtures ───────────────────────────────────────────────────────────────

async function ownerOf(classroomId: string): Promise<string> {
  const prisma = await getTestPrisma();
  const owner = await prisma.classroomMembership.findFirst({
    where: { classroom_id: classroomId, role: 'OWNER' },
    select: { user_id: true },
  });
  if (!owner) throw new Error(`no OWNER membership in ${classroomId} — is the dev DB seeded?`);
  return owner.user_id;
}

/**
 * A published CLASSROOM form. Published through the SERVICE: that is the only
 * code path that materializes roster options into the revision, and it is half
 * of what this file exists to check.
 */
async function makeForm({
  classroomId,
  slug,
  title,
  fields,
  allowMultiple,
  responseCap = null,
}: {
  classroomId: string;
  slug: string;
  title: string;
  fields: unknown[];
  allowMultiple: boolean;
  responseCap?: number | null;
}) {
  const prisma = await getTestPrisma();
  const services = await getTestServices();

  const form = await prisma.form.create({
    data: {
      classroom_id: classroomId,
      title,
      slug,
      access: 'CLASSROOM',
      status: 'DRAFT',
      allow_multiple: allowMultiple,
      response_cap: responseCap,
      created_by: await ownerOf(classroomId),
      draft_fields: parseFormDefinition(fields) as never,
    },
  });

  const { revision } = await services.form.publish(form.id);
  return { formId: form.id, revisionId: revision.id, revision };
}

test.beforeAll(async () => {
  const prisma = await getTestPrisma();
  const classroomId = await getClassroomIdBySlug(CLASS);
  const otherClassroomId = await getClassroomIdBySlug(OTHER_CLASS);

  // Left over from an interrupted run.
  await prisma.form.deleteMany({
    where: {
      OR: [
        { classroom_id: classroomId, slug: { in: [MULTI_SLUG, SINGLE_SLUG, CAPPED_SLUG] } },
        { classroom_id: otherClassroomId, slug: OTHER_SLUG },
      ],
    },
  });

  const multi = await makeForm({
    classroomId,
    slug: MULTI_SLUG,
    title: 'ZZ E2E Team Bidding',
    fields: multiFields,
    allowMultiple: true,
  });
  multiFormId = multi.formId;
  multiRevisionId = multi.revisionId;

  const services = await getTestServices();
  const published = services.form.fieldsOf(multi.revision.fields) as FormField[];
  rosterOptions = (published.find(field => field.id === F.partner)?.options ?? []) as Array<{
    id: string;
    label: string;
  }>;
  if (rosterOptions.length < 2) {
    throw new Error(
      `expected the ${CLASS} roster to materialize at least 2 options, got ${rosterOptions.length}`
    );
  }

  const single = await makeForm({
    classroomId,
    slug: SINGLE_SLUG,
    title: 'ZZ E2E One Response Only',
    fields: [{ type: 'long_text', label: 'Anything else?', required: true }],
    allowMultiple: false,
  });
  singleFormId = single.formId;

  const capped = await makeForm({
    classroomId,
    slug: CAPPED_SLUG,
    title: 'ZZ E2E One Seat Left',
    fields: [{ type: 'long_text', label: 'Anything else?', required: true }],
    allowMultiple: true,
    responseCap: 1,
  });
  cappedFormId = capped.formId;

  const elsewhere = await makeForm({
    classroomId: otherClassroomId,
    slug: OTHER_SLUG,
    title: 'ZZ E2E Not Your Course',
    fields: [{ type: 'long_text', label: 'Anything else?' }],
    allowMultiple: true,
  });
  otherFormId = elsewhere.formId;
});

test.afterAll(async () => {
  const prisma = await getTestPrisma();
  for (const id of [multiFormId, singleFormId, cappedFormId, otherFormId]) {
    if (id) await prisma.form.delete({ where: { id } }).catch(() => {});
  }
});

test.beforeEach(async ({ page }) => {
  const prisma = await getTestPrisma();
  for (const id of [multiFormId, singleFormId, cappedFormId, otherFormId]) {
    if (id) await prisma.formResponse.deleteMany({ where: { form_id: id } });
  }
  await logout(page);
});

/** Every response to a fixture form, through the service the staff page uses. */
async function responsesOf(id: string) {
  const services = await getTestServices();
  return services.formResponse.listByFormId(id);
}

/**
 * Open a fill page and wait until it is actually a form.
 *
 * The server-rendered markup is indistinguishable from the hydrated page, and
 * it is not interactive: a `<select>` set before React's first controlled
 * render is reset by it, and a click on a roster name does nothing. Every test
 * here that types into the form goes through this rather than racing the
 * bundle — the flake it removes looked exactly like a product bug (an answer
 * chosen and then silently un-chosen).
 */
async function openFill(page: Page, path: string) {
  await page.goto(path);
  // `data-hydrated="false"` is in the server-rendered HTML, so this locator is
  // present the moment the document is — which is what lets the pages that are
  // NOT a form (an interstitial, a closed notice, a read-only recorded
  // response) pass straight through instead of waiting for something that will
  // never appear.
  if ((await page.locator('form[data-hydrated]').count()) > 0) {
    await expect(page.locator('form[data-hydrated="true"]')).toBeVisible();
  }
}

/**
 * Pick a person out of a `roster_select`.
 *
 * Scoped to the FIELD, not to the page: both roster fields on this fixture
 * offer the same people, so a page-wide "click Dev Student 2" matches twice.
 */
async function pickFromRoster(page: Page, fieldId: string, personLabel: string) {
  const control = page.getByTestId(`roster-${fieldId}`);
  await control.getByRole('combobox').fill(personLabel.split(' (')[0]);
  await control.getByRole('button', { name: personLabel, exact: true }).click();
}

/** Fill everything the resubmittable fixture requires. */
async function fillBidding(page: Page, note: string) {
  await pickFromRoster(page, F.partner, rosterOptions[0].label);
  await pickFromRoster(page, F.crew, rosterOptions[1].label);
  await page.getByLabel('Choice 1').selectOption({ label: 'Course Copilot' });
  await page.getByLabel('Choice 2').selectOption({ label: 'Trail Conditions App' });
  await page.getByLabel('Anything else?', { exact: true }).fill(note);
}

/** A complete, valid answer set — for the paths that post without a browser. */
const validAnswers = (note: string) => ({
  [F.ranked]: [IDEA.copilot, IDEA.trails],
  [F.note]: note,
});

// ─── Who gets in ────────────────────────────────────────────────────────────

test.describe('the door', () => {
  test('an anonymous visitor gets the sign-in interstitial, not the form', async ({ page }) => {
    await openFill(page, multiPath);

    await expect(page.getByRole('heading', { name: /This form is for members of/ })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in →' })).toBeVisible();
    // The title is withheld: access is decided before anything about the form
    // is rendered.
    await expect(page.getByText('ZZ E2E Team Bidding')).toHaveCount(0);
    await expect(page.getByText('Rank your project choices')).toHaveCount(0);
  });

  test('the interstitial comes back to this form after signing in', async ({ page }) => {
    await openFill(page, multiPath);
    const href = await page.getByRole('link', { name: 'Sign in →' }).getAttribute('href');
    expect(href).toContain('redirect=');
    expect(decodeURIComponent(href ?? '')).toContain(multiPath);
  });

  test('a signed-in non-member is told which account they used', async ({ page }) => {
    await loginAs(page, 'student');
    await page.goto(otherPath);

    await expect(page.getByRole('heading', { name: /This form is for members of/ })).toBeVisible();
    await expect(page.getByText('student1@dev.local')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Switch account →' })).toBeVisible();
    // Still no title — being signed in to the wrong course buys nothing.
    await expect(page.getByText('ZZ E2E Not Your Course')).toHaveCount(0);
  });

  test('a member of any role may fill — a TA is a member too', async ({ page }) => {
    await loginAs(page, 'ta');
    await openFill(page, multiPath);
    await expect(page.getByRole('heading', { name: 'ZZ E2E Team Bidding' })).toBeVisible();
    await expect(page.getByText('— from your account')).toBeVisible();
  });
});

// ─── Filling it in ──────────────────────────────────────────────────────────

test.describe('the fill', () => {
  test('identity is shown from the account and is not a question', async ({ page }) => {
    await loginAs(page, 'student');
    await openFill(page, multiPath);

    await expect(page.getByText('— from your account')).toBeVisible();
    await expect(page.getByText('student1@dev.local')).toBeVisible();
    // The definition HAS a name and an email question. Neither is rendered:
    // they are answered from the session instead.
    await expect(page.getByLabel('Name', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('School email', { exact: true })).toHaveCount(0);
  });

  test('roster options are the live roster, resolved at publish', async ({ page }) => {
    await loginAs(page, 'student');
    await openFill(page, multiPath);

    const control = page.getByTestId(`roster-${F.partner}`);
    const search = control.getByRole('combobox');
    await expect(search).toHaveAttribute('aria-label', 'Search Your partner');

    // The options are people, keyed by user id — which is what makes an answer
    // survive a rename, and what the isolation tests below lean on.
    for (const option of rosterOptions.slice(0, 3)) {
      await expect(control.getByRole('button', { name: option.label, exact: true })).toBeVisible();
    }
    await search.fill('zzzz-nobody');
    await expect(control.getByText('No matches.')).toBeVisible();
  });

  test('a search box types a character at a time', async ({ page }) => {
    // The renderer re-renders on every keystroke (the autosave watches every
    // value), so a control declared inside the renderer body would be a new
    // component type each time and would drop focus after one character. The
    // same assertion the public spec makes, for the new control.
    await loginAs(page, 'student');
    await openFill(page, multiPath);

    const search = page.getByTestId(`roster-${F.partner}`).getByRole('combobox');
    await search.pressSequentially(rosterOptions[0].label.slice(0, 5), { delay: 20 });
    await expect(search).toHaveValue(rosterOptions[0].label.slice(0, 5));
  });

  test('fill, submit, and the response is recorded under the session identity', async ({
    page,
  }) => {
    await loginAs(page, 'student');
    await openFill(page, multiPath);

    await fillBidding(page, 'Happy to work weekends.');
    await page.getByRole('button', { name: 'Submit' }).click();

    await expect(page.getByText('Response recorded.')).toBeVisible();
    await expect(page.getByText(/edit it until the form closes/)).toBeVisible();

    const rows = await responsesOf(multiFormId!);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.submission_state).toBe('SUBMITTED');
    expect(row.verified_at).not.toBeNull();
    expect(row.user_id).not.toBeNull();
    expect(row.email).toBe('student1@dev.local');

    const answers = row.answers as Record<string, unknown>;
    // The identity questions were never rendered, and they are answered anyway.
    expect(answers[F.email]).toBe('student1@dev.local');
    expect(answers[F.name]).toBe('Dev Student 1');
    expect(answers[F.partner]).toBe(rosterOptions[0].id);
    expect(answers[F.crew]).toEqual([rosterOptions[1].id]);
    // Rank is positional: index 0 is the first choice.
    expect(answers[F.ranked]).toEqual([IDEA.copilot, IDEA.trails]);
    expect(answers[F.note]).toBe('Happy to work weekends.');
  });

  test('a ranked choice cannot be spent twice', async ({ page }) => {
    await loginAs(page, 'student');
    await openFill(page, multiPath);

    await page.getByLabel('Choice 1').selectOption({ label: 'Course Copilot' });
    // Taken above, so it is gone from the second row's options — the constraint
    // as a shorter list rather than as a warning banner.
    await expect(
      page.getByLabel('Choice 2').locator('option', { hasText: 'Course Copilot' })
    ).toHaveCount(0);
    await expect(
      page.getByLabel('Choice 2').locator('option', { hasText: 'Trail Conditions App' })
    ).toHaveCount(1);
  });

  test('a submission missing a required answer is refused by the server too', async ({ page }) => {
    await loginAs(page, 'student');
    await openFill(page, multiPath);

    const response = await page.request.post(multiPath, {
      maxRedirects: 0,
      headers: { 'content-type': 'application/json' },
      // No ranked choice, which the definition marks required.
      data: { intent: 'submit', answers: { [F.note]: 'nope' }, revisionId: multiRevisionId },
    });
    expect(response.ok()).toBe(true);
    expect(await responsesOf(multiFormId!)).toHaveLength(0);
  });
});

// ─── The server-side draft ──────────────────────────────────────────────────

test.describe('drafts', () => {
  test('autosaves to the server and brings the answers back after a reload', async ({ page }) => {
    await loginAs(page, 'student');
    await openFill(page, multiPath);

    await page.getByLabel('Anything else?', { exact: true }).fill('Half a thought');
    await expect(page.getByTestId('forms-draft-status')).toHaveText('Draft saved', {
      timeout: 15_000,
    });

    const drafts = await responsesOf(multiFormId!);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].submission_state).toBe('DRAFT');
    expect((drafts[0].answers as Record<string, unknown>)[F.note]).toBe('Half a thought');

    // A NEW page in the same session: nothing is in this browser's storage, so
    // if the text comes back it came back from the server.
    await openFill(page, multiPath);
    await expect(page.getByLabel('Anything else?', { exact: true })).toHaveValue('Half a thought');
  });

  test('a draft becomes the submission rather than a second row', async ({ page }) => {
    await loginAs(page, 'student');
    await openFill(page, multiPath);

    await page.getByLabel('Anything else?', { exact: true }).fill('Draft first');
    await expect(page.getByTestId('forms-draft-status')).toHaveText('Draft saved', {
      timeout: 15_000,
    });

    await fillBidding(page, 'Then submitted');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText('Response recorded.')).toBeVisible();

    const rows = await responsesOf(multiFormId!);
    expect(rows).toHaveLength(1);
    expect(rows[0].submission_state).toBe('SUBMITTED');
  });

  test('stops posting once the answers stop changing', async ({ page }) => {
    /**
     * The regression guard for a loop that no assertion about the ROW can see.
     *
     * `watch()` hands back a fresh object on every render, and an autosave is a
     * fetcher submit — which re-renders, and revalidates the loader, which
     * re-renders again. Schedule the save off "the values object changed" and
     * the save is its own trigger: every open tab posts every second and a half
     * for as long as it is open, rewriting the same row with the same answers.
     * Every row-shaped assertion in this file would still pass.
     */
    await loginAs(page, 'student');
    await openFill(page, multiPath);

    let posts = 0;
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().includes(MULTI_SLUG)) posts++;
    });

    await page.getByLabel('Anything else?', { exact: true }).fill('One edit');
    await expect(page.getByTestId('forms-draft-status')).toHaveText('Draft saved', {
      timeout: 15_000,
    });

    const afterFirstSave = posts;
    await page.waitForTimeout(6_000);
    expect(posts).toBe(afterFirstSave);

    // And the row was written exactly once, not repeatedly.
    const rows = await responsesOf(multiFormId!);
    expect(rows).toHaveLength(1);
    const settled = rows[0].updated_at.getTime();
    await page.waitForTimeout(3_000);
    expect((await responsesOf(multiFormId!))[0].updated_at.getTime()).toBe(settled);
  });

  test('an autosave after submitting never overwrites the submitted answers', async ({ page }) => {
    await loginAs(page, 'student');
    await openFill(page, multiPath);
    await fillBidding(page, 'The real answer');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText('Response recorded.')).toBeVisible();

    // `upsertDraft` writes `answers` onto the existing row, so a stray autosave
    // here would silently replace a real submission with a partial one. The
    // action refuses it on the mode, not on the client's good manners.
    const response = await page.request.post(multiPath, {
      maxRedirects: 0,
      headers: { 'content-type': 'application/json' },
      data: { intent: 'autosave', answers: { [F.note]: 'clobbered' }, revisionId: multiRevisionId },
    });
    expect(response.ok()).toBe(true);

    const rows = await responsesOf(multiFormId!);
    expect(rows).toHaveLength(1);
    expect(rows[0].submission_state).toBe('SUBMITTED');
    expect((rows[0].answers as Record<string, unknown>)[F.note]).toBe('The real answer');
  });

  test('a submit outruns a debounce that was already in flight', async ({ page }) => {
    /**
     * The race the mode check alone cannot win: the action READS the mode and
     * then WRITES, and a save scheduled before the submit lands between the
     * two. It is decided in the database — `upsertDraft` may only overwrite a
     * row that is still a DRAFT — and this types, submits immediately, and
     * then waits out the debounce to prove the answers are the submitted ones.
     */
    await loginAs(page, 'student');
    await openFill(page, multiPath);

    await fillBidding(page, 'The submitted answer');
    await page.getByLabel('Anything else?', { exact: true }).fill('Typed a moment before submit');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText('Response recorded.')).toBeVisible();

    await page.waitForTimeout(4_000);

    const rows = await responsesOf(multiFormId!);
    expect(rows).toHaveLength(1);
    expect(rows[0].submission_state).toBe('SUBMITTED');
    expect((rows[0].answers as Record<string, unknown>)[F.note]).toBe(
      'Typed a moment before submit'
    );
  });

  test('a cross-site autosave is refused on a header, before any work', async ({ page }) => {
    await loginAs(page, 'student');
    await openFill(page, multiPath);

    const response = await page.request.post(multiPath, {
      maxRedirects: 0,
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      data: { intent: 'autosave', answers: { [F.note]: 'csrf' }, revisionId: multiRevisionId },
    });
    // The exact code is the framework's to choose — the origin is refused
    // before the action runs. What matters is that it is refused and that
    // nothing reached the table.
    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(await responsesOf(multiFormId!)).toHaveLength(0);
  });
});

// ─── Editing ────────────────────────────────────────────────────────────────

test.describe('editing a recorded response', () => {
  test('re-visiting shows the answers prefilled with an Update button', async ({ page }) => {
    await loginAs(page, 'student');
    await openFill(page, multiPath);
    await fillBidding(page, 'First pass');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText('Response recorded.')).toBeVisible();

    await openFill(page, multiPath);
    await expect(page.getByText('Response recorded.')).toBeVisible();
    await expect(page.getByLabel('Anything else?', { exact: true })).toHaveValue('First pass');
    await expect(page.getByRole('button', { name: 'Update' })).toBeVisible();
  });

  test('an update replaces the row rather than adding one', async ({ page }) => {
    await loginAs(page, 'student');
    await openFill(page, multiPath);
    await fillBidding(page, 'First pass');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText('Response recorded.')).toBeVisible();

    await openFill(page, multiPath);
    await page.getByLabel('Anything else?', { exact: true }).fill('Second pass');
    await page.getByRole('button', { name: 'Update' }).click();

    await expect
      .poll(
        async () => {
          const rows = await responsesOf(multiFormId!);
          return (rows[0]?.answers as Record<string, unknown>)?.[F.note];
        },
        { timeout: 10_000 }
      )
      .toBe('Second pass');

    // The point of the test: ONE row, replaced in place. The partial unique
    // index on (form_id, user_id) is what makes that true, and `allow_multiple`
    // is what makes it allowed.
    const rows = await responsesOf(multiFormId!);
    expect(rows).toHaveLength(1);
    expect(rows[0].submission_state).toBe('SUBMITTED');
  });

  test('a republish shows the recorded answers against the version answered', async ({ page }) => {
    await loginAs(page, 'student');
    await openFill(page, singlePath);
    await page.getByLabel('Anything else?', { exact: true }).fill('Answered version one');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText('Response recorded.')).toBeVisible();

    // The instructor republishes. The response now points at a revision that is
    // no longer current — rendering it against the NEW definition would print
    // an answer under a question nobody was asked, or (worse) nothing at all.
    const services = await getTestServices();
    await services.form.publish(singleFormId!);

    await openFill(page, singlePath);
    await expect(page.getByText('This form has changed since you answered it.')).toBeVisible();
    await expect(page.getByText('Answered version one')).toBeVisible();
  });

  test('a full cap shuts the form, except for whoever is already inside it', async ({ page }) => {
    await loginAs(page, 'student');
    await openFill(page, cappedPath);
    await page.getByLabel('Anything else?', { exact: true }).fill('Took the last seat');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText('Response recorded.')).toBeVisible();

    // A second member arrives to a form with no room left.
    await logout(page);
    await loginAs(page, 'ta');
    await openFill(page, cappedPath);
    await expect(page.getByRole('heading', { name: 'This form is closed' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Submit|Update/ })).toHaveCount(0);

    // The person already inside the cap can still see and change their answer —
    // the same rule the public path applies to an already-verified response.
    await logout(page);
    await loginAs(page, 'student');
    await openFill(page, cappedPath);
    await expect(page.getByText('Response recorded.')).toBeVisible();
    await expect(page.getByLabel('Anything else?', { exact: true })).toHaveValue(
      'Took the last seat'
    );

    expect(await responsesOf(cappedFormId!)).toHaveLength(1);
  });

  test('a single-response form is final once answered', async ({ page }) => {
    await loginAs(page, 'student');
    await openFill(page, singlePath);
    await page.getByLabel('Anything else?', { exact: true }).fill('Only once');
    await page.getByRole('button', { name: 'Submit' }).click();

    await expect(page.getByText('Response recorded.')).toBeVisible();
    await expect(page.getByText(/one response per person/)).toBeVisible();

    await openFill(page, singlePath);
    // Read-only: no form to submit again.
    await expect(page.getByText('Only once')).toBeVisible();
    await expect(page.getByRole('button', { name: /Submit|Update/ })).toHaveCount(0);

    expect(await responsesOf(singleFormId!)).toHaveLength(1);
  });
});

// ─── Isolation ──────────────────────────────────────────────────────────────

test.describe('isolation', () => {
  /** Student fills the form; the returned row is the one nobody else may see. */
  async function studentSubmits(page: Page, note: string) {
    await loginAs(page, 'student');
    await openFill(page, multiPath);
    await fillBidding(page, note);
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText('Response recorded.')).toBeVisible();
    const rows = await responsesOf(multiFormId!);
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  test('a second member sees an empty form, never the first member’s answers', async ({ page }) => {
    await studentSubmits(page, 'Student one only');

    await logout(page);
    await loginAs(page, 'ta');
    await openFill(page, multiPath);

    // Not "Response recorded" — this member has not responded.
    await expect(page.getByText('Response recorded.')).toHaveCount(0);
    await expect(page.getByLabel('Anything else?', { exact: true })).toHaveValue('');
    expect(await page.content()).not.toContain('Student one only');
    expect(await page.content()).not.toContain('student1@dev.local');
  });

  /**
   * A member's own fill page is not cacheable.
   *
   * Every isolation test around it is about who the SERVER hands a response to.
   * A cacheable response moves that decision to a shared proxy, or to the disk
   * cache of a lab machine the next student signs into — the server-side guard
   * would still be correct and would still have been bypassed. Both transports,
   * because `data(…, { headers })` covers only `.data` and only the route's
   * `headers` export carries them onto the document.
   */
  test('a member’s fill page is never cached, on either transport', async ({ page }) => {
    await loginAs(page, 'student');

    for (const target of [multiPath, `${multiPath}.data`]) {
      const response = await page.request.get(target, { maxRedirects: 0 });
      expect(response.status(), target).toBe(200);
      expect(response.headers()['cache-control'], target).toBe('no-store');
    }
  });

  test('nor in the loader payload the single-fetch route returns', async ({ page }) => {
    const mine = await studentSubmits(page, 'Student one only');

    await logout(page);
    await loginAs(page, 'ta');
    // The document route is not the only way in. A guard that only covered the
    // rendered page would leak here.
    const single = await page.request.get(`${multiPath}.data`, { maxRedirects: 0 });
    const body = await single.text();
    expect(body).not.toContain('Student one only');
    expect(body).not.toContain(mine.id);
    expect(body).not.toContain('student1@dev.local');
  });

  test('a posted responseId or userId does not move the write to another row', async ({ page }) => {
    const mine = await studentSubmits(page, 'Student one only');

    await logout(page);
    await loginAs(page, 'ta');
    await openFill(page, multiPath);

    // Every shape a tamperer would reach for. None of these keys is read by the
    // action: the row is keyed on the session's user id and nothing else.
    for (const tamper of [
      { responseId: mine.id },
      { userId: mine.user_id },
      { responseId: mine.id, userId: mine.user_id },
      { identity: { email: 'student1@dev.local', name: 'Dev Student 1' } },
    ]) {
      const response = await page.request.post(multiPath, {
        maxRedirects: 0,
        headers: { 'content-type': 'application/json' },
        data: {
          intent: 'autosave',
          answers: { [F.note]: 'tampered' },
          revisionId: multiRevisionId,
          ...tamper,
        },
      });
      expect(response.ok()).toBe(true);
    }

    const rows = await responsesOf(multiFormId!);
    const victim = rows.find(row => row.id === mine.id);
    // Untouched, still theirs, still SUBMITTED.
    expect(victim?.submission_state).toBe('SUBMITTED');
    expect((victim?.answers as Record<string, unknown>)[F.note]).toBe('Student one only');

    // The tampering landed where it always was going to: on the tamperer's own
    // draft, under their own user id.
    const others = rows.filter(row => row.id !== mine.id);
    expect(others).toHaveLength(1);
    expect(others[0].user_id).not.toBe(mine.user_id);
    expect(others[0].submission_state).toBe('DRAFT');
  });

  test('a tampered submit is filed under the session, not the posted identity', async ({
    page,
  }) => {
    const mine = await studentSubmits(page, 'Student one only');

    await logout(page);
    await loginAs(page, 'ta');

    const response = await page.request.post(multiPath, {
      maxRedirects: 0,
      headers: { 'content-type': 'application/json' },
      data: {
        intent: 'submit',
        answers: {
          ...validAnswers('Filed under the TA'),
          // A claimed identity, in the answers AND in the envelope, aimed at a
          // named row.
          [F.email]: 'student1@dev.local',
          [F.name]: 'Dev Student 1',
        },
        identity: { email: 'student1@dev.local', name: 'Dev Student 1' },
        responseId: mine.id,
        revisionId: multiRevisionId,
      },
    });
    expect(response.ok()).toBe(true);

    const rows = await responsesOf(multiFormId!);
    expect(rows).toHaveLength(2);
    const theirs = rows.find(row => row.id !== mine.id)!;
    expect(theirs.user_id).not.toBe(mine.user_id);
    // The identity answers were overwritten from the session, not accepted.
    expect(theirs.email).not.toBe('student1@dev.local');
    expect((theirs.answers as Record<string, unknown>)[F.email]).not.toBe('student1@dev.local');

    const victim = rows.find(row => row.id === mine.id)!;
    expect((victim.answers as Record<string, unknown>)[F.note]).toBe('Student one only');
  });

  test('staff see both responses on the responses page', async ({ page }) => {
    await studentSubmits(page, 'Student one only');

    await logout(page);
    await loginAs(page, 'ta');
    await openFill(page, multiPath);
    await fillBidding(page, 'The TA answered too');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText('Response recorded.')).toBeVisible();

    await logout(page);
    await loginAs(page, 'owner');
    await page.goto(`${multiPath}/responses`);

    // `.first()`: the table shows the address in more than one column.
    await expect(page.getByText('student1@dev.local').first()).toBeVisible();
    await expect(page.getByText('ta@dev.local').first()).toBeVisible();
  });
});
