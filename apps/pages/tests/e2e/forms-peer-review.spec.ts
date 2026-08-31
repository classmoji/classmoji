import { test, expect, type Page } from '@playwright/test';
import { parseFormDefinition } from '@classmoji/services/form-contract';

import {
  getClassroomIdBySlug,
  getTestClassroomSlug,
  getTestPrisma,
  getTestServices,
  loginAs,
  loginAsLogin,
  logout,
} from '../helpers';

/**
 * Team peer review, over real HTTP, with real sessions — the `repeat_group`
 * field end to end.
 *
 * ── What this file exists to prove ─────────────────────────────────────────
 * A peer review is the one thing this product collects where the CONFIDENTIALITY
 * is the feature. Everything else on a form is a person's own answer; here a
 * response is a set of statements about other students, and every one of these
 * has to hold:
 *
 *  1. the block resolves to the RIGHT people — a card per teammate, nobody else;
 *  2. a reviewer never sees another reviewer's answers, on the page or in the
 *     loader payload behind it;
 *  3. a crafted submit cannot file a review of somebody who is not a teammate —
 *     not a classmate, not a TA, not an arbitrary uuid;
 *  4. the five resolver states each produce their own page, and only SOLO_TEAM
 *     lets the form through;
 *  5. a team that changes mid-fill is handled in both directions — somebody
 *     joining stops the submit with a notice, somebody leaving keeps the review
 *     that was already written;
 *  6. staff, and only staff, can read the result — drawer and long CSV.
 *
 * ── The fixtures ───────────────────────────────────────────────────────────
 * Teams are created HERE. The seeded dev classroom has one untagged "Team
 * Alpha" and no tags at all, which is why every scope in this file is pointed
 * at a tag this file makes. Everything is namespaced `zz-e2e-team*` and removed
 * in afterAll; the seeded team and the demo form are never touched.
 *
 * Three students is the smallest set that can tell "my teammate" from "a
 * classmate who is not my teammate", which is the distinction test 3 turns on.
 */

const CLASS = getTestClassroomSlug();

const TRIO_SLUG = 'zz-e2e-team-review';
const PAIR_SLUG = 'zz-e2e-team-pair';
const SOLO_SLUG = 'zz-e2e-team-solo';
const UNTAGGED_SLUG = 'zz-e2e-team-untagged';
const AMBIGUOUS_SLUG = 'zz-e2e-team-ambiguous';
const ALL_SLUGS = [TRIO_SLUG, PAIR_SLUG, SOLO_SLUG, UNTAGGED_SLUG, AMBIGUOUS_SLUG];

const trioPath = `/${CLASS}/forms/${TRIO_SLUG}`;
const pairPath = `/${CLASS}/forms/${PAIR_SLUG}`;
const soloPath = `/${CLASS}/forms/${SOLO_SLUG}`;
const untaggedPath = `/${CLASS}/forms/${UNTAGGED_SLUG}`;
const ambiguousPath = `/${CLASS}/forms/${AMBIGUOUS_SLUG}`;

/** Fixed ids, so stored answers can be read back by name. */
const F = {
  own: 'dddddddd-dddd-4ddd-8ddd-dddddddddd01',
  group: 'dddddddd-dddd-4ddd-8ddd-dddddddddd02',
  rubric: 'dddddddd-dddd-4ddd-8ddd-dddddddddd03',
  comment: 'dddddddd-dddd-4ddd-8ddd-dddddddddd04',
} as const;

const ROW = {
  contribution: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01',
  communication: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02',
} as const;

const COL = {
  rarely: 'ffffffff-ffff-4fff-8fff-ffffffffff01',
  always: 'ffffffff-ffff-4fff-8fff-ffffffffff02',
} as const;

/** Seeded logins. Student 1 is the one `loginAs(page, 'student')` reaches. */
const S1 = 'fake-student-1';
const S2 = 'fake-student-2';
const S3 = 'fake-student-3';
const TA = 'fake-ta';

let classroomId = '';
const userIds: Record<string, string> = {};
const formIds: Record<string, string> = {};
const revisionIds: Record<string, string> = {};
let trioTeamId = '';
let pairATeamId = '';
let outsiderId = '';

// ─── Fixtures ───────────────────────────────────────────────────────────────

