import getPrisma from '@classmoji/database';
import {
  applyPhaseUpdates,
  IMPORT_PHASE_ORDER,
  type ImportProgress,
} from '@classmoji/services/import-progress';
import Tasks from '@classmoji/tasks';
import { assertClassroomAccess } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

/** Lifecycle of an `ImportJob` row (mirrors the `ImportJobStatus` enum). */
export type ImportJobStatusValue = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

/**
 * The ONLY fields this endpoint exposes. Deliberately narrower than the row:
 * `selections`, `requested_by` and `source_classroom_id` describe the request
 * and the source classroom, and nothing polling this needs them — so the
 * response is built field by field rather than spread, which is what stops a
 * later column being leaked by accident.
 */
export interface ImportJobView {
  id: string;
  status: ImportJobStatusValue;
  phase: string | null;
  progress: ImportProgress;
  warnings: string[];
  error: string | null;
  /** ISO 8601 — serialized here so the wire type is a string, not a Date. */
  updated_at: string;
}

/**
 * GET /api/import-jobs/:jobId
 *
 * Read-only poll target for a background classroom import.
 *
 * The job is loaded BEFORE any auth work because the classroom it belongs to is
 * what authorizes the read — a job id alone says nothing about who may see it.
 * An unknown id 404s without touching the auth path.
 */
/**
 * Row → wire shape. `progress` and `warnings` are Json columns; the writers
 * (the create-classroom action and the import task) are the single source of
 * these shapes.
 */
const toView = (job: {
  id: string;
  status: string;
  phase: string | null;
  progress: unknown;
  warnings: unknown;
  error: string | null;
  updated_at: Date;
}): ImportJobView => ({
  id: job.id,
  status: job.status as ImportJobStatusValue,
  phase: job.phase,
  progress: job.progress as ImportProgress,
  warnings: (job.warnings ?? []) as string[],
  error: job.error,
  updated_at: job.updated_at.toISOString(),
});

/**
 * A job still PENDING or RUNNING whose row has not moved for this long is dead.
 * The orchestrator records FAILED when it throws, but a crashed process or a
 * killed run never reaches that catch, and the row stays RUNNING forever. Every
 * phase writes progress as it goes (each item, each rate-limit wait), and no
 * single phase may run past an hour, so two quiet hours means nothing is
 * working on it any more.
 */
export const STALLED_AFTER_MS = 2 * 60 * 60 * 1000;

const STALLED_ERROR = 'The import stopped responding. Retry to resume it from where it stopped.';

export const isStalled = (job: { status: string; updated_at: Date }, now = Date.now()) =>
  (job.status === 'PENDING' || job.status === 'RUNNING') &&
  now - job.updated_at.getTime() > STALLED_AFTER_MS;

/** A stalled job reads as FAILED, so the banner offers Retry instead of polling forever. */
const viewOf = (job: Parameters<typeof toView>[0]): ImportJobView =>
  isStalled(job) ? { ...toView(job), status: 'FAILED', error: STALLED_ERROR } : toView(job);

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const jobId = params.jobId!;

  const job = await getPrisma().importJob.findUnique({ where: { id: jobId } });

  if (!job) {
    throw new Response('Not found', { status: 404 });
  }

  // The row's own `classroom_id` is the authorization key. Going through
  // `job.classroom.slug` had the auth layer resolve a classroom by slug a second
  // time, and nothing then proved that classroom is the one owning this job.
  await assertClassroomAccess({
    request,
    classroomId: job.classroom_id,
    allowedRoles: ['OWNER'],
    resourceType: 'IMPORT_JOB',
    attemptedAction: 'view_import_job',
  });

  return Response.json(viewOf(job));
};

/**
 * POST /api/import-jobs/:jobId — retry a FAILED import.
 *
 * Resumes; it does not restart. Only the phases that actually FAILED go back to
 * `pending`; every phase already `done` keeps its status, and the orchestrator
 * skips those on the next run. That is what makes retrying safe when the
 * per-item creates are not idempotent — nothing already imported is touched.
 *
 * Refused for any status but FAILED: retrying a live PENDING or RUNNING job
 * would put two workers on the same row, and a COMPLETED one has nothing to
 * redo. A stalled one (see `isStalled`) has no worker left, so it counts as
 * FAILED.
 *
 * Same admin gate as the read — a retry re-runs a copy out of the source
 * classroom, so it is at least as privileged as viewing the progress.
 */
export const action = async ({ params, request }: Route.ActionArgs) => {
  const jobId = params.jobId!;

  if (request.method !== 'POST') {
    throw new Response('Method not allowed', { status: 405 });
  }

  const job = await getPrisma().importJob.findUnique({ where: { id: jobId } });

  if (!job) {
    throw new Response('Not found', { status: 404 });
  }

  // Authorize on the row's `classroom_id` — see the loader.
  await assertClassroomAccess({
    request,
    classroomId: job.classroom_id,
    allowedRoles: ['OWNER'],
    resourceType: 'IMPORT_JOB',
    attemptedAction: 'retry_import_job',
  });

  const stalled = isStalled(job);
  if (job.status !== 'FAILED' && !stalled) {
    return Response.json(
      { error: `Only a failed import can be retried (this one is ${job.status}).` },
      { status: 409 }
    );
  }

  const progress = job.progress as unknown as ImportProgress;
  // A stalled run died mid-phase without marking it failed: its `running`
  // phases are the ones to redo.
  const reset = applyPhaseUpdates(
    progress,
    IMPORT_PHASE_ORDER.filter(key => {
      const status = progress.phases?.[key]?.status;
      return status === 'failed' || (stalled && status === 'running');
    }).map(phase => ({
      phase,
      status: 'pending' as const,
      note: null,
    }))
  );

  // Claim the row with `status: 'FAILED'` in the WHERE, not just the read above:
  // the import pipeline is not idempotent, and two POSTs arriving together would
  // both see FAILED and both trigger it. Exactly one `updateMany` can move the
  // row off FAILED, and only that one goes on to trigger.
  //
  // PENDING before the trigger: if the trigger throws, the row is left claiming
  // a run that never started, which the caller sees and can retry again.
  // A stalled job is claimed on the same `updated_at` the check read, so a run
  // that wakes up and writes in between keeps the row.
  const { count } = await getPrisma().importJob.updateMany({
    where: stalled
      ? { id: job.id, status: job.status, updated_at: job.updated_at }
      : { id: job.id, status: 'FAILED' },
    data: {
      status: 'PENDING',
      error: null,
      progress: reset as unknown as object,
    },
  });

  if (count !== 1) {
    return Response.json(
      { error: 'This import was already retried — poll for its current status.' },
      { status: 409 }
    );
  }

  const updated = await getPrisma().importJob.findUniqueOrThrow({ where: { id: job.id } });

  try {
    await Tasks.classroomImportTask.trigger({ importJobId: job.id });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Failed to re-trigger classroom import:', error);
    const failed = await getPrisma().importJob.update({
      where: { id: job.id },
      data: { status: 'FAILED', error: `Could not restart the import: ${message}` },
    });
    return Response.json(toView(failed), { status: 502 });
  }

  return Response.json(toView(updated));
};
