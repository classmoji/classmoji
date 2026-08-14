import getPrisma from '@classmoji/database';
import type { ImportProgress } from '@classmoji/services/import-progress';
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

  // `progress` and `warnings` are Json columns; the writers (the create-classroom
  // action and the import task) are the single source of these shapes.
  const view: ImportJobView = {
    id: job.id,
    status: job.status as ImportJobStatusValue,
    phase: job.phase,
    progress: job.progress as unknown as ImportProgress,
    warnings: (job.warnings ?? []) as unknown as string[],
    error: job.error,
    updated_at: job.updated_at.toISOString(),
  };

  return Response.json(view);
};
