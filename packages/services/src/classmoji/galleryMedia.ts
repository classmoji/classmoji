import getPrisma from '@classmoji/database';
import type { Prisma } from '@prisma/client';
import {
  FORM_ANSWERS_INVALID,
  formContractError,
  galleryRoleOf,
  type FormField,
} from './formContract.ts';
import { parseMediaRef, parseMediaUrl, type ResolveContext } from './contentDelivery.service.ts';

/** Normalize owned uploads before saving. A guessed id must never publish somebody else's file. */
export async function assertGalleryMediaAnswers(
  client: Prisma.TransactionClient,
  {
    classroomId,
    formId,
    userId,
    fields,
    answers,
  }: {
    classroomId: string;
    formId: string;
    userId: string;
    fields: FormField[];
    answers: Record<string, unknown>;
  }
): Promise<Record<string, unknown>> {
  const result = { ...answers };
  const mediaFields = fields.filter(field =>
    ['cover', 'video'].includes(galleryRoleOf(field) ?? '')
  );
  if (!mediaFields.length) return result;
  const classroom = await client.classroom.findUniqueOrThrow({
    where: { id: classroomId },
    select: {
      id: true,
      content_repo: true,
      content_key_version: true,
      content_delivery_enabled: true,
      git_organization: { select: { login: true } },
    },
  });
  const ctx: ResolveContext | null =
    classroom.content_repo && classroom.git_organization
      ? {
          classroom: {
            ...classroom,
            content_repo: classroom.content_repo,
            git_organization: classroom.git_organization,
          },
          tier: 'month',
        }
      : null;
  for (const field of mediaFields) {
    const raw = typeof result[field.id] === 'string' ? (result[field.id] as string).trim() : '';
    const id = parseMediaRef(raw) ?? (ctx ? parseMediaUrl(ctx, raw) : null);
    if (!id && !raw.startsWith('media:')) continue;
    const row = id
      ? await client.mediaObject.findFirst({
          where: {
            id,
            classroom_id: classroomId,
            uploaded_by: userId,
            gallery_form_id: formId,
            gallery_field_id: field.id,
            status: 'READY',
            kind: galleryRoleOf(field) === 'cover' ? 'IMAGE' : 'VIDEO',
          },
          select: { id: true },
        })
      : null;
    if (!row)
      throw formContractError(
        FORM_ANSWERS_INVALID,
        'Choose an upload you completed for this project field.'
      );
    result[field.id] = `media://${row.id}`;
  }
  return result;
}

/** How long a student's gallery upload may sit unused before the sweeper removes it. */
export const GALLERY_UPLOAD_UNUSED_DAYS = 14;

/**
 * Gallery uploads no response points at any more, older than
 * `GALLERY_UPLOAD_UNUSED_DAYS`: replaced covers, abandoned drafts, and every
 * upload of a deleted form (its gallery_form_id is null, its field id stays).
 * They count against the student's and the classroom's quota until removed.
 * A response of any state (a draft included) that still holds `media://<id>`
 * in that field keeps the upload.
 */
export async function findUnusedGalleryUploads({
  now = new Date(),
  take = 200,
}: { now?: Date; take?: number } = {}): Promise<Array<{ id: string; classroom_id: string }>> {
  const prisma = getPrisma();
  const cutoff = new Date(now.getTime() - GALLERY_UPLOAD_UNUSED_DAYS * 86_400_000);
  const candidates = await prisma.mediaObject.findMany({
    where: {
      gallery_field_id: { not: null },
      status: { in: ['READY', 'UPLOADING'] },
      created_at: { lt: cutoff },
    },
    select: { id: true, classroom_id: true, gallery_form_id: true, gallery_field_id: true },
    orderBy: { created_at: 'asc' },
    take,
  });
  const unused: Array<{ id: string; classroom_id: string }> = [];
  for (const row of candidates) {
    const held =
      row.gallery_form_id &&
      (await prisma.formResponse.count({
        where: {
          form_id: row.gallery_form_id,
          answers: { path: [row.gallery_field_id!], equals: `media://${row.id}` },
        },
      }));
    if (!held) unused.push({ id: row.id, classroom_id: row.classroom_id });
  }
  return unused;
}
