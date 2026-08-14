import getPrisma from '@classmoji/database';
import {
  applyPhaseUpdates,
  IMPORT_PHASE_ORDER,
  type ImportProgress,
} from '@classmoji/services/import-progress';
import Tasks from '@classmoji/tasks';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
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

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const jobId = params.jobId!;

  const job = await getPrisma().importJob.findUnique({
    where: { id: jobId },
    include: { classroom: { select: { slug: true } } },
  });

  if (!job) {
    throw new Response('Not found', { status: 404 });
  }

  await requireClassroomAdmin(request, job.classroom.slug, {
    resourceType: 'IMPORT_JOB',
    action: 'view_import_job',
  });

  return Response.json(toView(job));
};

/**
 * POST /api/import-jobs/:jobId — retry a FAILED import.
 *
 * Resumes; it does not restart. Only the phases that actually FAILED go back to
 * `pending`; every phase already `done` keeps its status, and the orchestrator
 * skips those on the next run. That is what makes retrying safe when the
 * per-item creates are not idempotent — nothing already imported is touched.
 *
 * Refused for any status but FAILED: retrying a PENDING or RUNNING job would
 * put two workers on the same row, and a COMPLETED one has nothing to redo.
 *
 * Same admin gate as the read — a retry re-runs a copy out of the source
 * classroom, so it is at least as privileged as viewing the progress.
 */
export const action = async ({ params, request }: Route.ActionArgs) => {
  const jobId = params.jobId!;

  if (request.method !== 'POST') {
    throw new Response('Method not allowed', { status: 405 });
  }

  const job = await getPrisma().importJob.findUnique({
    where: { id: jobId },
    include: { classroom: { select: { slug: true } } },
  });

  if (!job) {
    throw new Response('Not found', { status: 404 });
  }

  await requireClassroomAdmin(request, job.classroom.slug, {
    resourceType: 'IMPORT_JOB',
    action: 'retry_import_job',
  });

  if (job.status !== 'FAILED') {
    return Response.json(
      { error: `Only a failed import can be retried (this one is ${job.status}).` },
      { status: 409 }
    );
  }

  const progress = job.progress as unknown as ImportProgress;
  const reset = applyPhaseUpdates(
    progress,
    IMPORT_PHASE_ORDER.filter(key => progress.phases?.[key]?.status === 'failed').map(phase => ({
      phase,
      status: 'pending' as const,
      note: null,
    }))
  );

  // PENDING before the trigger: if the trigger throws, the row is left claiming
  // a run that never started, which the caller sees and can retry again.
  const updated = await getPrisma().importJob.update({
    where: { id: job.id },
    data: {
      status: 'PENDING',
      error: null,
      progress: reset as unknown as object,
    },
    include: { classroom: { select: { slug: true } } },
  });

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
