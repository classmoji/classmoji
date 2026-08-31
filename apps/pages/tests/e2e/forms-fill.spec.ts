import { randomUUID } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { test, expect, type Page } from '@playwright/test';

import {
  getClassroomIdBySlug,
  getTestClassroomSlug,
  getTestPrisma,
  getTestServices,
} from '../helpers';
import { parseFormDefinition } from '@classmoji/services/form-contract';
import { presetByKey } from '../../app/components/forms/presets.ts';
import { SUBMISSION_RATE_LIMIT } from '../../app/utils/submissionRate.server.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The public fill + magic-link verification flow, over real HTTP and a real
 * browser.
 *
 * ── What this file is for ──────────────────────────────────────────────────
 * This is the first surface in the product that lets a STRANGER write to the
 * database. Everything here is about the properties that makes load-bearing:
 *
 *  1. the happy path actually completes — fill, submit, click the emailed
 *     link, confirm, and the response is SUBMITTED;
 *  2. nothing is recorded before the link is clicked;
 *  3. a second submission from the same address produces one row, not two, and
 *     the SAME view — the check-email state is the only thing a caller can
 *     observe, so it cannot become an oracle for "did this person apply";
 *  4. the abuse surfaces — honeypot, cross-site post, oversized body — refuse
 *     without writing;
 *  5. the states that are not a form (closed, classroom-only, dead link) say so
 *     without leaking what they are hiding.
 *
 * ── The magic link ─────────────────────────────────────────────────────────
 * The raw token is returned by `beginPublicSubmission` exactly once and stored
 * only as a sha256 digest, so it CANNOT be recovered from the database. In dev
 * the route logs it instead of mailing it, and the log is the only place it
 * exists — `readMagicLink` below polls that file for the line naming a specific
 * recipient. That is not a shortcut around the design; it is the design's dev
 * escape, and the test uses the same door a developer does.
 *
 * The fixture is created and destroyed here. Deleting the form cascades to its
 * revisions, responses, and tokens.
 */

const CLASS = getTestClassroomSlug();
const FORM_SLUG = 'zz-e2e-fill';
const CLASSROOM_FORM_SLUG = 'zz-e2e-fill-members';
const TYPES_FORM_SLUG = 'zz-e2e-fill-types';
/** A form in the state the CLASSROOM→PUBLIC flip used to leave behind. */
const LEAK_FORM_SLUG = 'zz-e2e-fill-roster-leak';

const fillPath = `/${CLASS}/forms/${FORM_SLUG}`;
const verifyPath = `${fillPath}/verify`;
const typesPath = `/${CLASS}/forms/${TYPES_FORM_SLUG}`;
const leakPath = `/${CLASS}/forms/${LEAK_FORM_SLUG}`;

let formId: string | null = null;
let classroomFormId: string | null = null;
let typesFormId: string | null = null;
let leakFormId: string | null = null;
let revisionId: string | null = null;
/** A real roster label — `Name (login)` — that must never reach the wire. */
let leakedLabel: string | null = null;

/**
 * Fixed ids for the every-control fixture, so the stored answers can be read
 * back by name. Answers key on field ids, which is the whole reason the
 * contract mints them.
 */
const T = {
  number: '44444444-4444-4444-8444-444444444444',
  dropdown: '55555555-5555-4555-8555-555555555555',
  multiselect: '66666666-6666-4666-8666-666666666666',
  switch: '77777777-7777-4777-8777-777777777777',
  matrix: '88888888-8888-4888-8888-888888888888',
  ranked: '99999999-9999-4999-8999-999999999999',
} as const;

/**
 * Option ids, likewise fixed — real uuids, because the contract validates them
 * as such. Readable names map to hex suffixes so the assertions stay legible
 * without smuggling non-hex characters into a uuid.
 */
const OPT_CODES = {
  d1: '11',
  d2: '12',
  m1: '21',
  m2: '22',
  r1: '31',
  r2: '32',
  c1: '41',
  c2: '42',
  k1: '51',
  k2: '52',
  k3: '53',
} as const;

const opt = (name: keyof typeof OPT_CODES) =>
  `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa${OPT_CODES[name]}`;

// ─── The dev log, where the link lives ──────────────────────────────────────

/** The dev log path `npm run dev` wrote into `.dev-context`. */
function devLogPath(): string {
  const devContext = fs.readFileSync(path.join(__dirname, '../../../../.dev-context'), 'utf-8');
  const match = devContext.match(/File:\s+(\/\S+\.log)/);
  if (!match) throw new Error('no dev log path in .dev-context — is the stack running?');
  return match[1];
}

/**
 * The most recent magic link logged for one address.
 *
 * POLLED, not read once: the line is written by a different process and stdout
 * reaches the file through a pipe, so it can lag the HTTP response it belongs
 * to by a few milliseconds. Matching on the recipient rather than on "the last
 * line" is what lets several fixtures submit without stealing each other's
 * links — the log is shared by every service in the stack.
 */
