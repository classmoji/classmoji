/**
 * Project gallery services against a REAL Postgres: the org-wide query, the
 * approval filter, and the publish rule. Fixtures are namespaced with a fresh
 * uuid and removed by deleting the two git organizations (cascade).
 *
 * Skipped unless DATABASE_URL names a LOCAL database that is not the shared
 * `classmoji` one — the same guard as forms.integration.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import getPrisma from '@classmoji/database';
import * as formService from '../form.service.ts';
import * as responseService from '../formResponse.service.ts';
import * as galleryService from '../gallery.service.ts';
import { FORM_DEFINITION_INVALID } from '../formContract.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

const SHOWCASE = [
  { type: 'short_text', label: 'Project title', required: true, gallery_role: 'title' },
  { type: 'long_text', label: 'Summary', gallery_role: 'summary' },
];

describe.skipIf(!RUN)('project gallery (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  let orgA: string;
  let orgB: string;
  let olderClassroom: string;
  let newerClassroom: string;
  let otherOrgClassroom: string;
  let ownerId: string;
  const students: string[] = [];

  const makeUser = async (label: string) => {
    const user = await prisma.user.create({
      data: {
        accounts: {
          create: {
            provider_id: 'github',
            account_id: `gallerytest-${suite}-${label}`,
            username: `gallerytest-${suite}-${label}`,
          },
        },
        email: `gallerytest-${suite}-${label}@example.test`,
        name: `Gallery Test ${label}`,
      },
    });
    return user.id;
  };

  const makeClassroom = async (label: string, orgId: string, createdAt: Date) => {
    const classroom = await prisma.classroom.create({
      data: {
        slug: `gallerytest-${suite}-${label}`,
        git_org_id: orgId,
        name: `Term ${label} ${suite}`,
        content_namespace: `gallerytest-${suite}-${label}`,
        content_repo: `content-gallerytest-${suite}-${label}`,
        created_at: createdAt,
      },
    });
    return classroom.id;
  };

  /** A published gallery form, plus its two field ids. */
  const makeShowcase = async (classroomId: string) => {
    const form = await formService.create({
      classroomId,
      title: `Showcase ${suite} ${randomUUID().slice(0, 8)}`,
      access: 'CLASSROOM',
      createdBy: ownerId,
      fields: SHOWCASE,
    });
    await formService.setGalleryOrg(form.id, true);
    const { revision } = await formService.publish(form.id);
    const [titleId, summaryId] = formService.fieldsOf(revision.fields).map(field => field.id);
    return { formId: form.id, revisionId: revision.id, titleId, summaryId };
  };

  type Showcase = Awaited<ReturnType<typeof makeShowcase>>;

  /** Submit one project as a student; returns the response id. */
  const submitProject = async (form: Showcase, userId: string, title: string) => {
    const response = await responseService.submitClassroom({
      formId: form.formId,
      userId,
      email: `${userId}@example.test`,
      name: 'Student',
      answers: { [form.titleId]: title, [form.summaryId]: `${title} summary` },
      revisionId: form.revisionId,
    });
    return response.id;
  };

  const approve = async (form: Showcase, userId: string, title: string) => {
    const id = await submitProject(form, userId, title);
    await responseService.setGalleryStatus(id, 'APPROVED');
    return id;
  };

  beforeAll(async () => {
    const makeOrg = async (label: string) =>
      (
        await prisma.gitOrganization.create({
          data: {
            provider: 'GITHUB',
            provider_id: `gallerytest-${suite}-${label}`,
            login: `gallerytest-org-${suite}-${label}`,
          },
        })
      ).id;
    orgA = await makeOrg('a');
    orgB = await makeOrg('b');
    olderClassroom = await makeClassroom('older', orgA, new Date('2025-01-01T00:00:00Z'));
    newerClassroom = await makeClassroom('newer', orgA, new Date('2026-01-01T00:00:00Z'));
    otherOrgClassroom = await makeClassroom('other', orgB, new Date('2026-06-01T00:00:00Z'));
    ownerId = await makeUser('owner');
    for (const label of ['s0', 's1', 's2', 's3']) students.push(await makeUser(label));
  });

  afterAll(async () => {
    for (const id of [orgA, orgB]) {
      if (id) await prisma.gitOrganization.delete({ where: { id } }).catch(() => {});
    }
    await prisma.user
      .deleteMany({
        where: {
          accounts: {
            some: { provider_id: 'github', username: { startsWith: `gallerytest-${suite}-` } },
          },
        },
      })
      .catch(() => {});
  });

  it("setGalleryOrg sets the classroom's own org and clears it", async () => {
    const form = await formService.create({
      classroomId: olderClassroom,
      title: `Toggle ${suite}`,
      access: 'CLASSROOM',
      createdBy: ownerId,
      fields: SHOWCASE,
    });
    expect((await formService.setGalleryOrg(form.id, true)).gallery_org_id).toBe(orgA);
    expect((await formService.setGalleryOrg(form.id, false)).gallery_org_id).toBeNull();
  });

  it('the title rule holds at publish and when the gallery is switched on for a live form', async () => {
    const form = await formService.create({
      classroomId: olderClassroom,
      title: `No title ${suite}`,
      access: 'CLASSROOM',
      createdBy: ownerId,
      fields: [{ type: 'long_text', label: 'Summary', gallery_role: 'summary' }],
    });
    await formService.setGalleryOrg(form.id, true);
    expect(await codeOf(formService.publish(form.id))).toBe(FORM_DEFINITION_INVALID);

    await formService.setGalleryOrg(form.id, false);
    await expect(formService.publish(form.id)).resolves.toBeTruthy();

    // Now OPEN with no title role: switching the gallery on must check the
    // live revision, or its approved responses would go public untitled.
    expect(await codeOf(formService.setGalleryOrg(form.id, true))).toBe(FORM_DEFINITION_INVALID);
    expect(
      (await prisma.form.findUniqueOrThrow({ where: { id: form.id } })).gallery_org_id
    ).toBeNull();
  });

  // Uses org B so its APPROVED row never shows up in org A's listing below.
  it('a new response starts PENDING, and staff reads carry the status', async () => {
    const form = await makeShowcase(otherOrgClassroom);
    const id = await submitProject(form, students[3], 'Status check');
    expect((await prisma.formResponse.findUniqueOrThrow({ where: { id } })).gallery_status).toBe(
      'PENDING'
    );

    await responseService.setGalleryStatus(id, 'APPROVED');
    const [row] = await responseService.listByFormId(form.formId);
    expect(row.gallery_status).toBe('APPROVED');
  });

  // Order matters from here on: vitest runs these in file order, and the
  // listing test expects org A to hold only its own approvals.
  it('listForOrg: approved + submitted, across the org, newest term first', async () => {
    const older = await makeShowcase(olderClassroom);
    const newer = await makeShowcase(newerClassroom);
    const elsewhere = await makeShowcase(otherOrgClassroom);

    await approve(older, students[0], 'Zeta');
    await approve(older, students[1], 'Alpha');
    await approve(newer, students[0], 'Middle');
    await submitProject(newer, students[1], 'Still pending');
    const hidden = await submitProject(newer, students[2], 'Hidden one');
    await responseService.setGalleryStatus(hidden, 'HIDDEN');
    const drafted = await approve(newer, students[3], 'Was a draft');
    await prisma.formResponse.update({
      where: { id: drafted },
      data: { submission_state: 'DRAFT' },
    });
    await approve(elsewhere, students[0], 'Other org');

    const cards = await galleryService.listForOrg(orgA);
    expect(cards.map(card => card.title)).toEqual(['Middle', 'Alpha', 'Zeta']);
    expect(cards[0]).toMatchObject({
      term: `Term newer ${suite}`,
      classroomSlug: `gallerytest-${suite}-newer`,
      summary: 'Middle summary',
    });
  });

  it('getForOrg returns an approved project and null otherwise', async () => {
    const form = await makeShowcase(olderClassroom);
    const approved = await approve(form, students[2], 'Detail me');
    const pending = await submitProject(form, students[3], 'Not yet');

    const hidden = await approve(form, students[0], 'Hidden later');
    await responseService.setGalleryStatus(hidden, 'HIDDEN');
    const drafted = await approve(form, students[1], 'Drafted later');
    await prisma.formResponse.update({
      where: { id: drafted },
      data: { submission_state: 'DRAFT' },
    });

    const project = await galleryService.getForOrg(orgA, approved);
    expect(project).toMatchObject({ title: 'Detail me', summary: 'Detail me summary' });
    expect(await galleryService.getForOrg(orgA, pending)).toBeNull();
    expect(await galleryService.getForOrg(orgA, hidden)).toBeNull();
    expect(await galleryService.getForOrg(orgA, drafted)).toBeNull();
    expect(await galleryService.getForOrg(orgB, approved)).toBeNull();
    expect(await galleryService.getForOrg(orgA, randomUUID())).toBeNull();
  });

  // Changed answers need another staff review before publication.
  it('a student edit after approval returns to PENDING until reviewed', async () => {
    const form = await makeShowcase(newerClassroom);
    await formService.update(form.formId, { allow_multiple: true });
    const id = await approve(form, students[2], 'First title');

    expect(await submitProject(form, students[2], 'Second title')).toBe(id);
    expect((await prisma.formResponse.findUniqueOrThrow({ where: { id } })).gallery_status).toBe(
      'PENDING'
    );
    expect(await galleryService.getForOrg(orgA, id)).toBeNull();
    await responseService.setGalleryStatus(id, 'APPROVED');
    expect((await galleryService.getForOrg(orgA, id))?.title).toBe('Second title');
  });
});