/**
 * The review block. A matrix and a comment inside the group is the CS98 shape,
 * and the matrix is the part that makes the inner name prefixing observable:
 * two teammates rated on the same rubric rows must not share a radio group.
 */
const reviewFields = (tagId: string) => [
  { id: F.own, type: 'long_text', label: 'How would you describe your own contribution?' },
  {
    id: F.group,
    type: 'repeat_group',
    label: 'Review each teammate',
    repeat: {
      over: 'teammates',
      scope: { by: 'tag', tag_id: tagId },
      require_all_targets: true,
    },
    fields: [
      {
        id: F.rubric,
        type: 'matrix',
        label: 'Rate this teammate',
        required: true,
        matrix: {
          rows: [
            { id: ROW.contribution, label: 'Contribution' },
            { id: ROW.communication, label: 'Communication' },
          ],
          columns: [
            { id: COL.rarely, label: 'Rarely' },
            { id: COL.always, label: 'Consistently' },
          ],
          required_rows: 'all',
        },
      },
      { id: F.comment, type: 'long_text', label: 'Anything else about working with them?' },
    ],
  },
];

async function ownerOf(id: string): Promise<string> {
  const prisma = await getTestPrisma();
  const owner = await prisma.classroomMembership.findFirst({
    where: { classroom_id: id, role: 'OWNER' },
    select: { user_id: true },
  });
  if (!owner) throw new Error(`no OWNER membership in ${id} — is the dev DB seeded?`);
  return owner.user_id;
}

async function makeForm(slug: string, title: string, fields: unknown[]) {
  const prisma = await getTestPrisma();
  const services = await getTestServices();
  const form = await prisma.form.create({
    data: {
      classroom_id: classroomId,
      title,
      slug,
      access: 'CLASSROOM',
      status: 'DRAFT',
      allow_multiple: true,
      created_by: await ownerOf(classroomId),
      draft_fields: parseFormDefinition(fields) as never,
    },
  });
  const { revision } = await services.form.publish(form.id);
  formIds[slug] = form.id;
  revisionIds[slug] = revision.id;
}

async function makeTag(name: string): Promise<string> {
  const prisma = await getTestPrisma();
  return (await prisma.tag.create({ data: { classroom_id: classroomId, name } })).id;
}

async function makeTeam(name: string, tagId: string, logins: string[]): Promise<string> {
  const prisma = await getTestPrisma();
  const team = await prisma.team.create({
    data: {
      classroom_id: classroomId,
      name,
      slug: name,
      memberships: { create: logins.map(login => ({ user_id: userIds[login] })) },
      tags: { create: [{ tag_id: tagId }] },
    },
  });
  return team.id;
}

test.beforeAll(async () => {
  const prisma = await getTestPrisma();
  classroomId = await getClassroomIdBySlug(CLASS);

  for (const login of [S1, S2, S3, TA]) {
    const user = await prisma.user.findFirst({ where: { login }, select: { id: true } });
    if (!user) throw new Error(`missing seeded user '${login}' — run npm run db:seed`);
    userIds[login] = user.id;
  }

  // Left over from an interrupted run. Teams and tags go first: a tag cannot be
  // deleted while a team still points at it.
  await prisma.form.deleteMany({ where: { classroom_id: classroomId, slug: { in: ALL_SLUGS } } });
  await prisma.team.deleteMany({
    where: { classroom_id: classroomId, slug: { startsWith: 'zz-e2e-team' } },
  });
  await prisma.tag.deleteMany({
    where: { classroom_id: classroomId, name: { startsWith: 'zz-e2e-team' } },
  });

  const trioTag = await makeTag('zz-e2e-team-trio-tag');
  const pairTag = await makeTag('zz-e2e-team-pair-tag');
  const soloTag = await makeTag('zz-e2e-team-solo-tag');
  // A tag with NO teams at all — every student is on a team, and none of them
  // is on THIS one, which is exactly TEAM_UNTAGGED.
  const emptyTag = await makeTag('zz-e2e-team-empty-tag');

  trioTeamId = await makeTeam('zz-e2e-team-trio', trioTag, [S1, S2, S3]);
  // Two pairs under one tag: student 3 is a classmate of students 1 and 2 and
  // not their teammate, which is the only fixture shape that can prove the
  // difference is enforced rather than merely intended.
  pairATeamId = await makeTeam('zz-e2e-team-pair-a', pairTag, [S1, S2]);
  await makeTeam('zz-e2e-team-pair-b', pairTag, [S3]);
  await makeTeam('zz-e2e-team-solo-one', soloTag, [S1]);

  await makeForm(TRIO_SLUG, 'ZZ E2E Team Review', reviewFields(trioTag));
  await makeForm(PAIR_SLUG, 'ZZ E2E Pair Review', reviewFields(pairTag));
  await makeForm(SOLO_SLUG, 'ZZ E2E Solo Review', reviewFields(soloTag));
  await makeForm(UNTAGGED_SLUG, 'ZZ E2E Untagged Review', reviewFields(emptyTag));

  // `by: classroom` — and every student is on several teams, so it is ambiguous
  // by construction rather than by a fixture nobody can see.
  const ambiguous = reviewFields(trioTag);
  (ambiguous[1] as { repeat: { scope: unknown } }).repeat.scope = { by: 'classroom' };
  await makeForm(AMBIGUOUS_SLUG, 'ZZ E2E Ambiguous Review', ambiguous);

  // A student in ANOTHER classroom — the strongest id to aim a tampered submit
  // at, because nothing about them is in this course at all.
  const otherClassroomId = await getClassroomIdBySlug('classmoji-other-class');
  outsiderId = (
    await prisma.classroomMembership.findFirstOrThrow({
      where: { classroom_id: otherClassroomId, role: 'STUDENT' },
      select: { user_id: true },
    })
  ).user_id;
});

