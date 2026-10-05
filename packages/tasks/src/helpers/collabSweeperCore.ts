/**
 * collabSweeperCore.ts — the body of the `collab-sweeper` scheduled task
 * (every 30 minutes). Passes over `collab_docs`:
 *
 * 1. LOST TRIGGERS. A row dirty for longer than 2 × COLLAB_CHECKPOINT_MAX_DELAY
 *    that no checkpoint run has looked at since it became dirty (or whose last
 *    run failed transiently and is itself that old) gets its classroom's
 *    `content-checkpoint` re-triggered as a PLAIN run (no debounce key: a
 *    debounced run Trigger.dev left stuck in DELAYED would absorb it).
 * 2. REFUSALS THAT CLEARED. A row refused for `schema-mismatch` (collab and
 *    the worker on different deploys) is re-triggered once its schema
 *    version equals this worker's — retrying is what fixes it.
 * 3. ORPHANS. A row whose page/deck no longer exists (deleted without
 *    collab's `/close deleted`) is closed in collab (which drops the row),
 *    or deleted here when collab cannot be asked.
 * 4. STUCK ERRORS → THE RUN FAILS. Rows whose last checkpoint ended in an
 *    error and that have been dirty for over an hour — or that have had an
 *    outside edit pending for SWEEP_OUTSIDE_EDIT_ALERT_MS — are logged with
 *    their ids and then the run throws, so Trigger.dev's run-failure alerts
 *    fire. Everything else the sweep did has happened by then.
 * 5. AT-REST CLEANUP. Clean rows (`version = pushed_version`) untouched for 7
 *    days and not open in collab become reseed markers (empty state, epoch +
 *    1 — exactly collab's `markReseed`), so git is the only copy at rest. The
 *    bumped epoch is what makes a tab still holding the old room reload
 *    instead of syncing stale content into the next seed. A doc collab
 *    reports live, or a collab that cannot be asked, is left alone.
 *
 * SQL lives in `CollabSweeperDb` (`collabSweeperDb.ts`); this file is the
 * policy, unit-tested with a stub.
 */

/** The sweeper's schedule: every 30 minutes. */
export const COLLAB_SWEEPER_CRON = '*/30 * * * *';

export const SWEEP_IDLE_RESEED_MS = 7 * 24 * 60 * 60 * 1000;
export const SWEEP_ERROR_ALERT_MS = 60 * 60 * 1000;
/** An outside edit collab has not merged for this long is an alert. */
export const SWEEP_OUTSIDE_EDIT_ALERT_MS = 15 * 60 * 1000;
/** At most this many reseeds per sweep (each asks collab first). */
export const SWEEP_RESEED_LIMIT = 200;

export interface SweepDocRef {
  kind: string;
  doc_id: string;
  classroom_id: string;
}

export interface SweepErrorRow extends SweepDocRef {
  last_checkpoint_error: string;
  dirty_since: Date | null;
}

export interface CollabSweeperDb {
  /** Classrooms with a row dirty before `dirtyBefore` and no run on it since (or a transient failure before then). */
  lostTriggerClassrooms(dirtyBefore: Date): Promise<string[]>;
  /**
   * Dirty rows refused for `schema-mismatch` whose schema version now
   * equals the worker's for their kind.
   */
  clearedRefusals(schemaVersions: { page: number; deck: number }): Promise<SweepDocRef[]>;
  /** Rows whose page / deck no longer exists at all. */
  orphanRows(limit: number): Promise<SweepDocRef[]>;
  /** Delete one row (its doc is gone). */
  deleteRow(ref: SweepDocRef): Promise<void>;
  /**
   * Dirty rows with an error whose dirt predates `dirtyBefore`, or — for an
   * outside edit waiting on collab — predates `outsideBefore`.
   */
  erroringRows(dirtyBefore: Date, outsideBefore?: Date): Promise<SweepErrorRow[]>;
  /** Clean, non-empty rows last updated before `updatedBefore`. */
  idleCleanRows(updatedBefore: Date, limit: number): Promise<SweepDocRef[]>;
  /** Reseed one row if it is still clean, non-empty and idle; the new epoch, or null. */
  markReseed(ref: SweepDocRef, updatedBefore: Date): Promise<number | null>;
}

