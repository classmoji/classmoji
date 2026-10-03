import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import {
  getClassroomIdBySlug,
  getPagesBaseURL,
  getTestClassroomSlug,
  getTestPrisma,
  loginAsLogin,
  clearMintedSessions,
} from '../helpers';

const CLASS = getTestClassroomSlug();
const SLUG = `zz-gallery-media-${randomUUID().slice(0, 8)}`;
const LOGIN = SLUG;
const title = randomUUID(),
  cover = randomUUID(),
  video = randomUUID(),
  mediaId = randomUUID();
let formId: string, classroomId: string, userId: string, revisionId: string;
const base = `/${CLASS}/forms/${SLUG}/media`;
const post = (page: Page, path: string, data: unknown, origin = getPagesBaseURL()) =>
  page.request.post(`${base}/${path}`, { data, headers: { origin }, maxRedirects: 0 });

test.beforeAll(async () => {
  const prisma = await getTestPrisma();
  classroomId = await getClassroomIdBySlug(CLASS);
  const classroom = await prisma.classroom.findUniqueOrThrow({ where: { id: classroomId } });
  const owner = await prisma.classroomMembership.findFirstOrThrow({
    where: { classroom_id: classroomId, role: 'OWNER' },
  });
  const user = await prisma.user.create({
    data: {
      name: 'Gallery Student',
      email: `${LOGIN}@example.test`,
      accounts: { create: { provider_id: 'github', account_id: LOGIN, username: LOGIN } },
    },
  });
  userId = user.id;
  await prisma.classroomMembership.create({
    data: {
      classroom_id: classroomId,
      user_id: userId,
      role: 'STUDENT',
      has_accepted_invite: true,
    },
  });
  const form = await prisma.form.create({
    data: {
      classroom_id: classroomId,
      created_by: owner.user_id,
      title: 'Gallery Media Check',
      slug: SLUG,
      access: 'CLASSROOM',
      status: 'OPEN',
      allow_multiple: true,
      gallery_org_id: classroom.git_org_id,
    },
  });
  formId = form.id;
  const revision = await prisma.formRevision.create({
    data: {
      form_id: formId,
      version: 1,
      fields: {
        definition_version: 1,
        fields: [
          {
            id: title,
            type: 'short_text',
            label: 'Project title',
            required: true,
            gallery_role: 'title',
          },
          { id: cover, type: 'short_text', label: 'Cover image', gallery_role: 'cover' },
          { id: video, type: 'short_text', label: 'Demo video', gallery_role: 'video' },
        ],
      },
    },
  });
  revisionId = revision.id;
  await prisma.form.update({ where: { id: formId }, data: { current_revision_id: revisionId } });
  // Fixture metadata only: no object is written to an R2 bucket.
  await prisma.mediaObject.create({
    data: {
      id: mediaId,
      classroom_id: classroomId,
      uploaded_by: userId,
      gallery_form_id: formId,
      gallery_field_id: cover,
      filename: 'cover.png',
      ext: 'png',
      content_type: 'image/png',
      kind: 'IMAGE',
      size_bytes: 10n,
      status: 'READY',
    },
  });
});

test.afterAll(async () => {
  await clearMintedSessions();
  const prisma = await getTestPrisma();
  await prisma.mediaObject.deleteMany({ where: { id: mediaId } });
  if (formId) await prisma.form.deleteMany({ where: { id: formId } });
  if (userId) await prisma.user.deleteMany({ where: { id: userId } });
});

test('anonymous uploads and cross-site uploads are refused', async ({ page }) => {
  expect([401, 302]).toContain(
    (await post(page, `${cover}/uploads`, { filename: 'a.png', sizeBytes: 10 })).status()
  );
  await loginAsLogin(page, LOGIN);
  expect(
    (
      await post(
        page,
        `${cover}/uploads`,
        { filename: 'a.png', sizeBytes: 10 },
        'https://evil.test'
      )
    ).status()
  ).toBe(403);
});

