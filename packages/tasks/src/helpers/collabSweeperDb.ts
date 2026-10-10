/**
 * The SQL behind `collab-sweeper` (see collabSweeperCore.ts).
 *
 * `collab_docs` timestamps are `timestamp(3)` WITHOUT time zone holding UTC
 * (Prisma's convention, and collab's `(now() AT TIME ZONE 'UTC')`). Cutoffs
 * therefore go in as ISO strings converted the same way —
 * `$x::timestamptz AT TIME ZONE 'UTC'` — never as a bare parameter whose
 * meaning would depend on the session time zone.
 */

import type { CollabSweeperDb, SweepDocRef, SweepErrorRow } from './collabSweeperCore.ts';

interface RawClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

export function sqlSweeperDb(prisma: RawClient): CollabSweeperDb {
  return {
    async lostTriggerClassrooms(dirtyBefore) {
      const cutoff = dirtyBefore.toISOString();
      const rows = await prisma.$queryRaw<Array<{ classroom_id: string }>>`
        SELECT DISTINCT classroom_id FROM collab_docs
        WHERE version > pushed_version
          AND octet_length(state) > 0
          AND dirty_since < (${cutoff}::timestamptz AT TIME ZONE 'UTC')
          AND (
            last_checkpoint_at IS NULL
            OR last_checkpoint_at < dirty_since
            OR (last_checkpoint_error LIKE 'failed:%'
                AND last_checkpoint_at < (${cutoff}::timestamptz AT TIME ZONE 'UTC'))
          )`;
      return rows.map(r => r.classroom_id);
    },

    // Pages: the checkpoint renders any row at or below its schema (only a
    // newer one is refused), so an older refused row is retryable too. Decks
    // still refuse on any difference.
    async clearedRefusals({ page, deck }) {
      return prisma.$queryRaw<SweepDocRef[]>`
        SELECT kind, doc_id, classroom_id FROM collab_docs
        WHERE version > pushed_version
          AND octet_length(state) > 0
          AND last_checkpoint_error LIKE 'schema-mismatch:%'
          AND ((kind = 'page' AND schema_version <= ${page})
               OR (kind = 'deck' AND schema_version = ${deck}))
        LIMIT 500`;
    },

    async orphanRows(limit) {
      return prisma.$queryRaw<SweepDocRef[]>`
        SELECT d.kind, d.doc_id, d.classroom_id FROM collab_docs d
        WHERE (d.kind = 'page' AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = d.doc_id))
           OR (d.kind = 'deck' AND NOT EXISTS (SELECT 1 FROM slides s WHERE s.id = d.doc_id))
        LIMIT ${limit}`;
    },

    async deleteRow(ref) {
      await prisma.$queryRaw`
        DELETE FROM collab_docs WHERE kind = ${ref.kind} AND doc_id = ${ref.doc_id}
        RETURNING kind`;
    },

    async erroringRows(dirtyBefore, outsideBefore) {
      const cutoff = dirtyBefore.toISOString();
      const outsideCutoff = (outsideBefore ?? dirtyBefore).toISOString();
      return prisma.$queryRaw<SweepErrorRow[]>`
        SELECT kind, doc_id, classroom_id, last_checkpoint_error, dirty_since
        FROM collab_docs
        WHERE version > pushed_version
          AND last_checkpoint_error IS NOT NULL
          AND (dirty_since < (${cutoff}::timestamptz AT TIME ZONE 'UTC')
               OR (last_checkpoint_error LIKE 'outside-edit-pending:%'
                   AND dirty_since < (${outsideCutoff}::timestamptz AT TIME ZONE 'UTC')))
        ORDER BY dirty_since
        LIMIT 500`;
    },

    async idleCleanRows(updatedBefore, limit) {
      const cutoff = updatedBefore.toISOString();
      return prisma.$queryRaw<SweepDocRef[]>`
        SELECT kind, doc_id, classroom_id FROM collab_docs
        WHERE version = pushed_version
          AND octet_length(state) > 0
          AND updated_at < (${cutoff}::timestamptz AT TIME ZONE 'UTC')
        ORDER BY updated_at
        LIMIT ${limit}`;
    },

    async markReseed(ref, updatedBefore) {
      const cutoff = updatedBefore.toISOString();
      // collab's markReseed, plus the same idle/clean conditions re-checked in
      // the UPDATE itself, so a store that landed meanwhile wins.
      const rows = await prisma.$queryRaw<Array<{ epoch: number }>>`
        UPDATE collab_docs SET
          epoch = epoch + 1,
          state = ''::bytea,
          dirty_since = NULL,
          updated_at = (now() AT TIME ZONE 'UTC')
        WHERE kind = ${ref.kind} AND doc_id = ${ref.doc_id}
          AND version = pushed_version
          AND octet_length(state) > 0
          AND updated_at < (${cutoff}::timestamptz AT TIME ZONE 'UTC')
        RETURNING epoch`;
      return rows[0]?.epoch ?? null;
    },
  };
}