export interface CollabSweeperDeps {
  db: CollabSweeperDb;
  /** COLLAB_CHECKPOINT_DELAY / _MAX_DELAY as Trigger.dev duration strings. */
  delays: { delay: string; maxDelay: string };
  /** Re-trigger `content-checkpoint` for a classroom (a plain run, no debounce). */
  triggerCheckpoint(classroomId: string): Promise<void>;
  /** Whether collab has the doc open; null when collab cannot be asked. */
  isLive(ref: SweepDocRef): Promise<boolean | null>;
  /**
   * Collab `/close {reason: 'deleted'}` for a doc that is gone (closes the
   * room, drops the row). False when collab cannot be asked.
   */
  closeDeleted?(ref: SweepDocRef): Promise<boolean>;
  /** The worker's schema versions (refusals retried once a row matches). */
  schemaVersions?: { page: number; deck: number };
  now?: () => Date;
  log: {
    info(message: string, data?: Record<string, unknown>): void;
    warn(message: string, data?: Record<string, unknown>): void;
    error(message: string, data?: Record<string, unknown>): void;
  };
}

export interface CollabSweepReport {
  retriggered: string[];
  /** Classrooms re-triggered for refusals that cleared (schema versions agree now). */
  retriedRefusals: string[];
  /** Rows of docs that no longer exist, removed. */
  removedOrphans: Array<{ kind: string; docId: string }>;
  erroring: Array<{ kind: string; docId: string; classroomId: string; error: string }>;
  reseeded: Array<{ kind: string; docId: string; epoch: number }>;
  skippedLive: number;
  skippedUnknown: number;
}

/** `10s` / `4m` / `1h` / `2d` / `1w` → ms (collab's duration format). */
export function durationMs(value: string): number {
  const m = /^(\d+)([smhdw])$/.exec(value.trim());
  if (!m) throw new Error(`not a duration: ${value}`);
  const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[
    m[2] as 's' | 'm' | 'h' | 'd' | 'w'
  ];
  return Number(m[1]) * unit;
}