test.afterAll(async () => {
  const prisma = await getTestPrisma();
  await prisma.form.deleteMany({ where: { classroom_id: classroomId, slug: { in: ALL_SLUGS } } });
  await prisma.team.deleteMany({
    where: { classroom_id: classroomId, slug: { startsWith: 'zz-e2e-team' } },
  });
  await prisma.tag.deleteMany({
    where: { classroom_id: classroomId, name: { startsWith: 'zz-e2e-team' } },
  });
});

test.beforeEach(async ({ page }) => {
  const prisma = await getTestPrisma();
  for (const slug of ALL_SLUGS) {
    if (formIds[slug]) await prisma.formResponse.deleteMany({ where: { form_id: formIds[slug] } });
  }
  await logout(page);
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Open a fill page and wait until it is actually interactive. */
async function openFill(page: Page, path: string) {
  await page.goto(path);
  if ((await page.locator('form[data-hydrated]').count()) > 0) {
    await expect(page.locator('form[data-hydrated="true"]')).toBeVisible();
  }
}

const cardFor = (page: Page, login: string) =>
  page.getByTestId(`review-card-${userIds[login]}`);

/** Open a teammate's card if it is collapsed. */
async function expandCard(page: Page, login: string) {
  const card = cardFor(page, login);
  const toggle = card.getByRole('button').first();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

/** Fill one teammate's whole review. */
async function reviewTeammate(page: Page, login: string, comment: string) {
  await expandCard(page, login);
  const card = cardFor(page, login);
  await card.getByLabel('Contribution: Consistently').check();
  await card.getByLabel('Communication: Consistently').check();
  await card.getByLabel('Anything else about working with them?').fill(comment);
}

async function responsesOf(slug: string) {
  const services = await getTestServices();
  return services.formResponse.listByFormId(formIds[slug]);
}

/** A complete answer set for the trio form, for the paths that post directly. */
const trioAnswers = (extra: Record<string, unknown> = {}) => ({
  [F.group]: {
    [userIds[S2]]: {
      [F.rubric]: { [ROW.contribution]: COL.always, [ROW.communication]: COL.always },
      [F.comment]: 'Fine',
    },
    [userIds[S3]]: {
      [F.rubric]: { [ROW.contribution]: COL.always, [ROW.communication]: COL.always },
      [F.comment]: 'Fine',
    },
    ...extra,
  },
});

const post = (page: Page, path: string, data: Record<string, unknown>) =>
  page.request.post(path, {
    maxRedirects: 0,
    headers: { 'content-type': 'application/json' },
    data,
  });

// ─── The block renders the right people ─────────────────────────────────────

test.describe('the review block', () => {
  test('shows one collapsible card per teammate and nobody else', async ({ page }) => {
    await loginAs(page, 'student');
    await openFill(page, trioPath);

    await expect(cardFor(page, S2)).toBeVisible();
    await expect(cardFor(page, S3)).toBeVisible();
    // Never yourself, and never somebody who is not on the team.
    await expect(cardFor(page, S1)).toHaveCount(0);
    await expect(cardFor(page, TA)).toHaveCount(0);

    await expect(page.getByTestId(`review-progress-${F.group}`)).toHaveText('0 of 2 reviewed');
  });

  test('a card collapses and re-expands with its answers intact', async ({ page }) => {
    await loginAs(page, 'student');
    await openFill(page, trioPath);

    await reviewTeammate(page, S2, 'Wrote most of the parser');
    const card = cardFor(page, S2);
    const toggle = card.getByRole('button').first();

    await toggle.click();
    await expect(card.getByLabel('Anything else about working with them?')).toHaveCount(0);
    await toggle.click();
    await expect(card.getByLabel('Anything else about working with them?')).toHaveValue(
      'Wrote most of the parser'
    );
  });

  test('the completion tick and the summary follow the inner required fields', async ({ page }) => {
    await loginAs(page, 'student');
    await openFill(page, trioPath);

    await expect(cardFor(page, S2)).toHaveAttribute('data-complete', 'false');
    await reviewTeammate(page, S2, 'Done');
    await expect(cardFor(page, S2)).toHaveAttribute('data-complete', 'true');
    await expect(page.getByTestId(`review-progress-${F.group}`)).toHaveText('1 of 2 reviewed');

    await reviewTeammate(page, S3, 'Also done');
    await expect(page.getByTestId(`review-progress-${F.group}`)).toHaveText('2 of 2 reviewed');
  });

  test('two cards keep separate matrix answers', async ({ page }) => {
    // The inner controls are the SAME definition rendered twice. Registered
    // under a name that did not include the target id they would share one
    // radio group, and rating one teammate would rate them all.
    await loginAs(page, 'student');
    await openFill(page, trioPath);

    await expandCard(page, S2);
    await expandCard(page, S3);
    await cardFor(page, S2).getByLabel('Contribution: Consistently').check();
    await cardFor(page, S3).getByLabel('Contribution: Rarely').check();

    await expect(cardFor(page, S2).getByLabel('Contribution: Consistently')).toBeChecked();
    await expect(cardFor(page, S3).getByLabel('Contribution: Consistently')).not.toBeChecked();
    await expect(cardFor(page, S3).getByLabel('Contribution: Rarely')).toBeChecked();
  });

  test('require_all_targets blocks a partial submit', async ({ page }) => {
    await loginAs(page, 'student');
    await openFill(page, trioPath);

    await reviewTeammate(page, S2, 'Only reviewed one of them');
    await page.getByRole('button', { name: 'Submit' }).click();

    // Nothing recorded, and the page says which card is missing rather than
    // failing silently somewhere below the fold.
    await expect(cardFor(page, S3).getByRole('alert').first()).toBeVisible();
    expect(await responsesOf(TRIO_SLUG)).toHaveLength(0);
  });

  test('a full set submits and stores answers keyed by teammate', async ({ page }) => {
    await loginAs(page, 'student');
    await openFill(page, trioPath);

    await page.getByLabel('How would you describe your own contribution?').fill('I did the API.');
    await reviewTeammate(page, S2, 'Carried the front end');
    await reviewTeammate(page, S3, 'Great in stand-up');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText('Response recorded.')).toBeVisible();

    const rows = await responsesOf(TRIO_SLUG);
    expect(rows).toHaveLength(1);
    const answers = rows[0].answers as Record<string, Record<string, Record<string, unknown>>>;
    expect(answers[F.own]).toBe('I did the API.');
    expect(Object.keys(answers[F.group]).sort()).toEqual([userIds[S2], userIds[S3]].sort());
    expect(answers[F.group][userIds[S2]][F.comment]).toBe('Carried the front end');
    expect(answers[F.group][userIds[S3]][F.comment]).toBe('Great in stand-up');

    // The snapshot carries the NAMES, so the review stays readable after a
    // roster change or an account deletion.
    const context = rows[0].resolved_context as {
      targets: Record<string, Array<{ user_id: string; name: string; removed: boolean }>>;
      groups: Record<string, { team_name: string }>;
    };
    expect(context.targets[F.group].map(target => target.name).sort()).toEqual([
      'Dev Student 2',
      'Dev Student 3',
    ]);
    expect(context.targets[F.group].every(target => target.removed === false)).toBe(true);
    expect(context.groups[F.group].team_name).toBe('zz-e2e-team-trio');
  });
});

// ─── The five states ────────────────────────────────────────────────────────

test.describe('resolver states', () => {
  test('a solo team gets the top-level fields and may still submit', async ({ page }) => {
    await loginAs(page, 'student');
    await openFill(page, soloPath);

    await expect(page.getByText('You are the only person on your team')).toBeVisible();
    await page.getByLabel('How would you describe your own contribution?').fill('Worked alone.');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText('Response recorded.')).toBeVisible();

    const rows = await responsesOf(SOLO_SLUG);
    expect(rows).toHaveLength(1);
    expect((rows[0].answers as Record<string, unknown>)[F.own]).toBe('Worked alone.');
  });

  test('no team at all replaces the form with its own explanation', async ({ page }) => {
    // The TA is a member of the course and on no team.
    await loginAs(page, 'ta');
    await openFill(page, trioPath);

    await expect(page.getByRole('heading', { name: /not on a team for this form yet/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Submit|Update/ })).toHaveCount(0);
    await expect(page.getByTestId(`review-group-${F.group}`)).toHaveCount(0);
  });

  test('a team set with none of your teams says so, and is not "no team"', async ({ page }) => {
    await loginAs(page, 'student');
    await openFill(page, untaggedPath);

    await expect(page.getByRole('heading', { name: /not pointed at your team/i })).toBeVisible();
    await expect(page.getByText(/not part of the team set/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Submit|Update/ })).toHaveCount(0);
  });

  test('more than one team names the collision instead of picking one', async ({ page }) => {
    await loginAs(page, 'student');
    await openFill(page, ambiguousPath);

    await expect(page.getByRole('heading', { name: /more than one team/i })).toBeVisible();
    await expect(page.getByText(/zz-e2e-team-trio/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Submit|Update/ })).toHaveCount(0);
  });

  test('a crafted submit against an unresolvable team records nothing', async ({ page }) => {
    await loginAs(page, 'ta');
    await page.goto(trioPath);

    const response = await post(page, trioPath, {
      intent: 'submit',
      answers: { [F.group]: {} },
      revisionId: revisionIds[TRIO_SLUG],
    });
    expect(response.ok()).toBe(true);
    expect(await responsesOf(TRIO_SLUG)).toHaveLength(0);
  });
});

