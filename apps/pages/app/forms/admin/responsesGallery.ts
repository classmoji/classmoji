import { checkOrigin } from '~/utils/originCheck.server.ts';
import type { GalleryStatus } from '@prisma/client';
import { requireClassroomTeachingTeam } from '@classmoji/auth/server';
import { readJsonBody } from '@classmoji/auth/media-http';
import { ClassmojiService, prisma } from '~/utils/db.server.ts';
import { FORMS_RESOURCE } from './responsesData.server.ts';

/**
 * Approve / Hide for the org project gallery. A resource route (no component):
 * the responses page posts here with a fetcher.
 *
 * Gated on the TEACHING TEAM, not `assertFormAdmin`: moderation is TA work and
 * touches no PII (it returns a count). Deliberately no `formMutationBlocked`
 * and no Pro check — the gallery is cross-term, and hiding a project from a
 * locked or lapsed term must still work.
 */

const STATUSES = new Set<string>(['PENDING', 'APPROVED', 'HIDDEN']);
const MAX_BULK = 200;

export const action = async ({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}) => {
  if (!checkOrigin(request).ok)
    return Response.json({ error: 'Request refused.' }, { status: 403 });
  const { userId, classroom, membership } = await requireClassroomTeachingTeam(
    request,
    params.classroomSlug!,
    { resourceType: FORMS_RESOURCE, action: 'moderate_gallery' }
  );

  // Resolved inside the authorized classroom; a non-gallery form is a 404 too.
  const form = await ClassmojiService.form.findBySlug(classroom.id, params.formSlug!);
  if (!form || !form.gallery_org_id) throw new Response('Form not found', { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch {
    return Response.json({ error: 'Invalid or oversized request.' }, { status: 400 });
  }
  if (typeof body.status !== 'string' || !STATUSES.has(body.status)) {
    return Response.json({ error: 'Unknown gallery status.' }, { status: 400 });
  }
  const status = body.status as GalleryStatus;
  if (
    !Array.isArray(body.responseIds) ||
    body.responseIds.length > MAX_BULK ||
    !body.responseIds.every(
      id =>
        typeof id === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    )
  ) {
    return Response.json({ error: 'Choose up to 200 responses.' }, { status: 400 });
  }
  // The status write and its audit record commit together. Scope again under the lock.
  const updated = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM forms WHERE id = ${form.id} FOR UPDATE`;
    const rows = await tx.formResponse.findMany({
      where: {
        id: { in: body.responseIds as string[] },
        form_id: form.id,
        submission_state: 'SUBMITTED',
      },
      select: { id: true },
    });
    if (!rows.length) return 0;
    await tx.formResponse.updateMany({
      where: { id: { in: rows.map(row => row.id) }, form_id: form.id },
      data: { gallery_status: status },
    });
    await tx.auditLog.createMany({
      data: rows.map(row => ({
        user_id: userId,
        classroom_id: classroom.id,
        role: membership!.role,
        resource_type: FORMS_RESOURCE,
        resource_id: row.id,
        action: 'UPDATE' as const,
        data: { tool: 'forms.responses.gallery_status', form_id: form.id, gallery_status: status },
      })),
    });
    return rows.length;
  });
  return updated
    ? Response.json({ ok: true, updated })
    : Response.json({ error: 'No matching responses.' }, { status: 400 });
};
