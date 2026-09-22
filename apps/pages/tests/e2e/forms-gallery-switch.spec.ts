/**
 * The project gallery switch is owner-only, over real HTTP. A TEACHER's
 * crafted save-meta POST is refused and changes nothing; a TEACHER-created
 * Showcase form is not a gallery form; the OWNER's POST turns it on for the
 * classroom's own org.
 *
 * Needs a LOCAL database shared with the dev server (getTestPrisma refuses
 * anything else), so it runs in the Task 8 devport.
 */

import { test, expect, type Page } from '@playwright/test';
import {
  clearMintedSessions,
  getClassroomIdBySlug,
  getPagesBaseURL,
  getTestClassroomSlug,
  getTestPrisma,
  loginAs,
  loginAsLogin,
} from '../helpers';

const CLASS = getTestClassroomSlug();
const FORM_SLUG = 'zz-e2e-gallery-switch';
const TEACHER_LOGIN = 'fake-teacher';
const TEACHER_TITLE = 'ZZ E2E Teacher Showcase';
const REFUSAL = 'Only the classroom owner can change the project gallery setting.';

let classroomId = '';
let gitOrgId = '';
let formId = '';

const post = (page: Page, path: string, data: Record<string, unknown>) =>
  page.request.post(path, { data, headers: { origin: getPagesBaseURL() }, maxRedirects: 0 });

// `.data` is the single-fetch URL the builder's fetcher posts to.
const saveMeta = (page: Page, gallery: boolean) =>
  post(page, `/${CLASS}/forms/${FORM_SLUG}/edit.data`, { intent: 'save-meta', gallery });

const galleryOrgOf = async (id: string) =>
  (
    await (
      await getTestPrisma()
    ).form.findUniqueOrThrow({
      where: { id },
      select: { gallery_org_id: true },
    })
  ).gallery_org_id;

const removeFixtures = async () =>
  (await getTestPrisma()).form.deleteMany({
    where: { classroom_id: classroomId, OR: [{ slug: FORM_SLUG }, { title: TEACHER_TITLE }] },
  });

test.beforeAll(async () => {
  const prisma = await getTestPrisma();
  classroomId = await getClassroomIdBySlug(CLASS);
  gitOrgId = (
    await prisma.classroom.findUniqueOrThrow({
      where: { id: classroomId },
      select: { git_org_id: true },
    })
  ).git_org_id;
  const owner = await prisma.classroomMembership.findFirst({
    where: { classroom_id: classroomId, role: 'OWNER' },
    select: { user_id: true },
  });
  if (!owner) throw new Error('no OWNER membership — is the dev database seeded?');
  await removeFixtures(); // left over from an interrupted run

  // A DRAFT form with no revision: save-meta needs nothing more.
  formId = (
    await prisma.form.create({
      data: {
        classroom_id: classroomId,
        title: FORM_SLUG,
        slug: FORM_SLUG,
        access: 'CLASSROOM',
        created_by: owner.user_id,
      },
    })
  ).id;
});

test.afterAll(async () => {
  await removeFixtures();
  await clearMintedSessions();
});

// File order matters: the OWNER runs last.
test('a TEACHER cannot turn the gallery on', async ({ page }) => {
  await loginAsLogin(page, TEACHER_LOGIN);
  const response = await saveMeta(page, true);
  expect(await response.text()).toContain(REFUSAL);
  expect(await galleryOrgOf(formId)).toBeNull();
});

test('a TEACHER-created Showcase form is not a gallery form', async ({ page }) => {
  await loginAsLogin(page, TEACHER_LOGIN);
  const response = await post(page, `/${CLASS}/forms/new`, {
    title: TEACHER_TITLE,
    preset: 'showcase',
  });
  expect(response.status()).toBe(302);
  const created = await (
    await getTestPrisma()
  ).form.findFirstOrThrow({
    where: { classroom_id: classroomId, title: TEACHER_TITLE },
    select: { gallery_org_id: true },
  });
  expect(created.gallery_org_id).toBeNull();
});

test("the OWNER turns it on, for the classroom's own org", async ({ page }) => {
  await loginAs(page, 'owner');
  await saveMeta(page, true);
  expect(await galleryOrgOf(formId)).toBe(gitOrgId);
});