// ─── Isolation and confidentiality ──────────────────────────────────────────

test.describe('isolation', () => {
  /** Student 1 reviews both teammates. The row nobody else may see. */
  async function studentOneReviews(page: Page) {
    await loginAs(page, 'student');
    await openFill(page, trioPath);
    await page.getByLabel('How would you describe your own contribution?').fill('I led the demo.');
    await reviewTeammate(page, S2, 'Student two was late twice');
    await reviewTeammate(page, S3, 'Student three carried us');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText('Response recorded.')).toBeVisible();
    const rows = await responsesOf(TRIO_SLUG);
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  test('a reviewee’s own fill page carries nothing the reviewer wrote', async ({ page }) => {
    await studentOneReviews(page);

    await loginAsLogin(page, S2);
    await openFill(page, trioPath);

    // Student 2 gets an empty form with cards for students 1 and 3.
    await expect(page.getByText('Response recorded.')).toHaveCount(0);
    await expect(cardFor(page, S1)).toBeVisible();
    await expect(cardFor(page, S3)).toBeVisible();
    await expect(page.getByTestId(`review-progress-${F.group}`)).toHaveText('0 of 2 reviewed');

    const html = await page.content();
    expect(html).not.toContain('Student two was late twice');
    expect(html).not.toContain('Student three carried us');
    expect(html).not.toContain('I led the demo.');
  });

  test('nor does the loader payload behind it', async ({ page }) => {
    const mine = await studentOneReviews(page);

    await loginAsLogin(page, S2);
    const single = await page.request.get(`${trioPath}.data`, { maxRedirects: 0 });
    const body = await single.text();
    expect(body).not.toContain('Student two was late twice');
    expect(body).not.toContain('Student three carried us');
    expect(body).not.toContain(mine.id);
    expect(body).not.toContain('student1@dev.local');
  });

  test.describe('a tampered submit cannot review a non-teammate', () => {
    test('not a classmate on a different team', async ({ page }) => {
      // On the PAIR form student 2's team is {1, 2}; student 3 is a classmate
      // on the other pair. This is the assertion the trio fixture cannot make.
      await loginAsLogin(page, S2);
      await openFill(page, pairPath);

      const response = await post(page, pairPath, {
        intent: 'submit',
        answers: {
          [F.group]: {
            [userIds[S1]]: {
              [F.rubric]: { [ROW.contribution]: COL.always, [ROW.communication]: COL.always },
              [F.comment]: 'Legitimate',
            },
            [userIds[S3]]: {
              [F.rubric]: { [ROW.contribution]: COL.rarely, [ROW.communication]: COL.rarely },
              [F.comment]: 'Not my teammate',
            },
          },
        },
        revisionId: revisionIds[PAIR_SLUG],
      });
      expect(response.ok()).toBe(true);
      expect(await responsesOf(PAIR_SLUG)).toHaveLength(0);
    });

    test('not a TA, an outsider, or an arbitrary uuid', async ({ page }) => {
      await loginAs(page, 'student');
      await openFill(page, trioPath);

      for (const stranger of [userIds[TA], outsiderId, '00000000-0000-4000-8000-000000000abc']) {
        const response = await post(page, trioPath, {
          intent: 'submit',
          answers: trioAnswers({
            [stranger]: {
              [F.rubric]: { [ROW.contribution]: COL.rarely, [ROW.communication]: COL.rarely },
              [F.comment]: 'Should not land',
            },
          }),
          revisionId: revisionIds[TRIO_SLUG],
        });
        expect(response.ok()).toBe(true);
        expect(await responsesOf(TRIO_SLUG)).toHaveLength(0);
      }
    });
  });

  test('a review is invisible to the person it is about, even after they answer', async ({
    page,
  }) => {
    await studentOneReviews(page);

    await loginAsLogin(page, S2);
    await openFill(page, trioPath);
    await reviewTeammate(page, S1, 'Student one was fine');
    await reviewTeammate(page, S3, 'Student three was fine');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText('Response recorded.')).toBeVisible();

    // Their own recorded response comes back — theirs, and only theirs.
    await openFill(page, trioPath);
    const html = await page.content();
    expect(html).toContain('Student one was fine');
    expect(html).not.toContain('Student two was late twice');
    expect(html).not.toContain('I led the demo.');
  });
});

