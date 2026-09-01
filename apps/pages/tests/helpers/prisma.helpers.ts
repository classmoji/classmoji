import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
// Type-only import — erased at runtime. @classmoji/database constructs its
// PrismaClient eagerly at module import, so the runtime import MUST happen
// after DATABASE_URL is resolved (see getTestPrisma's dynamic import).
import type getPrismaType from '@classmoji/database';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Cached Prisma client for pages E2E DB lookups. Resolves the dev
 * DATABASE_URL from `.dev-context` (mirroring env.helpers) when it isn't
 * already present in the environment.
 */

type TestPrisma = ReturnType<typeof getPrismaType>;

let cached: TestPrisma | null = null;

function databaseUrlFromDevContext(): string | null {
  try {
    const devContextPath = path.join(__dirname, '../../../../.dev-context');
    const content = fs.readFileSync(devContextPath, 'utf-8');
    const match = content.match(/URL:\s+(postgresql:\/\/\S+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export async function getTestPrisma(): Promise<TestPrisma> {
  if (!process.env.DATABASE_URL) {
    const url = databaseUrlFromDevContext();
    if (url) process.env.DATABASE_URL = url;
  }
  if (!cached) {
    const { default: getPrisma } = await import('@classmoji/database');
    cached = getPrisma();
  }
  return cached;
}

/**
 * The service layer, loaded the way `getTestPrisma` loads the client.
 *
 * `@classmoji/services` re-exports `@classmoji/database`, which constructs its
 * PrismaClient at module scope — so the dynamic import must happen AFTER
 * DATABASE_URL has been resolved from `.dev-context`. A static import at the
 * top of a spec would connect to whatever DATABASE_URL was set when Playwright
 * started, which on a devport is the wrong database.
 *
 * Use this when the assertion should go through the same function the app goes
 * through (`listByFormId` rather than a hand-written `findMany`): the point of
 * the check is then the service's behaviour, not the table's contents.
 */
export async function getTestServices() {
  await getTestPrisma();
  const { ClassmojiService } = await import('@classmoji/services');
  return ClassmojiService;
}

export interface PageRow {
  id: string;
  title: string;
  slug: string | null;
  content_path: string;
  is_public: boolean;
  is_draft: boolean;
  classroom_id: string;
}

/**
 * Resolve a classroom id from its slug. Throws if the classroom is missing so
 * tests fail loudly when the dev DB hasn't been seeded.
 */
export async function getClassroomIdBySlug(slug: string): Promise<string> {
  const prisma = await getTestPrisma();
  const classroom = await prisma.classroom.findUnique({
    where: { slug },
    select: { id: true },
  });
  if (!classroom) {
    throw new Error(
      `Classroom '${slug}' not found — is the dev database seeded? (npm run db:seed)`
    );
  }
  return classroom.id;
}

/**
 * Find a published page in the classroom that the given audience can view.
 * Returns null when none exists (tests should skip, not fail).
 */
export async function findViewablePage(
  classroomId: string,
  { publicOnly = false }: { publicOnly?: boolean } = {}
): Promise<PageRow | null> {
  const prisma = await getTestPrisma();
  const page = await prisma.page.findFirst({
    where: {
      classroom_id: classroomId,
      is_draft: false,
      ...(publicOnly ? { is_public: true } : {}),
    },
    select: {
      id: true,
      title: true,
      slug: true,
      content_path: true,
      is_public: true,
      is_draft: true,
      classroom_id: true,
    },
  });
  return page as PageRow | null;
}
