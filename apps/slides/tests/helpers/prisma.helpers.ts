import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
// Type-only import — erased at runtime. @classmoji/database constructs its
// PrismaClient eagerly at module import, so the runtime import MUST happen
// after DATABASE_URL is resolved (see getTestPrisma's dynamic import).
// Mirrors apps/pages/tests/helpers/prisma.helpers.ts.
import type getPrismaType from '@classmoji/database';
import { assertWritableDatabase } from '../../../../tests/content-delivery/databaseGuard';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Cached Prisma client for slides E2E DB assertions. Resolves the dev
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
  // Every suite that reaches the database goes through here, and several of
  // them write: sessions are minted, fixtures are created, classroom columns
  // are flipped. Which database that lands in is decided by whatever
  // DATABASE_URL happened to be exported — a value that is routinely pointed at
  // a deployed environment for an afternoon's debugging and not put back. The
  // guard is on the resolved host, so intent (E2E_TARGET, NODE_ENV) cannot vouch
  // for connectivity.
  assertWritableDatabase('open a test database connection');
  if (!cached) {
    const { default: getPrisma } = await import('@classmoji/database');
    cached = getPrisma();
  }
  return cached;
}

export interface SlideRow {
  id: string;
  title: string;
  slug: string;
  content_path: string;
  multiplex_id: string | null;
  is_public: boolean;
  is_draft: boolean;
  classroom_id: string;
}

/**
 * Fetch a slide row by id, or null if it doesn't exist.
 */
export async function getSlideById(slideId: string): Promise<SlideRow | null> {
  const prisma = await getTestPrisma();
  const slide = await prisma.slide.findUnique({
    where: { id: slideId },
    select: {
      id: true,
      title: true,
      slug: true,
      content_path: true,
      multiplex_id: true,
      is_public: true,
      is_draft: true,
      classroom_id: true,
    },
  });
  return slide as SlideRow | null;
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
    throw new Error(`Classroom '${slug}' not found. Run \`npm run db:seed\`.`);
  }
  return classroom.id;
}

/**
 * Ensure a slide has a shareable `multiplex_id` and return it. In production the
 * webapp sets this when an instructor enables sharing; the slides app only reads
 * it, so tests set it directly to exercise the share/follow path.
 */
export async function ensureSlideShareCode(slideId: string): Promise<string> {
  const prisma = await getTestPrisma();
  const existing = await getSlideById(slideId);
  if (existing?.multiplex_id) return existing.multiplex_id;

  const shareCode = `e2e-${slideId.slice(0, 8)}-${Date.now().toString(36)}`;
  await prisma.slide.update({
    where: { id: slideId },
    data: { multiplex_id: shareCode },
  });
  return shareCode;
}
