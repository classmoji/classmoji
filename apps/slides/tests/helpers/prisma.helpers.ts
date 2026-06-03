import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import getPrisma from '@classmoji/database';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Cached Prisma client for slides E2E DB assertions. Resolves the dev
 * DATABASE_URL from `.dev-context` (mirroring env.helpers) when it isn't
 * already present in the environment.
 */

let cached: ReturnType<typeof getPrisma> | null = null;

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

export function getTestPrisma(): ReturnType<typeof getPrisma> {
  if (!process.env.DATABASE_URL) {
    const url = databaseUrlFromDevContext();
    if (url) process.env.DATABASE_URL = url;
  }
  if (!cached) {
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
  const prisma = getTestPrisma();
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
  const prisma = getTestPrisma();
  const classroom = await prisma.classroom.findFirst({
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
  const prisma = getTestPrisma();
  const existing = await getSlideById(slideId);
  if (existing?.multiplex_id) return existing.multiplex_id;

  const shareCode = `e2e-${slideId.slice(0, 8)}-${Date.now().toString(36)}`;
  await prisma.slide.update({
    where: { id: slideId },
    data: { multiplex_id: shareCode },
  });
  return shareCode;
}
