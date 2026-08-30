import {
  buildLongCsv,
  buildWideCsv,
  csvFilename,
  csvResponse,
  type ExportableResponse,
} from './responsesCsv.server.ts';
import {
  auditResponses,
  loadResponseRows,
  requireFormForResponses,
  scopeResponseIds,
} from './responsesData.server.ts';

/**
 * The CSV export, as a resource route.
 *
 * A RESOURCE route (no default export) rather than an intent on the responses
 * action, for one reason: the response is an attachment. The router intercepts
 * a fetcher's response and the download would never reach the browser's
 * handling of `Content-Disposition`; a native form post to a route that renders
 * nothing gets out of the way and lets the browser do its job — while keeping
 * the work on the SERVER, which is what makes it auditable and `no-store`.
 *
 * The gate runs on both verbs. GET has no export of its own (a link that
 * exports would be pre-fetchable and would leak into browser history as a
 * download), but it still authenticates before answering 405 — a probe must not
 * learn from the status code whether a form exists.
 */

const GATE_ACTION = 'export_responses';

/** GET is not an export. Gated anyway; see the module note. */
export const loader = async ({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}) => {
  await requireFormForResponses(params.classroomSlug!, params.formSlug!, request, GATE_ACTION);
  return new Response('Use POST to export responses.', {
    status: 405,
    headers: { Allow: 'POST', 'Cache-Control': 'no-store' },
  });
};

export const action = async ({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}) => {
  const context = await requireFormForResponses(
    params.classroomSlug!,
    params.formSlug!,
    request,
    GATE_ACTION
  );

  const body = await request.formData();
  const kind = body.get('kind') === 'long' ? 'long' : 'wide';

  // An empty selection means "everything" — that is what the header button
  // sends. A non-empty one is narrowed to this form first, exactly as the
  // triage actions narrow theirs.
  const requested = body.getAll('responseId').map(String).filter(Boolean);
  const allowed =
    requested.length > 0 ? new Set(await scopeResponseIds(context.form.id, requested)) : null;

  const rows = await loadResponseRows(context.form.id);
  const chosen = allowed ? rows.filter(row => allowed.has(row.id)) : rows;

  const exportable: ExportableResponse[] = chosen.map(row => ({
    id: row.id,
    name: row.name,
    email: row.email,
    submitted_at: row.submittedAt,
    verified_at: row.verifiedAt,
    submission_state: row.submissionState,
    staff_status: row.staffStatus,
    staff_note: row.staffNote,
    answers: row.answers,
    resolved_context: row.resolvedContext,
  }));

  const csv =
    kind === 'long'
      ? buildLongCsv(context.currentFields, exportable)
      : buildWideCsv(context.currentFields, exportable);

  await auditResponses({
    context,
    tool: 'forms.responses.export',
    action: 'VIEW',
    data: { kind, count: exportable.length, selection: allowed ? allowed.size : null },
  });

  return csvResponse(
    csv,
    csvFilename(context.form.slug, kind === 'long' ? 'reviews' : 'responses')
  );
};