/** The collab server's checkpoint delays, with its defaults. */
export function checkpointDelays(env: NodeJS.ProcessEnv = process.env): {
  delay: string;
  maxDelay: string;
} {
  const production = env.NODE_ENV === 'production';
  const pick = (value: string | undefined, fallback: string) =>
    value?.trim() && /^\d+[smhdw]$/.test(value.trim()) ? value.trim() : fallback;
  return {
    delay: pick(env.COLLAB_CHECKPOINT_DELAY, production ? '1m' : '10s'),
    maxDelay: pick(env.COLLAB_CHECKPOINT_MAX_DELAY, production ? '4m' : '30s'),
  };
}

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runCollabSweep(deps: CollabSweeperDeps): Promise<CollabSweepReport> {
  const { db, log } = deps;
  const now = deps.now?.() ?? new Date();
  const report: CollabSweepReport = {
    retriggered: [],
    retriedRefusals: [],
    removedOrphans: [],
    erroring: [],
    reseeded: [],
    skippedLive: 0,
    skippedUnknown: 0,
  };

  // 1. Lost triggers.
  const stuckBefore = new Date(now.getTime() - 2 * durationMs(deps.delays.maxDelay));
  for (const classroomId of await db.lostTriggerClassrooms(stuckBefore)) {
    try {
      await deps.triggerCheckpoint(classroomId);
      report.retriggered.push(classroomId);
    } catch (error) {
      log.warn('collab-sweeper: re-trigger failed', { classroomId, error: errMessage(error) });
    }
  }
  if (report.retriggered.length) {
    log.warn('collab-sweeper: re-triggered checkpoints for dirty docs nobody pushed', {
      classrooms: report.retriggered,
    });
  }

  const keyOf = (r: { kind: string; doc_id: string }) => `${r.kind}:${r.doc_id}`;
  const handled = new Set<string>();

  // 2. Refusals that a retry now fixes (the deploys caught up).
  if (deps.schemaVersions) {
    const cleared = await db.clearedRefusals(deps.schemaVersions);
    for (const ref of cleared) handled.add(keyOf(ref));
    for (const classroomId of new Set(cleared.map(r => r.classroom_id))) {
      if (report.retriggered.includes(classroomId)) continue;
      try {
        await deps.triggerCheckpoint(classroomId);
        report.retriedRefusals.push(classroomId);
      } catch (error) {
        log.warn('collab-sweeper: refusal re-trigger failed', {
          classroomId,
          error: errMessage(error),
        });
      }
    }
    if (report.retriedRefusals.length) {
      log.info('collab-sweeper: retried schema-mismatch refusals (versions agree now)', {
        classrooms: report.retriedRefusals,
      });
    }
  }

  // 3. Orphans: the doc is gone.
  for (const ref of await db.orphanRows(SWEEP_RESEED_LIMIT)) {
    try {
      const closed = (await deps.closeDeleted?.(ref)) ?? false;
      if (!closed) await db.deleteRow(ref);
      report.removedOrphans.push({ kind: ref.kind, docId: ref.doc_id });
      handled.add(keyOf(ref));
    } catch (error) {
      log.warn('collab-sweeper: could not remove an orphan row', {
        kind: ref.kind,
        docId: ref.doc_id,
        error: errMessage(error),
      });
    }
  }
  if (report.removedOrphans.length) {
    log.warn('collab-sweeper: removed rows of deleted docs', { docs: report.removedOrphans });
  }

  // 4. Stuck errors: the alert (the run fails at the end).
  const erroring = await db.erroringRows(
    new Date(now.getTime() - SWEEP_ERROR_ALERT_MS),
    new Date(now.getTime() - SWEEP_OUTSIDE_EDIT_ALERT_MS)
  );
  report.erroring = erroring
    .filter(r => !handled.has(keyOf(r)))
    .map(r => ({
      kind: r.kind,
      docId: r.doc_id,
      classroomId: r.classroom_id,
      error: r.last_checkpoint_error,
    }));
  if (report.erroring.length) {
    log.error('collab-sweeper: live docs not saved to GitHub for over an hour', {
      count: report.erroring.length,
      docs: report.erroring.map(d => `${d.kind}:${d.docId} (${d.classroomId}): ${d.error}`),
    });
  }

  // 5. At-rest cleanup.
  const idleBefore = new Date(now.getTime() - SWEEP_IDLE_RESEED_MS);
  for (const ref of await db.idleCleanRows(idleBefore, SWEEP_RESEED_LIMIT)) {
    let live: boolean | null;
    try {
      live = await deps.isLive(ref);
    } catch {
      live = null;
    }
    if (live === true) {
      report.skippedLive++;
      continue;
    }
    if (live === null) {
      report.skippedUnknown++;
      continue;
    }
    const epoch = await db.markReseed(ref, idleBefore);
    if (epoch !== null) report.reseeded.push({ kind: ref.kind, docId: ref.doc_id, epoch });
  }

  log.info('collab-sweeper: done', {
    retriggered: report.retriggered.length,
    retriedRefusals: report.retriedRefusals.length,
    removedOrphans: report.removedOrphans.length,
    erroring: report.erroring.length,
    reseeded: report.reseeded.length,
    skippedLive: report.skippedLive,
    skippedUnknown: report.skippedUnknown,
  });
  if (report.erroring.length) throw new CollabSweepAlert(report);
  return report;
}

/**
 * Thrown at the end of a sweep that found stuck docs, so the run FAILS and
 * Trigger.dev's run-failure alert fires. The message lists them.
 */
export class CollabSweepAlert extends Error {
  readonly report: CollabSweepReport;
  constructor(report: CollabSweepReport) {
    const shown = report.erroring.slice(0, 20);
    super(
      `${report.erroring.length} live doc(s) not saved to GitHub: ` +
        shown
          .map(d => `${d.kind}:${d.docId} (classroom ${d.classroomId}) — ${d.error}`)
          .join('; ') +
        (report.erroring.length > shown.length
          ? `; and ${report.erroring.length - shown.length} more`
          : '')
    );
    this.name = 'CollabSweepAlert';
    this.report = report;
  }
}
