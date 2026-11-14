/**
 * The duplicate-key checks on unique violations raised by the REAL client,
 * whichever Prisma is installed: each check must recognise a violation of its
 * own constraint (uniqueViolation.test.ts covers both versions' recorded
 * errors and what each check must NOT match).
 *
 * Builds its own git organization, classroom and rows, and removes them in
 * afterAll (the organizations cascade to everything else). Skipped unless
 * DATABASE_URL names a LOCAL, non-shared database.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import getPrisma from '@classmoji/database';
import { isClassroomSlugConflict } from '../classroomSlug.ts';
import { isFormSlugConflict } from '../form.service.ts';
import { isModuleItemDuplicate } from '../module.service.ts';
import { isPageSlugConflict } from '../page.service.ts';
import { isCustomDomainConflict, isSubdomainConflict } from '../site.service.ts';
import { isSlideSlugConflict } from '../../slides/slide.service.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

/** The error `write` throws (it must throw). */
async function failureOf(write: () => Promise<unknown>): Promise<unknown> {
  try {
    await write();
  } catch (error) {
    return error;
  }
  throw new Error('expected the write to fail with a unique violation');
}

describe.skipIf(!RUN)('duplicate-key checks on real unique violations (integration)', () => {
  const prisma = getPrisma();
  const tag = `uv-${randomUUID().slice(0, 8)}`;
  const ids = { orgs: [] as string[], user: '' };
  let classroomId = '';
  let otherClassroomId = '';
  let formId = '';
  let moduleId = '';

  beforeAll(async () => {
    const user = await prisma.user.create({ data: { email: `${tag}@example.test` } });
    ids.user = user.id;
    const [org, otherOrg] = await Promise.all(
      [tag, `${tag}-b`].map(login =>
        prisma.gitOrganization.create({ data: { provider: 'GITHUB', provider_id: login, login } })
      )
    );
    ids.orgs = [org.id, otherOrg.id];
    const classroom = (slug: string, gitOrgId: string) =>
      prisma.classroom.create({
        data: {
          slug,
          git_org_id: gitOrgId,
          name: slug,
          content_namespace: slug,
          content_repo: slug,
        },
      });
    classroomId = (await classroom(tag, org.id)).id;
    otherClassroomId = (await classroom(`${tag}-b`, otherOrg.id)).id;
    formId = (
      await prisma.form.create({
        data: { classroom_id: classroomId, title: 'f', slug: 'f', created_by: user.id },
      })
    ).id;
    await prisma.page.create({
      data: {
        classroom_id: classroomId,
        title: 'p',
        slug: 'p',
        content_path: 'pages/p',
        created_by: user.id,
      },
    });
    await prisma.slide.create({
      data: {
        classroom_id: classroomId,
        title: 's',
        slug: 's',
        content_path: 'slides/s',
        created_by: user.id,
      },
    });
    moduleId = (await prisma.module.create({ data: { classroom_id: classroomId, title: 'm' } })).id;
    await prisma.moduleItem.create({
      data: { module_id: moduleId, item_type: 'FORM', form_id: formId },
    });
    await prisma.classroomSite.create({
      data: { classroom_id: classroomId, subdomain: tag, custom_domain: `${tag}.example.test` },
    });
  });

  afterAll(async () => {
    if (ids.orgs.length)
      await prisma.gitOrganization.deleteMany({ where: { id: { in: ids.orgs } } });
    if (ids.user) await prisma.user.deleteMany({ where: { id: ids.user } });
  });

  it('classroom slug', async () => {
    const error = await failureOf(() =>
      prisma.classroom.create({
        data: {
          slug: tag,
          git_org_id: ids.orgs[1],
          name: 'x',
          content_namespace: `${tag}-c`,
          content_repo: `${tag}-c`,
        },
      })
    );
    expect(isClassroomSlugConflict(error)).toBe(true);
  });

  it('form slug', async () => {
    const error = await failureOf(() =>
      prisma.form.create({
        data: { classroom_id: classroomId, title: 'f2', slug: 'f', created_by: ids.user },
      })
    );
    expect(isFormSlugConflict(error)).toBe(true);
  });

  it('page slug', async () => {
    const error = await failureOf(() =>
      prisma.page.create({
        data: {
          classroom_id: classroomId,
          title: 'p2',
          slug: 'p',
          content_path: 'pages/p2',
          created_by: ids.user,
        },
      })
    );
    expect(isPageSlugConflict(error)).toBe(true);
  });

  it('slide slug', async () => {
    const error = await failureOf(() =>
      prisma.slide.create({
        data: {
          classroom_id: classroomId,
          title: 's2',
          slug: 's',
          content_path: 'slides/s2',
          created_by: ids.user,
        },
      })
    );
    expect(isSlideSlugConflict(error)).toBe(true);
  });

  it('module item', async () => {
    const error = await failureOf(() =>
      prisma.moduleItem.create({
        data: { module_id: moduleId, item_type: 'FORM', form_id: formId },
      })
    );
    expect(isModuleItemDuplicate(error)).toBe(true);
  });

  it('site subdomain and custom domain', async () => {
    const subdomain = await failureOf(() =>
      prisma.classroomSite.create({ data: { classroom_id: otherClassroomId, subdomain: tag } })
    );
    expect(isSubdomainConflict(subdomain)).toBe(true);
    expect(isCustomDomainConflict(subdomain)).toBe(false);
    const customDomain = await failureOf(() =>
      prisma.classroomSite.create({
        data: {
          classroom_id: otherClassroomId,
          subdomain: `${tag}-z`,
          custom_domain: `${tag}.example.test`,
        },
      })
    );
    expect(isCustomDomainConflict(customDomain)).toBe(true);
    expect(isSubdomainConflict(customDomain)).toBe(false);
  });
});
