import type { GalleryStatus } from '@prisma/client';
import { requireClassroomTeachingTeam } from '@classmoji/auth/server';
import { ClassmojiService } from '~/utils/db.server.ts';
import { FORMS_RESOURCE, scopeResponseIds } from './responsesData.server.ts';

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
  const { userId, classroom, membership } = await requireClassroomTeachingTeam(
    request,
    params.classroomSlug!,
    { resourceType: FORMS_RESOURCE, action: 'moderate_gallery' }
  );

  // Resolved inside the authorized classroom; a non-gallery form is a 404 too.
  const form = await ClassmojiService.form.findBySlug(classroom.id, params.formSlug!);
  if (!form || !form.gallery_org_id) throw new Response('Form not found', { status: 404 });

  const body = (await request.json()) as { responseIds?: unknown; status?: unknown };
  if (typeof body.status !== 'string' || !STATUSES.has(body.status)) {
    return Response.json({ error: 'Unknown gallery status.' });
  }
  const status = body.status as GalleryStatus;
  const requested = Array.isArray(body.responseIds)
    ? body.responseIds.filter((id): id is string => typeof id === 'string').slice(0, MAX_BULK)
    : [];
  // Ids come from a browser; narrowing to this form keeps other forms' rows out.
  const ids = await scopeResponseIds(form.id, requested);
  if (ids.length === 0) return Response.json({ error: 'No matching responses.' });

  for (const responseId of ids) {
    await ClassmojiService.formResponse.setGalleryStatus(responseId, status);
    await ClassmojiService.audit.create({
      user_id: userId,
      classroom_id: classroom.id,
      role: membership!.role, // the teaching-team gate only admits members
      resource_type: FORMS_RESOURCE,
      resource_id: responseId,
      action: 'UPDATE',
      data: { tool: 'forms.responses.gallery_status', form_id: form.id, gallery_status: status },
    });
  }
  return Response.json({ ok: true, updated: ids.length });
};
