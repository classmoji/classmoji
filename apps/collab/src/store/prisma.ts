import getPrisma from '@classmoji/database';
import type { CollabKind } from '@classmoji/collab';

import type { CollabDocRow, CollabDocStore, NewCollabDoc, StoredVersion } from './types.ts';

/**
 * `collab_docs` through Prisma. Writes that need SQL Prisma's query API
 * can't express (`coalesce`, a conditional upsert) are raw; timestamps are
 * written as UTC because the columns are `TIMESTAMP(3)` without a zone, the
 * way Prisma writes them.
 */

const NOW_UTC = `(now() AT TIME ZONE 'UTC')`;

function toRow(row: {
  kind: string;
  doc_id: string;
  classroom_id: string;
  epoch: number;
  state: Uint8Array;
  schema_version: number;
  version: number;
  pushed_version: number;
  source_sha: string | null;
  pushed_commit: string | null;
  dirty_since: Date | null;
}): CollabDocRow {
  return {
    kind: row.kind as CollabKind,
    doc_id: row.doc_id,
    classroom_id: row.classroom_id,
    epoch: row.epoch,
    state: new Uint8Array(row.state),
    schema_version: row.schema_version,
    version: row.version,
    pushed_version: row.pushed_version,
    source_sha: row.source_sha,
    pushed_commit: row.pushed_commit,
    dirty_since: row.dirty_since,
  };
}

export class PrismaCollabDocStore implements CollabDocStore {
  async get(kind: CollabKind, docId: string): Promise<CollabDocRow | null> {
    const row = await getPrisma().collabDoc.findUnique({
      where: { kind_doc_id: { kind, doc_id: docId } },
    });
    return row ? toRow(row) : null;
  }

  async insertSeed(seed: NewCollabDoc): Promise<CollabDocRow> {
    // ON CONFLICT DO NOTHING — except over a reseed marker (empty state),
    // which the seed fills in place under the marker's (bumped) epoch.
    await getPrisma().$executeRawUnsafe(
      `INSERT INTO "collab_docs"
         ("kind", "doc_id", "classroom_id", "state", "schema_version", "source_sha", "updated_at")
       VALUES ($1, $2, $3, $4, $5, $6, ${NOW_UTC})
       ON CONFLICT ("kind", "doc_id") DO UPDATE SET
         "state" = EXCLUDED."state",
         "schema_version" = EXCLUDED."schema_version",
         "source_sha" = EXCLUDED."source_sha",
         "classroom_id" = EXCLUDED."classroom_id",
         "updated_at" = EXCLUDED."updated_at"
       WHERE octet_length("collab_docs"."state") = 0`,
      seed.kind,
      seed.doc_id,
      seed.classroom_id,
      Buffer.from(seed.state),
      seed.schema_version,
      seed.source_sha
    );
    const row = await this.get(seed.kind, seed.doc_id);
    if (!row)
      throw new Error(`collab_docs row for ${seed.kind}:${seed.doc_id} vanished after insert`);
    return row;
  }

  async store(args: {
    kind: CollabKind;
    docId: string;
    epoch: number;
    classroomId: string;
    schemaVersion: number;
    state: Uint8Array;
  }): Promise<StoredVersion | null> {
    const rows = await getPrisma().$queryRawUnsafe<StoredVersion[]>(
      `INSERT INTO "collab_docs"
         ("kind", "doc_id", "classroom_id", "epoch", "state", "schema_version",
          "version", "dirty_since", "updated_at")
       VALUES ($1, $2, $3, $4, $5, $6, 1, ${NOW_UTC}, ${NOW_UTC})
       ON CONFLICT ("kind", "doc_id") DO UPDATE SET
         "state" = EXCLUDED."state",
         "schema_version" = EXCLUDED."schema_version",
         "version" = "collab_docs"."version" + 1,
         "dirty_since" = coalesce("collab_docs"."dirty_since", EXCLUDED."dirty_since"),
         "updated_at" = EXCLUDED."updated_at"
       WHERE "collab_docs"."epoch" = EXCLUDED."epoch"
       RETURNING "version", "pushed_version", "epoch", "classroom_id"`,
      args.kind,
      args.docId,
      args.classroomId,
      args.epoch,
      Buffer.from(args.state),
      args.schemaVersion
    );
    return rows[0] ?? null;
  }

  async markReseed(kind: CollabKind, docId: string): Promise<{ epoch: number } | null> {
    const rows = await getPrisma().$queryRawUnsafe<{ epoch: number }[]>(
      `UPDATE "collab_docs" SET
         "epoch" = "epoch" + 1,
         "state" = ''::bytea,
         "dirty_since" = NULL,
         "updated_at" = ${NOW_UTC}
       WHERE "kind" = $1 AND "doc_id" = $2
       RETURNING "epoch"`,
      kind,
      docId
    );
    return rows[0] ?? null;
  }

  async setSourceSha(kind: CollabKind, docId: string, sourceSha: string | null): Promise<void> {
    await getPrisma().collabDoc.updateMany({
      where: { kind, doc_id: docId },
      data: { source_sha: sourceSha },
    });
  }
}
