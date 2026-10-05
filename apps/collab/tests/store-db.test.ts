/**
 * `collab_docs` against a REAL Postgres: the store's SQL (editor stamps,
 * merges, the lost-checkpoint probe, the forced reseed) and the worker's
 * editor trim on top of it — the co-author bookkeeping end to end. Every
 * statement runs inside one transaction that is rolled back.
 *
 * Database: COLLAB_TEST_DATABASE_URL, else the devport's (`.dev-context`).
 * Skipped when neither is set or the database does not answer.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaCollabDocStore, type CollabDocDb } from '../src/store/prisma.ts';
import { trimEditors } from '../../../packages/tasks/src/helpers/contentCheckpointCore.ts';

function testDatabaseUrl(): string | null {
  if (process.env.COLLAB_TEST_DATABASE_URL) return process.env.COLLAB_TEST_DATABASE_URL;
  const context = path.resolve(import.meta.dirname, '../../../.dev-context');
  if (!existsSync(context)) return null;
  const match = /^- URL:\s+(postgres\S+)/m.exec(readFileSync(context, 'utf8'));
  return match?.[1] ?? null;
}

const url = testDatabaseUrl();
let prisma: PrismaClient | null = null;
let reachable = false;

beforeAll(async () => {
  if (!url) return;
  prisma = new PrismaClient({ datasourceUrl: url });
  try {
    await prisma.$queryRawUnsafe('SELECT 1 FROM "collab_docs" LIMIT 1');
    reachable = true;
  } catch {
    reachable = false;
  }
});

afterAll(async () => {
  await prisma?.$disconnect();
});

class Rollback extends Error {}

/** Run `fn` with a store bound to a transaction that is always rolled back. */
async function inRolledBackTx(
  fn: (store: PrismaCollabDocStore, tx: CollabDocDb) => Promise<void>
): Promise<void> {
  await prisma!
    .$transaction(
      async tx => {
        await fn(
          new PrismaCollabDocStore(tx as unknown as CollabDocDb),
          tx as unknown as CollabDocDb
        );
        throw new Rollback();
      },
      { timeout: 20_000 }
    )
    .catch(err => {
      if (!(err instanceof Rollback)) throw err;
    });
}

const KIND = 'page' as const;
const DOC = 'db-test-doc-00000000';
const CLASSROOM = 'db-test-classroom';
const state = new Uint8Array([1, 2, 3]);

describe.runIf(!!url)('collab_docs store (real Postgres, rolled back)', () => {
  it('stamps each editor with the version their edit was stored in; the trim drops only covered ones', async ({
    skip,
  }) => {
    if (!reachable) skip();
    await inRolledBackTx(async (store, tx) => {
      const base = {
        kind: KIND,
        docId: DOC,
        epoch: 1,
        classroomId: CLASSROOM,
        schemaVersion: 1,
        state,
      };
      expect(
        await store.store({ ...base, editors: [{ userId: 'u-ada', name: 'Ada' }] })
      ).toMatchObject({
        version: 1,
        pushed_version: 0,
      });
      await store.store({ ...base, editors: [{ userId: 'u-bob', name: 'Bob' }] });
      // Ada again, renamed: one entry, newest name and stamp, first-seen order.
      await store.store({ ...base, editors: [{ userId: 'u-ada', name: 'Ada L' }] });
      const raw = await tx.$queryRawUnsafe<{ editors: unknown }[]>(
        `SELECT "editors" FROM "collab_docs" WHERE "kind" = $1 AND "doc_id" = $2`,
        KIND,
        DOC
      );
      expect(raw[0].editors).toEqual([
        { userId: 'u-ada', name: 'Ada L', version: 3 },
        { userId: 'u-bob', name: 'Bob', version: 2 },
      ]);
      expect(await store.editorsForClassroom(CLASSROOM)).toEqual([
        {
          kind: KIND,
          docId: DOC,
          editors: [
            { userId: 'u-ada', name: 'Ada L' },
            { userId: 'u-bob', name: 'Bob' },
          ],
        },
      ]);

      // The worker pushed version 2 and credited both: Bob (v2) is covered,
      // Ada edited again in v3 and stays for the next commit.
      const row = (await store.get(KIND, DOC))!;
      await trimEditors(
        tx as never,
        { ...row, state: row.state, editors: row.editors } as never,
        ['u-ada', 'u-bob'],
        2
      );
      const after = await tx.$queryRawUnsafe<{ editors: unknown }[]>(
        `SELECT "editors" FROM "collab_docs" WHERE "kind" = $1 AND "doc_id" = $2`,
        KIND,
        DOC
      );
      expect(after[0].editors).toEqual([{ userId: 'u-ada', name: 'Ada L', version: 3 }]);

      // Save version by someone who did not type: stamped with the current version.
      await store.addEditors(KIND, DOC, [{ userId: 'u-cy', name: 'Cy' }]);
      await trimEditors(tx as never, row as never, ['u-ada', 'u-cy'], 3);
      const cleared = await tx.$queryRawUnsafe<{ editors: unknown }[]>(
        `SELECT "editors" FROM "collab_docs" WHERE "kind" = $1 AND "doc_id" = $2`,
        KIND,
        DOC
      );
      expect(cleared[0].editors).toBeNull();
    });
  });

  it('a store under a bumped epoch is refused; lostCheckpoint and forceReseed', async ({
    skip,
  }) => {
    if (!reachable) skip();
    await inRolledBackTx(async (store, tx) => {
      const base = {
        kind: KIND,
        docId: DOC,
        epoch: 1,
        classroomId: CLASSROOM,
        schemaVersion: 1,
        state,
      };
      await store.store(base);
      // Dirty since a moment ago: not lost for a 1-hour window, lost for a 0-ms one.
      expect(await store.lostCheckpoint(CLASSROOM, 60 * 60_000)).toBe(false);
      await tx.$executeRawUnsafe(
        `UPDATE "collab_docs" SET "dirty_since" = (now() AT TIME ZONE 'UTC') - interval '10 minutes'
         WHERE "kind" = $1 AND "doc_id" = $2`,
        KIND,
        DOC
      );
      expect(await store.lostCheckpoint(CLASSROOM, 5 * 60_000)).toBe(true);
      // A run visited it: not lost.
      await tx.$executeRawUnsafe(
        `UPDATE "collab_docs" SET "last_checkpoint_at" = (now() AT TIME ZONE 'UTC')
         WHERE "kind" = $1 AND "doc_id" = $2`,
        KIND,
        DOC
      );
      expect(await store.lostCheckpoint(CLASSROOM, 5 * 60_000)).toBe(false);

      expect(await store.markReseed(KIND, DOC)).toBeNull(); // dirty: never discarded
      expect(await store.forceReseed(KIND, DOC)).toEqual({ epoch: 2 });
      const row = (await store.get(KIND, DOC))!;
      expect(row).toMatchObject({ epoch: 2, version: 1, pushed_version: 1, dirty_since: null });
      expect(row.state.byteLength).toBe(0);
      expect(await store.store(base)).toBeNull(); // the old room's epoch
      await store.ping();
    });
  });
});
