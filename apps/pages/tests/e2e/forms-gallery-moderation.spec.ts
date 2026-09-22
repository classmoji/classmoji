/**
 * Gallery moderation over real HTTP, against a real fixture: a STUDENT's
 * status change is refused and changes nothing, an ASSISTANT's is written,
 * the endpoint drops ids from other forms and 404s on a non-gallery form, and
 * the assistant queue page shows titles without respondent email.
 *
 * Needs a LOCAL database shared with the dev server (getTestPrisma refuses
 * anything else), so it runs in the Task 8 devport. Deleting the two fixture
 * forms cascades to their revisions and responses.
 */

import { test, expect, type Page } from '@playwright/test';
import {
  getClassroomIdBySlug,
  getPagesBaseURL,
  getTestClassroomSlug,
  getTestPrisma,
  loginAs,
} from '../helpers';

const CLASS = getTestClassroomSlug();
const GALLERY_SLUG = 'zz-e2e-gallery';
const PLAIN_SLUG = 'zz-e2e-gallery-off';
const TITLE_FIELD = '44444444-4444-4444-8444-444444444444';
const APPLICANT = 'zz-e2e-gallery@example.edu';

let galleryResponseId = '';
let plainResponseId = '';

const moderate = (page: Page, slug: string, responseIds: string[]) =>
  page.request.post(`/${CLASS}/forms/${slug}/responses/gallery`, {
    data: { responseIds, status: 'APPROVED' },
    headers: { origin: getPagesBaseURL() },
    maxRedirects: 0,
  });

const statusOf = async (id: string) =>
  (
    await (
      await getTestPrisma()
    ).formResponse.findUniqueOrThrow({
      where: { id },
      select: { gallery_status: true },
    })
  ).gallery_status;

const removeFixtures = async () => {
  const prisma = await getTestPrisma();
  const classroomId = await getClassroomIdBySlug(CLASS);
  await prisma.form.deleteMany({
    where: { classroom_id: classroomId, slug: { in: [GALLERY_SLUG, PLAIN_SLUG] } },
  });
};

test.beforeAll(async () => {
  const prisma = await getTestPrisma();
  const classroomId = await getClassroomIdBySlug(CLASS);
  const { git_org_id } = await prisma.classroom.findUniqueOrThrow({
    where: { id: classroomId },
    select: { git_org_id: true },
  });
  const owner = await prisma.classroomMembership.findFirst({
    where: { classroom_id: classroomId, role: 'OWNER' },
    select: { user_id: true },
  });
  if (!owner) throw new Error('no OWNER membership — is the dev database seeded?');
  await removeFixtures(); // left over from an interrupted run

  // One OPEN form with one SUBMITTED response. galleryOrgId null = not a gallery form.
  const makeForm = async (slug: string, galleryOrgId: string | null) => {
    const form = await prisma.form.create({
      data: {
        classroom_id: classroomId,
        title: slug,
        slug,
        access: 'PUBLIC',
        status: 'OPEN',
        created_by: owner.user_id,
        gallery_org_id: galleryOrgId,
      },
    });
    const revision = await prisma.formRevision.create({
      data: {
        form_id: form.id,
        version: 1,
        fields: {
          definition_version: 1,
          fields: [
            {
              id: TITLE_FIELD,
              type: 'short_text',
              label: 'Project title',
              required: true,
              gallery_role: 'title',
            },
          ],
        },
      },
    });
    await prisma.form.update({
      where: { id: form.id },
      data: { current_revision_id: revision.id },
    });
    const response = await prisma.formResponse.create({
      data: {
        form_id: form.id,
        revision_id: revision.id,
        email: APPLICANT,
        email_normalized: APPLICANT,
        answers: { [TITLE_FIELD]: 'ZZ Gallery Project' },
        submission_state: 'SUBMITTED',
        verified_at: new Date(),
      },
    });
    return response.id;
  };
  galleryResponseId = await makeForm(GALLERY_SLUG, git_org_id);
  plainResponseId = await makeForm(PLAIN_SLUG, null);
});

test.afterAll(removeFixtures);

// File order matters: the STUDENT runs first, while the row is still PENDING.
test.describe('gallery moderation', () => {
  test('a STUDENT is refused and the row is unchanged', async ({ page }) => {
    await loginAs(page, 'student');
    expect((await moderate(page, GALLERY_SLUG, [galleryResponseId])).status()).toBe(403);
    expect(await statusOf(galleryResponseId)).toBe('PENDING');
  });

  test('an ASSISTANT approves: 200, one row, APPROVED in the database', async ({ page }) => {
    await loginAs(page, 'ta');
    const response = await moderate(page, GALLERY_SLUG, [galleryResponseId]);
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ ok: true, updated: 1 });
    expect(await statusOf(galleryResponseId)).toBe('APPROVED');
  });

  test('an id from another form is dropped', async ({ page }) => {
    await loginAs(page, 'ta');
    const response = await moderate(page, GALLERY_SLUG, [plainResponseId]);
    expect(await response.json()).toEqual({ error: 'No matching responses.' });
    expect(await statusOf(plainResponseId)).toBe('PENDING');
  });

  test('a form that is not a gallery form is a 404', async ({ page }) => {
    await loginAs(page, 'ta');
    const response = await moderate(page, PLAIN_SLUG, [plainResponseId]);
    expect(response.status()).toBe(404);
    expect(await response.text()).toBe('Form not found');
  });

  test('an ASSISTANT gets the queue page: the title, never the email', async ({ page }) => {
    await loginAs(page, 'ta');
    const response = await page.request.get(`/${CLASS}/forms/${GALLERY_SLUG}/gallery`, {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(200);
    const html = await response.text();
    expect(html).toContain('ZZ Gallery Project');
    expect(html).not.toContain(APPLICANT);
  });
});