async function readMagicLink(email: string, timeoutMs = 10_000): Promise<string> {
  const logPath = devLogPath();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const lines = fs
      .readFileSync(logPath, 'utf-8')
      .split('\n')
      .filter(line => line.includes(`[forms:magic-link] to=${email} `));
    const last = lines.at(-1);
    if (last) {
      const url = last.match(/(https?:\/\/\S+)/);
      if (url) return url[1];
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  throw new Error(`no magic link logged for ${email} within ${timeoutMs}ms`);
}

/** The link's path + query, for `page.goto` against the configured baseURL. */
const linkTarget = (url: string): string => {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
};

// ─── Fixture ────────────────────────────────────────────────────────────────

/** The WAITLIST preset's field labels, which the assertions below address. */
const NAME_LABEL = 'Full name';
const EMAIL_LABEL = 'School email';
const SCALE_LABEL = 'How familiar are you with the material?';
const LONG_LABEL = 'What are you hoping to get out of the class?';

test.beforeAll(async () => {
  const prisma = await getTestPrisma();
  const classroomId = await getClassroomIdBySlug(CLASS);

  const owner = await prisma.classroomMembership.findFirst({
    where: { classroom_id: classroomId, role: 'OWNER' },
    select: { user_id: true },
  });
  if (!owner) throw new Error('no OWNER membership — is the dev database seeded?');

  await prisma.form.deleteMany({
    where: {
      classroom_id: classroomId,
      slug: { in: [FORM_SLUG, CLASSROOM_FORM_SLUG, TYPES_FORM_SLUG, LEAK_FORM_SLUG] },
    },
  });

  // The real WAITLIST preset, through the real contract. Hand-writing a field
  // list here would test a form no instructor can actually create; the preset
  // is what the New Form drawer produces, and `parseFormDefinition` is what
  // `form.service` would have normalized it with.
  const definition = parseFormDefinition(presetByKey('waitlist').fields());

  const form = await prisma.form.create({
    data: {
      classroom_id: classroomId,
      title: 'ZZ E2E Waitlist',
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

  // A second, CLASSROOM-access form: the interstitial has to be tested against
  // a form that really is members-only, not against a missing one.
  const membersOnly = await prisma.form.create({
    data: {
      classroom_id: classroomId,
      title: 'ZZ E2E Members Only',
      slug: CLASSROOM_FORM_SLUG,
      access: 'CLASSROOM',
      status: 'OPEN',
      created_by: owner.user_id,
    },
  });
  classroomFormId = membersOnly.id;
  const membersRevision = await prisma.formRevision.create({
    data: { form_id: membersOnly.id, version: 1, fields: definition as never },
  });
  await prisma.form.update({
    where: { id: membersOnly.id },
    data: { current_revision_id: membersRevision.id },
  });

  // A third form carrying every control the waitlist preset does NOT use, and
  // deliberately NO email field — so it also exercises the dedicated identity
  // inputs, the branch that only appears when the definition asks for no
  // address of its own.
  const typesDefinition = parseFormDefinition([
    { id: T.number, type: 'number', label: 'How many', required: true, min: 1, max: 10 },
    {
      id: T.dropdown,
      type: 'dropdown',
      label: 'Pick one',
      required: true,
      options: [
        { id: opt('d1'), label: 'First' },
        { id: opt('d2'), label: 'Second', description: 'With a note.' },
      ],
    },
    {
      id: T.multiselect,
      type: 'multiselect',
      label: 'Pick any',
      required: true,
      options: [
        { id: opt('m1'), label: 'Alpha' },
        { id: opt('m2'), label: 'Beta' },
      ],
    },
    {
      id: T.switch,
      type: 'switch',
      label: 'Do you agree',
      required: true,
      description: 'This is the acknowledgment pattern.',
    },
    {
      id: T.matrix,
      type: 'matrix',
      label: 'Rate each',
      required: true,
      matrix: {
        rows: [
          { id: opt('r1'), label: 'Speed' },
          { id: opt('r2'), label: 'Care' },
        ],
        columns: [
          { id: opt('c1'), label: 'Low' },
          { id: opt('c2'), label: 'High' },
        ],
        required_rows: 'all',
      },
    },
    {
      id: T.ranked,
      type: 'ranked_choice',
      label: 'Rank these',
      required: true,
      ranks: 2,
      options: [
        { id: opt('k1'), label: 'Red' },
        { id: opt('k2'), label: 'Blue' },
        { id: opt('k3'), label: 'Green' },
      ],
    },
  ]);

  const typesForm = await prisma.form.create({
    data: {
      classroom_id: classroomId,
      title: 'ZZ E2E Every Control',
      slug: TYPES_FORM_SLUG,
      access: 'PUBLIC',
      status: 'OPEN',
      created_by: owner.user_id,
      draft_fields: typesDefinition as never,
    },
  });
  typesFormId = typesForm.id;
  const typesRevision = await prisma.formRevision.create({
    data: { form_id: typesForm.id, version: 1, fields: typesDefinition as never },
  });
  await prisma.form.update({
    where: { id: typesForm.id },
    data: { current_revision_id: typesRevision.id },
  });

  // ── The poisoned form ──────────────────────────────────────────────────
  //
  // A PUBLIC form whose LIVE revision holds a materialized roster. There is no
  // longer any supported write path that produces this — `form.service.update`
  // refuses the CLASSROOM→PUBLIC flip on a form that has ever been published —
  // so the row is built directly, which is the only way to reach the render
  // backstop that exists for exactly this state.
  //
  // The options are shaped the way `materializeSourcedOptions` shapes them:
  // one entry per member, `{ id: <user_id>, label: "Name (login)" }`. That is
  // the payload the fill page used to hand to anonymous visitors.
  const roster = await prisma.classroomMembership.findMany({
    where: { classroom_id: classroomId, role: 'STUDENT' },
    select: { user_id: true, user: { select: { name: true, login: true } } },
    take: 5,
  });
  if (roster.length === 0) throw new Error('no STUDENT memberships — is the dev database seeded?');

  const rosterOptions = roster.map(member => ({
    id: member.user_id,
    label: `${member.user.name} (${member.user.login})`,
  }));
  leakedLabel = rosterOptions[0].label;

  const poisoned = {
    definition_version: 1,
    fields: [
      {
        id: '0198f00d-f00d-4f00-8f00-f00df00df00d',
        type: 'roster_select',
        label: 'Who would you like to work with?',
        required: true,
        optionSource: 'roster',
        multiple: false,
        options: rosterOptions,
      },
    ],
  };

  const leakForm = await prisma.form.create({
    data: {
      classroom_id: classroomId,
      title: 'ZZ E2E Roster Leak',
      slug: LEAK_FORM_SLUG,
      access: 'CLASSROOM',
      status: 'OPEN',
      created_by: owner.user_id,
      draft_fields: poisoned as never,
    },
  });
  leakFormId = leakForm.id;
  const leakRevision = await prisma.formRevision.create({
    data: { form_id: leakForm.id, version: 1, fields: poisoned as never },
  });
  await prisma.form.update({
    where: { id: leakForm.id },
    data: { current_revision_id: leakRevision.id, access: 'PUBLIC' },
  });
});

test.afterAll(async () => {
  const prisma = await getTestPrisma();
  for (const id of [formId, classroomFormId, typesFormId, leakFormId]) {
    if (id) await prisma.form.delete({ where: { id } }).catch(() => {});
  }
});

/** Every response to the fixture form, in the order the staff surface sees. */
async function responsesOf(id: string) {
  const services = await getTestServices();
  return services.formResponse.listByFormId(id);
}

/** Reset between tests so each starts from a form with no responses. */
test.beforeEach(async () => {
  const prisma = await getTestPrisma();
  for (const id of [formId, typesFormId]) {
    if (id) await prisma.formResponse.deleteMany({ where: { form_id: id } });
  }
});

// ─── Filling the form ───────────────────────────────────────────────────────

/** Fill every required field of the waitlist preset with valid answers. */
async function fillWaitlist(page: Page, email: string, name = 'Maya Chen') {
  await page.getByLabel(NAME_LABEL, { exact: true }).fill(name);
  await page.getByLabel(EMAIL_LABEL, { exact: true }).fill(email);
  await page
    .getByRole('radiogroup', { name: SCALE_LABEL })
    .getByRole('radio', { name: '7' })
    .click();
  await page.getByLabel(LONG_LABEL, { exact: true }).fill('Everything, ideally.');
}

test.describe('public fill — the happy path', () => {
  test('fill, submit, click the emailed link, confirm — and the response is SUBMITTED', async ({
    page,
  }) => {
    const email = 'zz-e2e-happy@example.edu';
    await page.goto(fillPath);

    // The form renders for an anonymous visitor, banner and all.
    await expect(page.getByRole('heading', { name: 'ZZ E2E Waitlist' })).toBeVisible();
    await expect(page.getByText('This waitlist is FIFO')).toBeVisible();
    // And it did NOT come wrapped in the classroom's page chrome: the forms
    // subtree lives outside the `$classroomSlug` layout, whose loader would
    // otherwise have put the classroom's page list into a document a stranger
    // is allowed to read. Asserted here, against a real rendered form, because
    // this is the case with the most to leak.
    await expect(page.getByText('New Page')).toHaveCount(0);

    /**
     * TYPED ONE KEY AT A TIME, deliberately.
     *
     * `fill()` sets a value in one atomic event and refocuses on every call, so
     * it cannot see the failure mode this form is most exposed to: the autosave
     * subscribes to every value, so each keystroke re-renders the whole
     * renderer, and if the control components are recreated on that render React
     * swaps the element type, unmounts the input, and the field loses focus
     * after the FIRST character. Every other assertion in this file passes
     * happily against a form nobody can actually type into.
     */
    const nameInput = page.getByLabel(NAME_LABEL, { exact: true });
    await nameInput.pressSequentially('Maya Chen');
    await expect(nameInput).toHaveValue('Maya Chen');
    await expect(nameInput).toBeFocused();

    await fillWaitlist(page, email);
    await page.getByRole('button', { name: 'Submit' }).click();

    // The check-email state names the address it sent to.
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();

    // Nothing counts yet: the row exists but is unverified, so it is invisible
    // to the cap and to the FIFO ordering.
    let rows = await responsesOf(formId!);
    expect(rows).toHaveLength(1);
    expect(rows[0].submission_state).toBe('PENDING_VERIFICATION');
    expect(rows[0].verified_at).toBeNull();

    const link = await readMagicLink(email);
    await page.goto(linkTarget(link));

    // The review page shows what they sent, read-only, with their identity.
    // `.first()` throughout: the name and the address appear both in the
    // identity block and as the answers they were given as — which is correct,
    // and is why these are not unique locators.
    await expect(page.getByRole('button', { name: 'Confirm' })).toBeVisible();
    await expect(page.getByText('Maya Chen').first()).toBeVisible();
    await expect(page.getByText(email).first()).toBeVisible();
    await expect(page.getByText('Everything, ideally.')).toBeVisible();
    // Read-only: a review page that offered inputs would be an edit page.
    await expect(page.locator('form input[type="text"], form textarea')).toHaveCount(0);

    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByRole('heading', { name: "You're in" })).toBeVisible();

    rows = await responsesOf(formId!);
    expect(rows).toHaveLength(1);
    expect(rows[0].submission_state).toBe('SUBMITTED');
    expect(rows[0].verified_at).not.toBeNull();
    expect(rows[0].email).toBe(email);
    expect(rows[0].name).toBe('Maya Chen');
  });

  test('a second submission from the same address is one row and the same view', async ({
    page,
  }) => {
    const email = 'zz-e2e-duplicate@example.edu';

    for (const attempt of [1, 2]) {
      await page.goto(fillPath);
      await fillWaitlist(page, email, `Attempt ${attempt}`);
      await page.getByRole('button', { name: 'Submit' }).click();
      // IDENTICAL both times. A different message the second time would answer
      // "has this address already responded?" for anyone who cared to type one.
      await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
      await expect(page.getByText(email)).toBeVisible();
    }

    const rows = await responsesOf(formId!);
    expect(rows).toHaveLength(1);
    // The stored answers are the FIRST ones: `beginPublicSubmission` will not
    // overwrite an existing response, because only the inbox owner gets to
    // decide whether it changes.
    expect(rows[0].name).toBe('Attempt 1');
  });

  test('a fresh link on a verified response opens it for editing', async ({ page }) => {
    const email = 'zz-e2e-edit@example.edu';

    await page.goto(fillPath);
    await fillWaitlist(page, email, 'Before Edit');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

    await page.goto(linkTarget(await readMagicLink(email)));
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByRole('heading', { name: "You're in" })).toBeVisible();

    const verifiedAt = (await responsesOf(formId!))[0].verified_at;

    // Submitting again with the same address mails a link to the response that
    // already exists — the edit path.
    await page.goto(fillPath);
    await fillWaitlist(page, email, 'Ignored');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

    await page.goto(linkTarget(await readMagicLink(email)));
    await page.getByRole('button', { name: 'Edit answers' }).click();
    await page.getByLabel(LONG_LABEL, { exact: true }).fill('Actually, just the basics.');
    await page.getByRole('button', { name: 'Save and confirm' }).click();
    await expect(page.getByRole('heading', { name: "You're in" })).toBeVisible();

    const rows = await responsesOf(formId!);
    expect(rows).toHaveLength(1);
    const answers = rows[0].answers as Record<string, unknown>;
    expect(Object.values(answers)).toContain('Actually, just the basics.');
    // Editing must not cost them their place in a FIFO waitlist.
    expect(rows[0].verified_at?.toISOString()).toBe(verifiedAt?.toISOString());
  });
});

test.describe('public fill — every control', () => {
  test('each control type collects the answer the contract expects', async ({ page }) => {
    /**
     * The renderer's controls all live in one hoisted `Control`, so a structural
     * change to it reaches every field type at once. This drives the ones the
     * waitlist preset does not use — number, dropdown, multiselect, the
     * acknowledgment switch, the matrix's nested `answers.{field}.{row}`
     * registration, and ranked choice — through a real browser, and reads the
     * stored answers back to confirm each landed in the shape the contract
     * defines rather than merely "something was submitted".
     */
    await page.goto(typesPath);

    await page.getByLabel('How many', { exact: true }).fill('4');
    await page.getByLabel('Pick one', { exact: true }).selectOption(opt('d1'));
    // The dropdown's per-option prose has nowhere to live inside a <select>, so
    // it is listed beneath it rather than dropped.
    await expect(page.getByText('With a note.')).toBeVisible();

    await page.getByRole('checkbox', { name: 'Alpha' }).check();
    await page.getByRole('checkbox', { name: 'Beta' }).check();

    // A required switch is an acknowledgment: its description is the thing
    // being agreed to, so it sits beside the box.
    await expect(page.getByText('This is the acknowledgment pattern.')).toBeVisible();
    await page.getByRole('checkbox', { name: 'Do you agree' }).check();

    // The matrix: one radio per (row, column), each labelled by both.
    await page.getByRole('radio', { name: 'Speed: High' }).check();
    await page.getByRole('radio', { name: 'Care: Low' }).check();

    await page.getByLabel('Choice 1', { exact: true }).selectOption(opt('k3'));
    // Each option is usable once, so the one taken above is gone from choice 2.
    const secondChoice = page.getByLabel('Choice 2', { exact: true });
    await expect(secondChoice.locator('option', { hasText: 'Green' })).toHaveCount(0);
    await secondChoice.selectOption(opt('k1'));

    // No email field in this definition, so the dedicated identity inputs are
    // the only place an address can come from.
    // Not `exact`: the required marker is part of the label, so the accessible
    // name is "Your email address*".
    await page.getByLabel('Your email address').fill('zz-e2e-types@example.edu');
    await page.getByLabel('Your name', { exact: true }).fill('Every Control');

    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

    const rows = await responsesOf(typesFormId!);
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe('zz-e2e-types@example.edu');
    expect(rows[0].name).toBe('Every Control');

    const answers = rows[0].answers as Record<string, unknown>;
    // A number, not the string the input produced.
    expect(answers[T.number]).toBe(4);
    expect(answers[T.dropdown]).toBe(opt('d1'));
    expect(answers[T.multiselect]).toEqual([opt('m1'), opt('m2')]);
    expect(answers[T.switch]).toBe(true);
    expect(answers[T.matrix]).toEqual({ [opt('r1')]: opt('c2'), [opt('r2')]: opt('c1') });
    // Ranks are positional: index 0 is the first choice.
    expect(answers[T.ranked]).toEqual([opt('k3'), opt('k1')]);
  });
});

// ─── Abuse surfaces ─────────────────────────────────────────────────────────

test.describe('public fill — abuse surfaces', () => {
  test('a filled honeypot gets the success view and writes nothing', async ({ page }) => {
    const email = 'zz-e2e-bot@example.edu';
    await page.goto(fillPath);
    await fillWaitlist(page, email, 'Definitely A Person');

    // The trap: off-screen, aria-hidden, and unreachable by tab — a person
    // cannot fill it, so anything in it came from a script reading the DOM.
    await page.locator('input#website').fill('https://spam.example');
    await page.getByRole('button', { name: 'Submit' }).click();

    // Same page a person gets. Telling a bot it failed is how it learns to skip
    // the field next time.
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

    // No row, and — just as important — no token, so the honeypot cannot be
    // used to burn someone else's send cooldown.
    expect(await responsesOf(formId!)).toHaveLength(0);
    const prisma = await getTestPrisma();
    expect(await prisma.formMagicToken.count({ where: { response: { form_id: formId! } } })).toBe(
      0
    );
  });

  test('a cross-site POST is refused and writes nothing', async ({ page }) => {
    const response = await page.request.post(fillPath, {
      maxRedirects: 0,
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      data: {
        answers: {},
        identity: { email: 'zz-e2e-csrf@example.edu', name: 'CSRF' },
        revisionId,
      },
    });

    // NOT 200. Which refusal it is depends on where the request dies: in dev the
    // Vite middleware answers 400 before a route module runs, and in production
    // `checkOrigin` answers 403. Asserting the exact code here would make this
    // test a statement about the dev server. `forms-origin.spec.ts` pins the
    // helper's own behaviour, which is the part that ships.
    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(await responsesOf(formId!)).toHaveLength(0);
  });

  /**
   * A SMALL body that is expensive to look at.
   *
   * Forty kilobytes of `[[[[…]]]]` is well under every size cap, parses without
   * complaint, and then overflows the stack the moment anything serializes it —
   * `JSON.parse` accepts nesting `JSON.stringify` cannot walk. The resulting
   * RangeError carries no `code`, so it missed every branch in the action's
   * catch chain and came back as a 500: an unauthenticated caller could make the
   * server do that as fast as it could send.
   *
   * Both endpoints are checked. `/verify` takes a body from anyone holding or
   * guessing a token and reaches the same serializer.
   */
  test('a pathologically nested body is refused with a 400, not a 500', async ({ page }) => {
    // Written as TEXT, not as an object Playwright will serialize for us —
    // `JSON.stringify` is exactly what cannot walk this value, so handing it to
    // the client would crash the test instead of the assertion it is making.
    // That is also what makes this a faithful reproduction: an attacker writes
    // bytes, they do not build a JavaScript object.
    const deep = '['.repeat(20_000) + ']'.repeat(20_000);
    const body =
      `{"answers":{"deep":${deep}},` +
      `"identity":{"email":"zz-e2e-deep@example.edu","name":"Deep"},` +
      `"token":"not-a-real-token","revisionId":${JSON.stringify(revisionId)}}`;

    // Comfortably inside every size cap — this is not the oversized-body case
    // wearing a different hat.
    expect(body.length).toBeLessThan(100 * 1024);

    for (const target of [fillPath, verifyPath]) {
      const response = await page.request.post(target, {
        maxRedirects: 0,
        headers: { 'content-type': 'application/json' },
        data: body,
      });

      expect(response.status(), target).toBe(400);
    }

    expect(await responsesOf(formId!)).toHaveLength(0);
  });

  /**
   * The honeypot decision belongs to the SERVER.
   *
   * The browser test above fills the trap through the DOM, which proves the
   * page reports it. It cannot prove the check would survive a client that
   * simply lies — and until this fix the check lived on the client: the page
   * computed a `trapped` boolean and the action believed it, so a bot that
   * filled the trap and posted `trapped: false` walked through untouched.
   *
   * Posting the raw value directly is the only way to test the half that
   * matters. Both shapes are sent together — the filled trap AND the old
   * client-side "I am not a bot" claim — because a server that still honoured
   * the boolean would pass a test that sent only the value.
   */
  test('the server decides the honeypot, not the page that reports it', async ({ page }) => {
    const prisma = await getTestPrisma();
    const revision = await prisma.formRevision.findUniqueOrThrow({ where: { id: revisionId! } });
    const fields = (revision.fields as { fields: Array<Record<string, unknown>> }).fields;
    const idFor = (label: string) =>
      String(fields.find(field => field.label === label)!.id as string);

    const submission = (email: string, extra: Record<string, unknown>) => ({
      answers: {
        [idFor(NAME_LABEL)]: 'Definitely A Person',
        [idFor(EMAIL_LABEL)]: email,
        [idFor(SCALE_LABEL)]: 7,
      },
      identity: { email, name: 'Definitely A Person' },
      revisionId,
      ...extra,
    });

    // CONTROL: the identical submission with an empty trap is recorded. Without
    // it, "no row was written" would be satisfied by a body that was simply
    // invalid, and the test would prove nothing about the honeypot.
    const control = await page.request.post(fillPath, {
      maxRedirects: 0,
      headers: { 'content-type': 'application/json' },
      data: submission('zz-e2e-control@example.edu', { trap: '' }),
    });
    expect(control.status()).toBe(200);
    expect(await responsesOf(formId!)).toHaveLength(1);

    // THE BOT: same body, trap filled, and the old client-side "I am not a bot"
    // claim attached. A server that still honoured that boolean would record it.
    const bot = await page.request.post(fillPath, {
      maxRedirects: 0,
      headers: { 'content-type': 'application/json' },
      data: submission('zz-e2e-liar@example.edu', {
        trap: 'https://spam.example',
        trapped: false,
      }),
    });
    expect(bot.status()).toBe(200);

    // Still one row — the control's. No second row, and no token, so the trap
    // also cannot be used to burn someone else's send cooldown.
    const rows = await responsesOf(formId!);
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe('zz-e2e-control@example.edu');
    expect(await prisma.formMagicToken.count({ where: { response: { form_id: formId! } } })).toBe(
      1
    );
  });

  /**
   * THE SPAM RELAY.
   *
   * `beginPublicSubmission` mails a branded verification link to whatever
   * address it is given, and its own cooldown counts per (form, email) — the
   * unit a bomb aimed at ONE mailbox uses. Vary the address and that cooldown
   * never fires: one anonymous caller could send unlimited Classmoji-branded
   * mail to unlimited recipients, burning the platform's sender reputation and
   * leaving a PENDING_VERIFICATION row behind each time.
   *
   * A fresh random address per run, sent as the forwarded hop: the limiter keeps
   * its counters in memory for ten minutes, so a fixed address would make this
   * test fail on its second run inside that window rather than on a regression.
   */
  test('a burst of distinct addresses from one client is cut off', async ({ page }) => {
    // A fresh key per run. The limiter treats the forwarded hop as an opaque
    // string, so a uuid is a perfectly good "address" and — unlike a random
    // octet — cannot collide with a previous run still inside the ten-minute
    // window and fail on the FIRST submission instead of the last.
    const ip = `e2e-${randomUUID()}`;

    // VALID answers, read off the live revision. Invalid ones would be refused
    // before the mailer for a reason that has nothing to do with rate limiting,
    // and the test would then prove only that a broken submission is broken.
    const prisma = await getTestPrisma();
    const revision = await prisma.formRevision.findUniqueOrThrow({ where: { id: revisionId! } });
    const fields = (revision.fields as { fields: Array<Record<string, unknown>> }).fields;
    const idFor = (label: string) =>
      String(fields.find(field => field.label === label)!.id as string);

    const answersFor = (n: number) => ({
      [idFor(NAME_LABEL)]: `Victim ${n}`,
      [idFor(EMAIL_LABEL)]: `zz-e2e-relay-${n}@example.edu`,
      [idFor(SCALE_LABEL)]: 5,
    });

    const post = (n: number) =>
      page.request.post(fillPath, {
        maxRedirects: 0,
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        data: {
          answers: answersFor(n),
          identity: { email: `zz-e2e-relay-${n}@example.edu`, name: `Victim ${n}` },
          revisionId,
        },
      });

    // Every one of these is a DIFFERENT recipient, so the per-address cooldown
    // is never consulted. Only a per-sender limit can see this pattern at all.
    for (let n = 0; n < SUBMISSION_RATE_LIMIT; n++) {
      const allowed = await post(n);
      expect(allowed.status(), `submission ${n}`).toBe(200);
    }

    // Each of those really did mail a stranger — which is the abuse, and the
    // reason a ceiling has to exist at all.
    expect(await responsesOf(formId!)).toHaveLength(SUBMISSION_RATE_LIMIT);

    const refused = await post(SUBMISSION_RATE_LIMIT);
    expect(refused.status()).toBe(429);
    expect(Number(refused.headers()['retry-after'])).toBeGreaterThan(0);

    // The refusal lands BEFORE the mailer: the last address got no row and no
    // token, which is the whole point of placing the check where it is.
    const overflow = await prisma.formResponse.findFirst({
      where: { form_id: formId!, email: `zz-e2e-relay-${SUBMISSION_RATE_LIMIT}@example.edu` },
      select: { id: true },
    });
    expect(overflow).toBeNull();

    // A different client is unaffected — the limit is per sender, never global,
    // so an abuser cannot close the form for the people it is meant for.
    const other = await page.request.post(fillPath, {
      maxRedirects: 0,
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `e2e-${randomUUID()}` },
      data: {
        answers: answersFor(9_000),
        identity: { email: 'zz-e2e-bystander@example.edu', name: 'Bystander' },
        revisionId,
      },
    });
    expect(other.status()).toBe(200);
    expect(await responsesOf(formId!)).toHaveLength(SUBMISSION_RATE_LIMIT + 1);
  });

  /**
   * Deliberately the LAST `page.request` test in this block.
   *
   * The 413 is answered from `Content-Length` alone, without reading the body —
   * which is the whole point of the cap, and also leaves an undrained request on
   * the socket, so Node resets the connection. Playwright's request context
   * keeps that socket in its pool and the NEXT API call on it dies with
   * ECONNRESET. Everything after this test is browser-driven and gets a fresh
   * connection; adding another `page.request` case below it will fail for
   * reasons that have nothing to do with what it is testing.
   */
  test('an oversized body is refused before it is parsed', async ({ page }) => {
    const response = await page.request.post(fillPath, {
      maxRedirects: 0,
      headers: { 'content-type': 'application/json' },
      data: {
        answers: { anything: 'x'.repeat(400 * 1024) },
        identity: { email: 'zz-e2e-huge@example.edu' },
        revisionId,
      },
    });

    expect(response.status()).toBe(413);
    expect(await responsesOf(formId!)).toHaveLength(0);
  });

  test('the browser refuses a submission that is missing a required answer', async ({ page }) => {
    await page.goto(fillPath);
    // Everything but the required name.
    await page.getByLabel(EMAIL_LABEL, { exact: true }).fill('zz-e2e-invalid@example.edu');
    await page
      .getByRole('radiogroup', { name: SCALE_LABEL })
      .getByRole('radio', { name: '7' })
      .click();
    await page.getByRole('button', { name: 'Submit' }).click();

    // The client-side mirror of `buildResponseSchema` — the same schema the
    // server runs — catches it without a round trip.
    await expect(page.getByRole('alert').filter({ hasText: 'required' }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toHaveCount(0);
    expect(await responsesOf(formId!)).toHaveLength(0);
  });

  test('and so does the server, for a client that skipped that check', async ({ page }) => {
    // The browser check is a convenience; the contract is the control. A
    // hand-rolled POST with no answers must not produce a row.
    //
    // Only the WRITE is asserted, not the status code: the dev server renders
    // this route's document through Vite, and that pipeline occasionally drops
    // the connection on a ~1.3MB dev document (it emits the same
    // `@prisma/client` resolve warning on every route in this app, including
    // ones that predate forms). A reset connection is still a submission that
    // did not happen, which is the whole claim.
    await page.request
      .post(fillPath, {
        maxRedirects: 0,
        headers: { 'content-type': 'application/json' },
        data: {
          answers: {},
          identity: { email: 'zz-e2e-empty@example.edu', name: 'Empty' },
          revisionId,
        },
      })
      .catch(() => null);

    expect(await responsesOf(formId!)).toHaveLength(0);
  });
});

// ─── The states that are not a form ─────────────────────────────────────────

test.describe('public fill — non-form states', () => {
  test('a DRAFT form is a 404, not a 403', async ({ page }) => {
    const prisma = await getTestPrisma();
    await prisma.form.update({ where: { id: formId! }, data: { status: 'DRAFT' } });
    try {
      const response = await page.request.get(fillPath, { maxRedirects: 0 });
      // A 403 would confirm that a guessed slug names something real.
      expect(response.status()).toBe(404);
    } finally {
      await prisma.form.update({ where: { id: formId! }, data: { status: 'OPEN' } });
    }
  });

  test('a CLOSED form shows the closed state and refuses a POST', async ({ page }) => {
    const prisma = await getTestPrisma();
    await prisma.form.update({ where: { id: formId! }, data: { status: 'CLOSED' } });
    try {
      await page.goto(fillPath);
      await expect(page.getByRole('heading', { name: 'This form is closed' })).toBeVisible();
      // Friendly, and still says which form it is.
      await expect(page.getByText('ZZ E2E Waitlist')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Submit' })).toHaveCount(0);

      await page.request.post(fillPath, {
        maxRedirects: 0,
        headers: { 'content-type': 'application/json' },
        data: {
          answers: {},
          identity: { email: 'zz-e2e-closed@example.edu' },
          revisionId,
        },
      });
      expect(await responsesOf(formId!)).toHaveLength(0);
    } finally {
      await prisma.form.update({ where: { id: formId! }, data: { status: 'OPEN' } });
    }
  });

  test('a full cap closes the form, counting verified responses only', async ({ page }) => {
    const prisma = await getTestPrisma();
    await prisma.form.update({ where: { id: formId! }, data: { response_cap: 1 } });
    try {
      // An UNVERIFIED row must not close the form — it holds a uniqueness slot,
      // not a place in the queue.
      await prisma.formResponse.create({
        data: {
          form_id: formId!,
          revision_id: revisionId!,
          email: 'zz-e2e-pending@example.edu',
          email_normalized: 'zz-e2e-pending@example.edu',
          answers: {},
          submission_state: 'PENDING_VERIFICATION',
        },
      });
      await page.goto(fillPath);
      await expect(page.getByRole('button', { name: 'Submit' })).toBeVisible();

      // A verified one does.
      await prisma.formResponse.updateMany({
        where: { form_id: formId! },
        data: { submission_state: 'SUBMITTED', verified_at: new Date() },
      });
      await page.goto(fillPath);
      await expect(page.getByRole('heading', { name: 'This form is closed' })).toBeVisible();
    } finally {
      await prisma.form.update({ where: { id: formId! }, data: { response_cap: null } });
    }
  });

  test('a CLASSROOM form shows an interstitial and does not leak its title', async ({ page }) => {
    await page.goto(`/${CLASS}/forms/${CLASSROOM_FORM_SLUG}`);

    await expect(page.getByRole('heading', { name: /This form is for members of/ })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in →' })).toBeVisible();
    // The title is withheld on purpose: access is decided BEFORE anything about
    // the form is rendered, so a stranger learns nothing but that they need an
    // account.
    await expect(page.getByText('ZZ E2E Members Only')).toHaveCount(0);
  });

  /**
   * THE RENDER BACKSTOP for the roster leak.
   *
   * The write-side rule lives in `form.service.update` and is tested against a
   * real database in `forms.builderLifecycle.test.ts`. This is the second
   * layer, and it is the one that matters if a future write path forgets:
   * whatever produced it, a PUBLIC form serving a revision full of
   * `roster_select` options must not render.
   *
   * BOTH transports are checked. React Router serves a route twice — the
   * server-rendered document, and the `.data` payload a client-side navigation
   * fetches — and it is entirely possible to close one and leave the other
   * open, because they are produced by different code paths from the same
   * loader. The document is the one a human sees; `.data` is the one that is
   * trivially scriptable.
   */
  test('a PUBLIC form whose live revision holds a roster is a 404 on both transports', async ({
    page,
  }) => {
    for (const target of [leakPath, `${leakPath}.data`]) {
      const response = await page.request.get(target, { maxRedirects: 0 });
      expect(response.status(), `${target} must not render`).toBe(404);

      const body = await response.text();
      // Not just "the page did not render" — the roster is not in the bytes.
      expect(body).not.toContain(leakedLabel!);
      expect(body).not.toContain('roster_select');
    }
  });
});

// ─── The link itself ────────────────────────────────────────────────────────

test.describe('magic link', () => {
  test('an unknown token asks for a new link instead of failing', async ({ page }) => {
    await page.goto(`${verifyPath}?token=not-a-real-token`);
    await expect(page.getByRole('heading', { name: 'This link is not valid' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Request a new link' })).toBeVisible();
  });

  test('an expired token says so and points back at the form', async ({ page }) => {
    const email = 'zz-e2e-expired@example.edu';
    await page.goto(fillPath);
    await fillWaitlist(page, email, 'Expired');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

    const link = await readMagicLink(email);

    // Age the token past its TTL rather than waiting 48 hours for it.
    const prisma = await getTestPrisma();
    await prisma.formMagicToken.updateMany({
      where: { response: { form_id: formId! } },
      data: { expires_at: new Date(Date.now() - 1000) },
    });

    await page.goto(linkTarget(link));
    await expect(page.getByRole('heading', { name: 'This link has expired' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Request a new link' })).toBeVisible();
  });

  test('a link is single-use, and the spent link is neutral about why', async ({ page }) => {
    const email = 'zz-e2e-twice@example.edu';
    await page.goto(fillPath);
    await fillWaitlist(page, email, 'Twice');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

    const link = await readMagicLink(email);
    await page.goto(linkTarget(link));
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByRole('heading', { name: "You're in" })).toBeVisible();

    // Reopening the spent link says the LINK is used, never that the response
    // exists — whoever holds a stale link is not necessarily the person who
    // owns the mailbox.
    await page.goto(linkTarget(link));
    await expect(
      page.getByRole('heading', { name: 'This link has already been used' })
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Request a new link' })).toBeVisible();

    expect(await responsesOf(formId!)).toHaveLength(1);
  });

  test('the review page is never cached', async ({ page }) => {
    // It serves one person's answers to a bearer-token GET.
    const response = await page.request.get(`${verifyPath}?token=not-a-real-token`, {
      maxRedirects: 0,
    });
    expect(response.headers()['cache-control']).toBe('no-store');
  });
});

// ─── Caching ────────────────────────────────────────────────────────────────

test.describe('cache headers', () => {
  /**
   * The FILL page is never cached either, on either transport.
   *
   * On a CLASSROOM form this same route serves a member's identity, their
   * server-side draft, their submitted answers, and their teammates' names — at
   * a URL every member of the course shares. A cached copy is one student
   * holding another student's response.
   *
   * `.data` is asserted alongside the document because they are two different
   * responses built from one loader: `data(…, { headers })` covers only the
   * former, and only the route's `headers` export carries them onto the latter.
   * Testing one would not catch losing the other.
   */
  for (const [label, target] of [
    ['document', fillPath],
    ['single-fetch payload', `${fillPath}.data`],
  ] as const) {
    test(`the fill page is never cached (${label})`, async ({ page }) => {
      const response = await page.request.get(target, { maxRedirects: 0 });
      expect(response.status()).toBe(200);
      expect(response.headers()['cache-control']).toBe('no-store');
    });
  }
});

// ─── Drafts ─────────────────────────────────────────────────────────────────

test.describe('localStorage draft', () => {
  test('answers survive a reload, and are announced rather than silently restored', async ({
    page,
  }) => {
    await page.goto(fillPath);
    await page.getByLabel(NAME_LABEL, { exact: true }).fill('Half Finished');
    await page.getByLabel(LONG_LABEL, { exact: true }).fill('I got distracted.');

    // The autosave is debounced to a second; wait for it to land rather than
    // racing it.
    await expect
      .poll(async () =>
        page.evaluate(() => Object.keys(window.localStorage).some(key => key.startsWith('forms:')))
      )
      .toBe(true);

    await page.reload();

    await expect(page.getByLabel(NAME_LABEL, { exact: true })).toHaveValue('Half Finished');
    await expect(page.getByLabel(LONG_LABEL, { exact: true })).toHaveValue('I got distracted.');
    // Said out loud: text reappearing with no explanation reads as a bug.
    await expect(
      page.getByText('We restored the answers you started on this device')
    ).toBeVisible();
  });

  test('the draft is cleared once the response is confirmed', async ({ page }) => {
    const email = 'zz-e2e-draft@example.edu';
    await page.goto(fillPath);
    await fillWaitlist(page, email, 'Draft Clearer');

    await expect
      .poll(async () =>
        page.evaluate(() => Object.keys(window.localStorage).some(key => key.startsWith('forms:')))
      )
      .toBe(true);

    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

    // Still there: the submission is not the commitment, the click is. Someone
    // who never opens the email should find their answers waiting.
    expect(
      await page.evaluate(() =>
        Object.keys(window.localStorage).some(key => key.startsWith('forms:'))
      )
    ).toBe(true);

    await page.goto(linkTarget(await readMagicLink(email)));
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByRole('heading', { name: "You're in" })).toBeVisible();

    await expect
      .poll(async () =>
        page.evaluate(() => Object.keys(window.localStorage).some(key => key.startsWith('forms:')))
      )
      .toBe(false);
  });
});