test('students cannot upload arbitrary files, oversized covers or into other fields', async ({
  page,
}) => {
  await loginAsLogin(page, LOGIN);
  for (const filename of ['a.html', 'a.svg', 'a.mp4']) {
    expect((await post(page, `${cover}/uploads`, { filename, sizeBytes: 10 })).status()).toBe(422);
  }
  expect(
    (await post(page, `${cover}/uploads`, { filename: 'a.png', sizeBytes: 20_000_001 })).status()
  ).toBe(413);
  expect(
    (await post(page, `${video}/uploads`, { filename: 'a.mp4', sizeBytes: 250_000_001 })).status()
  ).toBe(413);
  expect(
    (await post(page, `${title}/uploads`, { filename: 'a.png', sizeBytes: 10 })).status()
  ).toBe(404);
  expect(
    (await post(page, `${video}/uploads/${mediaId}/parts`, { partNumbers: [1] })).status()
  ).toBe(404);
});

test('a completed cover cannot be submitted as a video', async ({ page }) => {
  await loginAsLogin(page, LOGIN);
  const response = await page.request.post(`/${CLASS}/forms/${SLUG}`, {
    data: { revisionId, answers: { [title]: 'Forged video', [video]: `media://${mediaId}` } },
    headers: { origin: getPagesBaseURL() },
  });
  expect(await response.text()).toContain('Choose an upload you completed for this project field.');
  expect(
    await (
      await getTestPrisma()
    ).formResponse.count({ where: { form_id: formId, submission_state: 'SUBMITTED' } })
  ).toBe(0);
});

test('a closed form refuses new uploads', async ({ page }) => {
  const prisma = await getTestPrisma();
  await prisma.form.update({ where: { id: formId }, data: { status: 'CLOSED' } });
  try {
    await loginAsLogin(page, LOGIN);
    expect(
      (await post(page, `${cover}/uploads`, { filename: 'a.png', sizeBytes: 10 })).status()
    ).toBe(409);
  } finally {
    await prisma.form.update({ where: { id: formId }, data: { status: 'OPEN' } });
  }
});

test('cover uploads show progress, block submission and store a stable ref in light and dark modes', async ({
  page,
}) => {
  await loginAsLogin(page, LOGIN);
  await page.goto(`/${CLASS}/forms/${SLUG}`);
  // Run with the local media test configuration. Cloud requests are intercepted below.
  const file = page.locator('input[type=file]').first();
  await expect(file).toBeVisible();
  await expect(
    page.getByText(
      'Approved project answers and uploads may appear in the public gallery. Identity questions stay private.'
    )
  ).toBeVisible();
  await page.getByLabel('Project title', { exact: true }).fill('Gallery Upload Project');
  let release: () => void = () => {};
  const wait = new Promise<void>(resolve => {
    release = resolve;
  });
  await page.route(`**${base}/${cover}/uploads`, route =>
    route.fulfill({
      json: {
        mediaId,
        partSize: 32 * 1024 * 1024,
        partCount: 1,
      },
    })
  );
  await page.route(`**${base}/${cover}/uploads/${mediaId}/parts`, async route => {
    await wait;
    await route.fulfill({
      json: {
        urls: [
          {
            partNumber: 1,
            url: `${getPagesBaseURL()}/gallery-fake-part`,
            expiresAt: Date.now() + 3600_000,
          },
        ],
      },
    });
  });
  await page.route('**/gallery-fake-part', route =>
    route.fulfill({ status: 200, headers: { etag: 'fixture' } })
  );
  await page.route(`**${base}/${cover}/uploads/${mediaId}/complete`, route =>
    route.fulfill({ json: { mediaId, ref: `media://${mediaId}` } })
  );
  await file.setInputFiles({
    name: 'cover.png',
    mimeType: 'image/png',
    buffer: Buffer.from('test image'),
  });
  await expect(page.getByRole('progressbar', { name: 'Upload progress' })).toBeVisible();
  await expect(page.locator('button[type=submit]')).toBeDisabled();
  release();
  await expect(
    page.getByText('File uploaded. It will appear after your project is approved.')
  ).toBeVisible();
  for (const mode of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: mode });
    await page.screenshot({ path: `/tmp/classmoji-gallery-upload-${mode}.png`, fullPage: true });
  }
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          await (
            await getTestPrisma()
          ).formResponse.findFirst({
            where: { form_id: formId, user_id: userId },
            select: { answers: true },
          })
        )?.answers
    )
    .toMatchObject({ [cover]: `media://${mediaId}` });
});
