/**
 * The `seed_empty_emoji_scales` migration (E10) against a REAL Postgres.
 *
 * Its SQL runs inside one transaction over fixtures made for this file, is
 * read back in the same transaction, and is rolled back by throwing at the
 * end: the statement reads every classroom, so nothing it writes for other
 * classrooms in the database may survive.
 *
 *   - a classroom with no rows gets exactly the rows `ensureDefaultScale`
 *     gives a new classroom (SCORE_EMOJI_MAPPINGS);
 *   - a classroom with any row is left exactly as it is;
 *   - running it twice inserts nothing more.
 *
 * Skipped unless DATABASE_URL names a LOCAL, non-shared database.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

const getPrisma = (await import('@classmoji/database')).default;
const { SCORE_EMOJI_MAPPINGS } = await import('@classmoji/utils');

const MIGRATION = fileURLToPath(
  new URL(
    '../../../../database/migrations/20261021224654_seed_empty_emoji_scales/migration.sql',
    import.meta.url
  )
);

class Rollback extends Error {}

describe.skipIf(!RUN)('seed_empty_emoji_scales migration (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  let orgId: string;
  let empty: string;
  let scaled: string;

  const makeClassroom = async (tag: string) =>
    (
      await prisma.classroom.create({
        data: {
          slug: `ses-${tag}-${suite}`,
          git_org_id: orgId,
          name: `SES ${tag} ${suite}`,
          content_namespace: `ses-${tag}-${suite}`,
          content_repo: `content-ses-${tag}-${suite}`,
        },
        select: { id: true },
      })
    ).id;

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: { provider: 'GITHUB', provider_id: `ses-${suite}`, login: `ses-org-${suite}` },
    });
    orgId = org.id;
    empty = await makeClassroom('empty');
    scaled = await makeClassroom('scaled');
    await prisma.emojiMapping.create({
      data: { classroom_id: scaled, emoji: 'star', grade: 95, description: 'mine' },
    });
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
  });

  it('seeds a classroom with no scale, leaves one with a scale alone, and is idempotent', async () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    const rowsOf = (tx: typeof prisma, classroomId: string) =>
      tx.emojiMapping.findMany({
        where: { classroom_id: classroomId },
        select: { emoji: true, grade: true, extra_tokens: true, description: true },
        orderBy: { grade: 'desc' },
      });

    let checked = false;
    await prisma
      .$transaction(async tx => {
        await tx.$executeRawUnsafe(sql);
        const seeded = await rowsOf(tx as typeof prisma, empty);
        expect(seeded).toEqual(
          SCORE_EMOJI_MAPPINGS.map(m => ({
            emoji: m.emoji,
            grade: m.grade,
            extra_tokens: m.extra_tokens,
            description: m.description,
          }))
        );
        expect(await rowsOf(tx as typeof prisma, scaled)).toEqual([
          { emoji: 'star', grade: 95, extra_tokens: 0, description: 'mine' },
        ]);

        // Again: nothing more.
        expect(await tx.$executeRawUnsafe(sql)).toBe(0);
        expect(await rowsOf(tx as typeof prisma, empty)).toHaveLength(SCORE_EMOJI_MAPPINGS.length);
        checked = true;
        throw new Rollback();
      })
      .catch(error => {
        if (!(error instanceof Rollback)) throw error;
      });
    expect(checked).toBe(true);
    // Rolled back: the fixture is as it was made.
    expect(await prisma.emojiMapping.count({ where: { classroom_id: empty } })).toBe(0);
  });
});