// ─── A team that changes mid-fill ───────────────────────────────────────────

test.describe('the team changes while the form is open', () => {
  test('a new teammate stops the submit with a notice, not a validation error', async ({
    page,
  }) => {
    const prisma = await getTestPrisma();
    await loginAsLogin(page, S2);
    await openFill(page, pairPath);

    // Only student 1 to review, so far.
    await reviewTeammate(page, S1, 'Steady all term');
    await expect(page.getByTestId(`review-progress-${F.group}`)).toHaveText('1 of 1 reviewed');

    const joined = await prisma.teamMembership.create({
      data: { team_id: pairATeamId, user_id: userIds[S3] },
    });

    try {
      await page.getByRole('button', { name: 'Submit' }).click();

      await expect(page.getByTestId('forms-team-changed')).toBeVisible();
      expect(await responsesOf(PAIR_SLUG)).toHaveLength(0);

      // The loader re-resolved on revalidation, so the new person's card is
      // already on the page — and the work already done is still here.
      await expect(cardFor(page, S3)).toBeVisible();
      await expect(
        cardFor(page, S1).getByLabel('Anything else about working with them?')
      ).toHaveValue('Steady all term');

      /**
       * And the notice is RECOVERABLE, which is the only reason to prefer it to
       * a validation error.
       *
       * This leg exercises a card the renderer never seeded: the form is keyed
       * on the revision id, which did not change, so React kept the mounted
       * form and `defaultAnswers` never ran for the teammate who just appeared.
       * Reviewing them has to work anyway.
       */
      await reviewTeammate(page, S3, 'Joined late, caught up fast');
      await page.getByRole('button', { name: /^(Submit|Update)$/ }).click();
      await expect(page.getByText('Response recorded.')).toBeVisible();

      const rows = await responsesOf(PAIR_SLUG);
      expect(rows).toHaveLength(1);
      const answers = rows[0].answers as Record<string, Record<string, Record<string, unknown>>>;
      expect(answers[F.group][userIds[S1]][F.comment]).toBe('Steady all term');
      expect(answers[F.group][userIds[S3]][F.comment]).toBe('Joined late, caught up fast');
    } finally {
      await prisma.teamMembership.delete({ where: { id: joined.id } });
    }
  });

  test('a teammate who leaves keeps the review already written for them', async ({ page }) => {
    const prisma = await getTestPrisma();
    await loginAs(page, 'student');
    await openFill(page, trioPath);

    await reviewTeammate(page, S2, 'Reviewed before they left');
    await reviewTeammate(page, S3, 'Still on the team');
    // Wait for the server draft: it is the only record that student 2 was ever
    // a teammate, and therefore the only thing that keeps their review.
    await expect(page.getByTestId('forms-draft-status')).toHaveText('Draft saved', {
      timeout: 15_000,
    });

    const membership = await prisma.teamMembership.findFirstOrThrow({
      where: { team_id: trioTeamId, user_id: userIds[S2] },
    });
    await prisma.teamMembership.delete({ where: { id: membership.id } });

    try {
      await page.getByRole('button', { name: 'Submit' }).click();
      await expect(page.getByText('Response recorded.')).toBeVisible();

      const rows = await responsesOf(TRIO_SLUG);
      expect(rows).toHaveLength(1);
      const answers = rows[0].answers as Record<string, Record<string, Record<string, unknown>>>;
      expect(answers[F.group][userIds[S2]][F.comment]).toBe('Reviewed before they left');

      const context = rows[0].resolved_context as {
        targets: Record<string, Array<{ user_id: string; removed: boolean }>>;
      };
      const departed = context.targets[F.group].find(t => t.user_id === userIds[S2]);
      expect(departed?.removed).toBe(true);
    } finally {
      await prisma.teamMembership.create({
        data: { team_id: trioTeamId, user_id: userIds[S2] },
      });
    }
  });
});

