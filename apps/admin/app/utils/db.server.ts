/**
 * Server-only data access.
 *
 * The `.server` suffix is what keeps PrismaClient out of the client bundle —
 * importing @classmoji/database or @classmoji/services from a module without it
 * pulls the driver into the browser build. Same pattern as pages/slides.
 */
import getPrisma from '@classmoji/database';

export const prisma = getPrisma();
export { requirePlatformAdmin } from '@classmoji/auth/server';
