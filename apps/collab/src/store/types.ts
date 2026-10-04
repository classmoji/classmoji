import type { CollabActor, CheckpointDocEditors, CollabKind } from '@classmoji/collab';

/**
 * One `collab_docs` row (Prisma `CollabDoc`). The live Yjs state of a page or
 * deck until the git worker has pushed it. Clean = `version === pushed_version`.
 *
 * A row whose `state` is EMPTY (zero bytes) is a reseed marker: an outside
 * push landed while the doc was neither open nor dirty, so the next open
 * seeds from git again — under the bumped `epoch`, so a browser still holding
 * the old room cannot sync stale content into the fresh seed. (Deleting the
 * row would reset the epoch to 1 and defeat that.)
 */
export interface CollabDocRow {
  kind: CollabKind;
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
  /** Co-authors since the last push (merged by stores; trimmed by the worker). */
  editors: CollabActor[];
  last_checkpoint_at: Date | null;
  last_checkpoint_error: string | null;
}

export interface NewCollabDoc {
  kind: CollabKind;
  doc_id: string;
  classroom_id: string;
  state: Uint8Array;
  schema_version: number;
  source_sha: string | null;
}

/** What a store returned: the row's counters after the write. */
export interface StoredVersion {
  version: number;
  pushed_version: number;
  epoch: number;
  classroom_id: string;
}

/**
 * Persistence for `collab_docs`. The Prisma implementation is
 * `PrismaCollabDocStore` (./prisma.ts); tests use an in-memory one.
 */
export interface CollabDocStore {
  get(kind: CollabKind, docId: string): Promise<CollabDocRow | null>;

  /**
   * Insert the seeded row unless one exists (`ON CONFLICT DO NOTHING`), then
   * re-read: whoever inserted first wins, and every caller seeds from the
   * winner's state. A reseed marker (empty state) is overwritten in place,
   * keeping its epoch.
   */
  insertSeed(row: NewCollabDoc): Promise<CollabDocRow>;

  /**
   * Write the full state: `version = version + 1`,
   * `dirty_since = coalesce(dirty_since, now())`. Only for `epoch` — a store
   * from a room whose epoch was bumped underneath it is refused (null).
   */
  store(args: {
    kind: CollabKind;
    docId: string;
    epoch: number;
    classroomId: string;
    schemaVersion: number;
    state: Uint8Array;
    /** Editors since the previous store, merged into `editors` (by userId). */
    editors?: CollabActor[];
  }): Promise<StoredVersion | null>;

  /** Merge editors into an existing row's `editors` (by userId; latest name wins). */
  addEditors(kind: CollabKind, docId: string, editors: CollabActor[]): Promise<void>;

  /**
   * Co-authors of every DIRTY doc of a classroom (version > pushed_version),
   * for the checkpoint payload.
   */
  editorsForClassroom(classroomId: string): Promise<CheckpointDocEditors[]>;

  /** Delete the row (the doc itself was deleted). */
  delete(kind: CollabKind, docId: string): Promise<void>;

  /**
   * Turn a CLEAN row (`version = pushed_version`) into a reseed marker:
   * epoch + 1, empty state. Null when there is no row or it is dirty — a
   * dirty row holds unpushed edits and is never discarded.
   */
  markReseed(kind: CollabKind, docId: string): Promise<{ epoch: number } | null>;

  /** `markReseed` for every clean, non-marker row of a classroom. */
  markReseedClassroom(
    classroomId: string
  ): Promise<{ kind: CollabKind; doc_id: string; epoch: number }[]>;

  /** Record the content-file blob sha the live doc now descends from. */
  setSourceSha(kind: CollabKind, docId: string, sourceSha: string | null): Promise<void>;
}

/** Epoch for a doc: the row's, or 1 when there is no row. */
export function currentEpoch(row: Pick<CollabDocRow, 'epoch'> | null): number {
  return row?.epoch ?? 1;
}

/** True when the row only marks "seed again from git". */
export function isReseedMarker(row: Pick<CollabDocRow, 'state'> | null): boolean {
  return !!row && row.state.byteLength === 0;
}
