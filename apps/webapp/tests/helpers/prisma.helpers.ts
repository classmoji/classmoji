import getPrisma from '@classmoji/database';
import { getDevContext } from './env.helpers';

/**
 * Prisma client for test setup/teardown.
 * Uses DATABASE_URL from .dev-context if process.env.DATABASE_URL isn't already set.
 *
 * Tests should inject their own data through this client and clean up after themselves
 * rather than relying on whatever the seed left behind.
 */
let cached: ReturnType<typeof getPrisma> | null = null;

export function getTestPrisma(): ReturnType<typeof getPrisma> {
  if (!process.env.DATABASE_URL) {
    const ctx = getDevContext();
    if (ctx.databaseUrl) process.env.DATABASE_URL = ctx.databaseUrl;
  }
  if (!cached) {
    cached = getPrisma();
  }
  return cached;
}

/**
 * Find the User row matching a TestUser login. Throws if not present —
 * tests assume the configured GitHub user has been onboarded into the dev DB.
 */
export async function getUserByLogin(login: string): Promise<{ id: string; login: string }> {
  const prisma = getTestPrisma();
  const user = await prisma.user.findFirst({ where: { login } });
  if (!user) {
    throw new Error(
      `Test user '${login}' not found in database. Run \`npm run db:seed\` or sign in once.`
    );
  }
  return user;
}

/**
 * Find the Classroom row matching a slug. Throws if not present.
 */
export async function getClassroomBySlug(slug: string): Promise<{ id: string; slug: string; name: string }> {
  const prisma = getTestPrisma();
  const classroom = await prisma.classroom.findFirst({ where: { slug } });
  if (!classroom) {
    throw new Error(`Classroom '${slug}' not found. Run \`npm run db:seed\`.`);
  }
  return classroom;
}
