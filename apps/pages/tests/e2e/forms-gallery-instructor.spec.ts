import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import {
  clearMintedSessions,
  getClassroomIdBySlug,
  getPagesBaseURL,
  getDevPort,
  getTestClassroomSlug,
  getTestPrisma,
  loginAsLogin,
} from '../helpers';

const CLASS = getTestClassroomSlug();
const SUFFIX = randomUUID().slice(0, 8);
const FORM_TITLE = `ZZ Instructor Gallery ${SUFFIX}`;
const PROJECT_TITLE = `ZZ Browser Project ${SUFFIX}`;
const LOGIN = `zz-gallery-instructor-${SUFFIX}`;
const STUDENT_NAME = `Gallery Student ${SUFFIX}`;
const SITE = process.env.GALLERY_SITE_URL?.replace(/\/projects\/?$/, '');
let userId = '',
  formId = '';

test.afterAll(async () => {
  await clearMintedSessions();
  const prisma = await getTestPrisma();
  await prisma.form.deleteMany({ where: { title: FORM_TITLE } });
  if (userId) await prisma.user.deleteMany({ where: { id: userId } });
});

test('an existing instructor creates, publishes and moderates a student project', async ({
  page,
}) => {
  test.setTimeout(180_000);
  if (!SITE)
    test.info().annotations.push({
      type: 'coverage',
      description: 'Set GALLERY_SITE_URL to include public site assertions.',
    });
  const prisma = await getTestPrisma();
  const classroomId = await getClassroomIdBySlug(CLASS);
  const owner = await prisma.classroomMembership.findFirstOrThrow({
    where: { classroom_id: classroomId, role: 'OWNER' },
    select: {
      user: {
        select: { accounts: { where: { provider_id: 'github' }, select: { username: true } } },
      },
    },
  });
  const user = await prisma.user.create({
    data: {
      name: STUDENT_NAME,
      email: `${LOGIN}@example.test`,
      accounts: { create: { provider_id: 'github', account_id: LOGIN, username: LOGIN } },
      classroom_memberships: {
        create: { classroom_id: classroomId, role: 'STUDENT', has_accepted_invite: true },
      },
    },
  });
  userId = user.id;

  await loginAsLogin(page, 'fake-teacher');
  const webapp = getDevPort('webapp') || 'http://localhost:3000';
  await page.goto(`${webapp}/teacher/${CLASS}/forms`);
  await page.getByRole('link', { name: 'New Form', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await page.getByRole('radio', { name: /^Project Showcase/ }).check();
  await expect(
    page.getByText(
      'Title, summary, team and links. The classroom owner must enable the org gallery before approved entries appear publicly.'
    )
  ).toBeVisible();
  await page.getByLabel('Title', { exact: true }).fill(FORM_TITLE);
  await page.getByRole('button', { name: 'Create form', exact: true }).click();
  await expect(page).toHaveURL(/\/edit$/);
  const editUrl = page.url();
  const form = await prisma.form.findFirstOrThrow({
    where: { classroom_id: classroomId, title: FORM_TITLE },
  });
  formId = form.id;
  expect(form.gallery_org_id).toBeNull();
  await expect(page.getByRole('checkbox', { name: 'Feed the org project gallery' })).toHaveCount(0);
  await expect(
    page.getByText(
      'Ask the classroom owner to enable the org project gallery before projects can appear publicly.'
    )
  ).toBeVisible();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Publish new version', exact: true })
  ).toBeVisible();

  await loginAsLogin(page, owner.user.accounts[0].username!);
  await page.goto(editUrl);
  await page.waitForLoadState('networkidle');
  const gallery = page.getByRole('checkbox', { name: 'Feed the org project gallery' });
  await gallery.click();
  await expect(gallery).toBeChecked();
  await expect
    .poll(
      async () => (await prisma.form.findUniqueOrThrow({ where: { id: formId } })).gallery_org_id
    )
    .not.toBeNull();
  await page.getByRole('checkbox', { name: 'Let one person submit more than once' }).check();
  await expect
    .poll(
      async () => (await prisma.form.findUniqueOrThrow({ where: { id: formId } })).allow_multiple
    )
    .toBe(true);

  const fillUrl = `${getPagesBaseURL()}/${CLASS}/forms/${form.slug}`;
  await loginAsLogin(page, LOGIN);
  await page.goto(fillUrl);
  await page.waitForLoadState('networkidle');
  await page.getByLabel('Project title', { exact: true }).fill(PROJECT_TITLE);
  await page.getByLabel('Summary', { exact: true }).fill('A fictional browser-tested project.');
  await page.getByRole('combobox', { name: 'Search Team members' }).fill(STUDENT_NAME);
  await page.getByRole('button', { name: new RegExp(STUDENT_NAME) }).click();
  await page.getByLabel('Deployed URL', { exact: true }).fill('https://example.test/demo');
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({
      path: test.info().outputPath(`student-project-${colorScheme}.png`),
      fullPage: true,
    });
  }
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByText('Response recorded.', { exact: true })).toBeVisible();
  const response = await prisma.formResponse.findFirstOrThrow({
    where: { form_id: formId, user_id: userId, submission_state: 'SUBMITTED' },
  });
  expect(response.gallery_status).toBe('PENDING');

  const publicProject = async (visible: boolean) => {
    if (!SITE) return;
    const publicPage = await page.context().newPage();
    try {
      await publicPage.goto(`${SITE}/projects?qa=${randomUUID()}`);
      const link = publicPage.getByRole('link', { name: new RegExp(PROJECT_TITLE) });
      if (visible) {
        await expect(link).toBeVisible();
        await link.click();
        await expect(
          publicPage.getByRole('heading', { name: PROJECT_TITLE, exact: true })
        ).toBeVisible();
        await expect(publicPage.locator('body')).not.toContainText(`${LOGIN}@example.test`);
        await expect(publicPage.getByRole('link', { name: 'Deployed URL ↗' })).toHaveAttribute(
          'href',
          'https://example.test/demo'
        );
      } else {
        await expect(link).toHaveCount(0);
        const result = await publicPage.goto(`${SITE}/projects/${response.id}?qa=${randomUUID()}`);
        expect(result?.status()).toBe(404);
      }
    } finally {
      await publicPage.close();
    }
  };
  await publicProject(false);
  await loginAsLogin(page, 'fake-teacher');
  await page.goto(`${fillUrl}/responses`);
  await page.waitForLoadState('networkidle');
  const row = page.getByRole('row').filter({ hasText: STUDENT_NAME });
  await row.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(row.getByText('approved', { exact: true })).toBeVisible();
  if (process.env.GALLERY_STAFF_BASE_URL) {
    const staffPage = await page.context().newPage();
    try {
      await staffPage.goto(
        `${process.env.GALLERY_STAFF_BASE_URL}/${CLASS}/forms/${form.slug}/responses`
      );
      const link = staffPage.getByRole('link', { name: 'View gallery', exact: true });
      await expect(link).toBeVisible();
      const [publicTab] = await Promise.all([page.context().waitForEvent('page'), link.click()]);
      await publicTab.waitForLoadState();
      await expect(publicTab.getByRole('link', { name: new RegExp(PROJECT_TITLE) })).toBeVisible();
      await publicTab.close();
    } finally {
      await staffPage.close();
    }
  }
  await publicProject(true);
  await page.goto(`${fillUrl}/gallery`);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('body')).not.toContainText(`${LOGIN}@example.test`);
  await page.getByRole('button', { name: 'Hide', exact: true }).click();
  await expect(page.getByText('hidden', { exact: true })).toBeVisible();
  await publicProject(false);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText('approved', { exact: true })).toBeVisible();

  await loginAsLogin(page, LOGIN);
  await page.goto(fillUrl);
  await page.waitForLoadState('networkidle');
  await page.getByLabel('Summary', { exact: true }).fill('Updated project needs fresh approval.');
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await prisma.formResponse.findUniqueOrThrow({ where: { id: response.id } })).gallery_status
    )
    .toBe('PENDING');
  await publicProject(false);

  await loginAsLogin(page, 'fake-teacher');
  await page.goto(`${webapp}/teacher/${CLASS}/forms`);
  await page.waitForLoadState('networkidle');
  const status = page.getByRole('combobox', { name: `Status of ${FORM_TITLE}` });
  await status.focus();
  await status.press('ArrowDown');
  await page.getByText('Closed', { exact: true }).last().click();
  await expect
    .poll(async () => (await prisma.form.findUniqueOrThrow({ where: { id: formId } })).status)
    .toBe('CLOSED');
  await loginAsLogin(page, LOGIN);
  await page.goto(fillUrl);
  await expect(page.getByText('Response recorded.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Update', exact: true })).toHaveCount(0);
  await loginAsLogin(page, 'fake-teacher');
  await page.goto(`${webapp}/teacher/${CLASS}/forms`);
  await page.waitForLoadState('networkidle');
  await status.focus();
  await status.press('ArrowDown');
  await page.getByText('Open', { exact: true }).last().click();
  await expect
    .poll(async () => (await prisma.form.findUniqueOrThrow({ where: { id: formId } })).status)
    .toBe('OPEN');
  await page.goto(`${fillUrl}/gallery`);
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText('approved', { exact: true })).toBeVisible();
  await page.goto(editUrl);
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Publish new version', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Publish new version', exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await prisma.form.findUniqueOrThrow({ where: { id: formId } })).current_revision_id
    )
    .not.toBe(response.revision_id);
  expect(
    (await prisma.formResponse.findUniqueOrThrow({ where: { id: response.id } })).revision_id
  ).toBe(response.revision_id);
  await publicProject(true);
});
