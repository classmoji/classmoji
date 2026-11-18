/**
 * The services' Prisma error checks on errors the generated client
 * (`@classmoji/database/client`) really throws: teamSet's `isDatabaseError`
 * (`instanceof` the namespace's error classes) and the unique-violation
 * reader every slug-collision check goes through. Their unit tests run on
 * captured errors; this proves the live ones are the same classes and shapes.
 *
 * Skipped unless DATABASE_URL names a LOCAL, non-shared database. Every row it
 * writes is removed.
 */
import { afterAll, describe, expect, it } from 'vitest';
import getPrisma from '@classmoji/database';
import { Prisma } from '@classmoji/database/client';
import { uniqueViolationTarget } from '../uniqueViolation.ts';
import { isClassroomSlugConflict } from '../classroomSlug.ts';
import { isDatabaseError } from '../teamSet.service.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

const USER_ID = `prisma-error-checks-${process.pid}`;

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe.skipIf(!RUN)('Prisma error checks on live errors', () => {
  const prisma = RUN ? getPrisma() : (undefined as never);

  afterAll(async () => {
    if (!RUN) return;
    await prisma.user.deleteMany({ where: { id: USER_ID } });
  });

  it('reads the constraint of a live unique violation, and no slug check claims it', async () => {
    await prisma.user.create({ data: { id: USER_ID, email: `${USER_ID}@x.test` } });
    const error = await failure(() =>
      prisma.user.create({ data: { id: `${USER_ID}-2`, email: `${USER_ID}@x.test` } })
    );
    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(uniqueViolationTarget(error)).toBe('users_email_key');
    expect(isClassroomSlugConflict(error)).toBe(false);
    expect(isDatabaseError(error)).toBe(true);
  });

  it('counts live known, unknown-shape and validation errors as database errors', async () => {
    const missing = await failure(() =>
      prisma.user.update({ where: { id: `${USER_ID}-missing` }, data: { name: 'x' } })
    );
    const raw = await failure(() => prisma.$queryRawUnsafe('SELECT * FROM no_such_table_here'));
    const invalid = await failure(() => prisma.user.findUnique({ where: { id: undefined } }));
    expect(missing).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(raw).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(invalid).toBeInstanceOf(Prisma.PrismaClientValidationError);
    for (const error of [missing, raw, invalid]) expect(isDatabaseError(error)).toBe(true);
    expect(isDatabaseError(new Error('a provider failure'))).toBe(false);
  });
});