// ─── What staff see ─────────────────────────────────────────────────────────

test.describe('the staff surfaces', () => {
  async function twoReviewsExist(page: Page) {
    await loginAs(page, 'student');
    await openFill(page, trioPath);
    await reviewTeammate(page, S2, 'Student one on student two');
    await reviewTeammate(page, S3, 'Student one on student three');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText('Response recorded.')).toBeVisible();
  }

  test('the response drawer shows a card per reviewee with the snapshotted name', async ({
    page,
  }) => {
    await twoReviewsExist(page);

    await logout(page);
    await loginAs(page, 'owner');
    await page.goto(`${trioPath}/responses`);
    await page.getByText('student1@dev.local').first().click();

    await expect(page.getByText('Student one on student two')).toBeVisible();
    await expect(page.getByText('Student one on student three')).toBeVisible();
    await expect(page.getByText('Dev Student 2').first()).toBeVisible();
  });

  test('the long CSV is one row per review, reviewer to reviewee', async ({ page }) => {
    await twoReviewsExist(page);

    await logout(page);
    await loginAs(page, 'owner');
    await page.goto(`${trioPath}/responses`);

    // The export is a resource route taking a native form POST, which is what
    // lets `Content-Disposition` reach the browser.
    const csv = await page.request
      .post(`${trioPath}/responses/export`, { maxRedirects: 0, form: { kind: 'long' } })
      .then(response => response.text());

    const lines = csv.trim().split('\n');
    expect(lines[0]).toContain('Reviewer');
    expect(lines[0]).toContain('Reviewee');
    // Exactly the two reviews written, and no row for the reviewer themselves.
    expect(lines).toHaveLength(3);
    expect(csv).toContain('Dev Student 2');
    expect(csv).toContain('Dev Student 3');
    expect(csv).toContain('Student one on student two');
    expect(csv).toContain('Student one on student three');
    expect(csv).toContain('On the team');
  });

  test('a student cannot reach the responses page', async ({ page }) => {
    await twoReviewsExist(page);

    await loginAsLogin(page, S2);
    const response = await page.request.get(`${trioPath}/responses`, { maxRedirects: 0 });
    expect(response.status()).toBeGreaterThanOrEqual(300);
    const body = await response.text();
    expect(body).not.toContain('Student one on student two');
  });
});
