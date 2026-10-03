import { checkOrigin } from '~/utils/originCheck.server.ts';
import {
  requireAuth,
  assertClassroomAccess,
  assertClassroomMutationAllowed,
} from '@classmoji/auth/server';
import {
  mediaError,
  mediaErrorResponse,
  readJsonBody,
  requireMediaId,
  requireMethod,
} from '@classmoji/auth/media-http';
import {
  galleryRoleOf,
  isIdentityQuestion,
  GALLERY_IMAGE_MAX_BYTES,
  GALLERY_VIDEO_MAX_BYTES,
} from '@classmoji/services/form-contract';
import { ClassmojiService, prisma } from '~/utils/db.server.ts';
import { loadPublicForm } from './publicForm.server.ts';

/** Same multipart protocol as staff media, with an uploader + form + field boundary. */
export const action = async ({
  request,
  params,
}: {
  request: Request;
  params: Record<string, string | undefined>;
}) => {
  try {
    requireMethod(request, 'POST');
    if (!checkOrigin(request).ok) return mediaError('FORBIDDEN', 403);
    const { userId } = await requireAuth(request);
    const operation = params.operation ?? 'start';
    if (!['start', 'parts', 'complete', 'abort'].includes(operation))
      return mediaError('NOT_FOUND', 404);
    const { classroom, membership } = await assertClassroomAccess({
      request,
      classroomSlug: params.classroomSlug!,
      allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
      resourceType: 'FORMS',
      attemptedAction: 'upload_gallery_media',
    });
    // An abort releases a reservation even if the form closed during an upload.
    const form = await ClassmojiService.form.findBySlug(classroom.id, params.formSlug!);
    if (!form || form.access !== 'CLASSROOM') return mediaError('NOT_FOUND', 404);
    const id = operation === 'start' ? null : requireMediaId(params.mediaId);
    const row = id
      ? await prisma.mediaObject.findFirst({
          where: {
            id,
            classroom_id: classroom.id,
            uploaded_by: userId,
            gallery_form_id: form.id,
            gallery_field_id: params.fieldId,
          },
          select: { id: true },
        })
      : null;
    if (id && !row) return mediaError('NOT_FOUND', 404);
    if (operation === 'abort')
      return Response.json(
        await ClassmojiService.media.abortUpload({
          classroom,
          mediaId: id!,
          userId,
        })
      );

    if (!form.gallery_org_id) return mediaError('NOT_FOUND', 404);
    assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });
    const loaded = await loadPublicForm({
      request,
      classroomSlug: params.classroomSlug!,
      formSlug: params.formSlug!,
    });
    if (loaded.view !== 'classroom-fill' || loaded.mode === 'recorded') {
      return mediaError('BAD_STATE', 409, {
        message: 'This form is no longer accepting your project.',
      });
    }
    const field = loaded.fields.find(field => field.id === params.fieldId);
    const role = field && galleryRoleOf(field);
    if (!field || isIdentityQuestion(field) || !['cover', 'video'].includes(role ?? ''))
      return mediaError('NOT_FOUND', 404);
    const body = await readJsonBody(request);
    if (operation === 'start') {
      const filename = typeof body.filename === 'string' ? body.filename : '';
      const sizeBytes = typeof body.sizeBytes === 'number' ? body.sizeBytes : NaN;
      if (!filename || filename.length > 255 || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0)
        return mediaError('BAD_REQUEST', 400);
      const ext = filename.split('.').pop()?.toLowerCase();
      const accepted =
        role === 'cover' ? ['jpg', 'jpeg', 'png', 'gif', 'webp'] : ['mp4', 'mov', 'webm', 'm4v'];
      if (!ext || !accepted.includes(ext)) return mediaError('KIND_NOT_ALLOWED', 422);
      const kind = ClassmojiService.media.kindOfFilename(filename);
      if (kind !== (role === 'cover' ? 'IMAGE' : 'VIDEO'))
        return mediaError('KIND_NOT_ALLOWED', 422);
      const limit = role === 'cover' ? GALLERY_IMAGE_MAX_BYTES : GALLERY_VIDEO_MAX_BYTES;
      if (sizeBytes > limit)
        return mediaError('FILE_TOO_LARGE', 413, {
          message: `The limit is ${limit / 1_000_000} MB.`,
        });
      return Response.json(
        await ClassmojiService.media.createUpload({
          classroom,
          userId,
          filename,
          sizeBytes,
          gallery: { formId: form.id, fieldId: field.id },
          options: { explicit: true, optimise: true, keepOriginal: false, allowDownload: false },
        })
      );
    }
    if (operation === 'parts') {
      if (
        !Array.isArray(body.partNumbers) ||
        !body.partNumbers.length ||
        !body.partNumbers.every(n => Number.isSafeInteger(n) && n > 0)
      )
        return mediaError('BAD_REQUEST', 400);
      return Response.json(
        await ClassmojiService.media.signParts({
          classroom,
          mediaId: id!,
          partNumbers: body.partNumbers,
        })
      );
    }
    if (
      !Array.isArray(body.parts) ||
      !body.parts.length ||
      !body.parts.every(
        part =>
          part &&
          Number.isSafeInteger(part.partNumber) &&
          part.partNumber > 0 &&
          typeof part.etag === 'string'
      )
    )
      return mediaError('BAD_REQUEST', 400);
    return Response.json(
      await ClassmojiService.media.completeUpload({ classroom, mediaId: id!, parts: body.parts })
    );
  } catch (error) {
    return mediaErrorResponse(error);
  }
};
