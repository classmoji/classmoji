import getPrisma from '@classmoji/database';
import type { CheckpointDocEditors, CollabActor, CollabKind } from '@classmoji/collab';

import type { CollabDocRow, CollabDocStore, NewCollabDoc, StoredVersion } from './types.ts';

/**
 * `collab_docs` through Prisma. Writes that need SQL Prisma's query API
 * can't express (`coalesce`, a conditional upsert) are raw; timestamps are
 * written as UTC because the columns are `TIMESTAMP(3)` without a zone, the
 * way Prisma writes them.
 */

const NOW_UTC = `(now() AT TIME ZONE 'UTC')`;

/** A JSON `editors` value as actors (anything malformed dropped). */
export function actorsOf(value: unknown): CollabActor[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (e): e is CollabActor =>
        !!e && typeof e === 'object' && typeof (e as CollabActor).userId === 'string'
    )
    .map(e => ({ userId: e.userId, name: typeof e.name === 'string' ? e.name : '' }));
}

/**
 * SQL merging the JSONB actor list `$param` into "editors": one entry per
 * userId, the newest name wins, first-seen order kept.
 */
function mergeEditorsSql(param: string): string {
  return `(
    SELECT coalesce(jsonb_agg(m.x ORDER BY m.first_ord), '[]'::jsonb) FROM (
      SELECT DISTINCT ON (t.x->>'userId') t.x,
        min(t.ord) OVER (PARTITION BY t.x->>'userId') AS first_ord
      FROM jsonb_array_elements(coalesce("collab_docs"."editors", '[]'::jsonb) || ${param}::jsonb)
        WITH ORDINALITY AS t(x, ord)
      ORDER BY t.x->>'userId', t.ord DESC
    ) m
  )`;
}

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
  editors?: unknown;
  last_checkpoint_at?: Date | null;
  last_checkpoint_error?: string | null;
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
    editors: actorsOf(row.editors),
    last_checkpoint_at: row.last_checkpoint_at ?? null,
    last_checkpoint_error: row.last_checkpoint_error ?? null,
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
    editors?: CollabActor[];
  }): Promise<StoredVersion | null> {
    const rows = await getPrisma().$queryRawUnsafe<StoredVersion[]>(
      `INSERT INTO "collab_docs"
         ("kind", "doc_id", "classroom_id", "epoch", "state", "schema_version",
          "version", "dirty_since", "updated_at", "editors")
       VALUES ($1, $2, $3, $4, $5, $6, 1, ${NOW_UTC}, ${NOW_UTC}, $7::jsonb)
       ON CONFLICT ("kind", "doc_id") DO UPDATE SET
         "state" = EXCLUDED."state",
         "schema_version" = EXCLUDED."schema_version",
         "editors" = ${mergeEditorsSql('$7')},
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
      args.schemaVersion,
      JSON.stringify(args.editors ?? [])
    );
    return rows[0] ?? null;
  }

  async addEditors(kind: CollabKind, docId: string, editors: CollabActor[]): Promise<void> {
    if (editors.length === 0) return;
    await getPrisma().$executeRawUnsafe(
      `UPDATE "collab_docs" SET "editors" = ${mergeEditorsSql('$3')}
       WHERE "kind" = $1 AND "doc_id" = $2`,
      kind,
      docId,
      JSON.stringify(editors)
    );
  }

  async editorsForClassroom(classroomId: string): Promise<CheckpointDocEditors[]> {
    const rows = await getPrisma().$queryRawUnsafe<
      { kind: CollabKind; doc_id: string; editors: unknown }[]
    >(
      `SELECT "kind", "doc_id", "editors" FROM "collab_docs"
       WHERE "classroom_id" = $1 AND "version" > "pushed_version"
         AND "editors" IS NOT NULL AND jsonb_array_length("editors") > 0`,
      classroomId
    );
    return rows.map(r => ({ kind: r.kind, docId: r.doc_id, editors: actorsOf(r.editors) }));
  }

  async delete(kind: CollabKind, docId: string): Promise<void> {
    await getPrisma().collabDoc.deleteMany({ where: { kind, doc_id: docId } });
  }

  async markReseed(kind: CollabKind, docId: string): Promise<{ epoch: number } | null> {
    const rows = await getPrisma().$queryRawUnsafe<{ epoch: number }[]>(
      `UPDATE "collab_docs" SET
         "epoch" = "epoch" + 1,
         "state" = ''::bytea,
         "dirty_since" = NULL,
         "updated_at" = ${NOW_UTC}
       WHERE "kind" = $1 AND "doc_id" = $2 AND "version" = "pushed_version"
       RETURNING "epoch"`,
      kind,
      docId
    );
    return rows[0] ?? null;
  }

  async markReseedClassroom(
    classroomId: string
  ): Promise<{ kind: CollabKind; doc_id: string; epoch: number }[]> {
    return getPrisma().$queryRawUnsafe<{ kind: CollabKind; doc_id: string; epoch: number }[]>(
      `UPDATE "collab_docs" SET
         "epoch" = "epoch" + 1,
         "state" = ''::bytea,
         "dirty_since" = NULL,
         "updated_at" = ${NOW_UTC}
       WHERE "classroom_id" = $1
         AND "version" = "pushed_version"
         AND octet_length("state") > 0
       RETURNING "kind", "doc_id", "epoch"`,
      classroomId
    );
  }

  async setSourceSha(kind: CollabKind, docId: string, sourceSha: string | null): Promise<void> {
    await getPrisma().collabDoc.updateMany({
      where: { kind, doc_id: docId },
      data: { source_sha: sourceSha },
    });
  }
}
