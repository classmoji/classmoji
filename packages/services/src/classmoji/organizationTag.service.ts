import getPrisma from '@classmoji/database';
import type { Prisma } from '@classmoji/database/client';
import {
  NO_SERVICE_AUDIT,
  recordForActor,
  type AuditActor,
  type ServiceAudit,
} from './audit.service.ts';

export const create = async (classroomId: string, name: string) => {
  return getPrisma().tag.create({
    data: {
      classroom_id: classroomId,
      name,
    },
  });
};

/**
 * Delete one tag of a classroom. The tag is deleted only where it belongs to
 * `classroomId`; returns the deleted tag's id and name, or null (nothing
 * deleted) for a tag id of another classroom, an unknown id, or a value that
 * is not a non-empty string.
 *
 * A delete is recorded for `actor` after it commits: TAGS / DELETE on the
 * tag, with its `name`. Nothing deleted, or `actor: null`: no row.
 */
export const deleteInClassroom = async (
  classroomId: string,
  tagId: unknown,
  actor: AuditActor | null
): Promise<{ tag: { id: string; name: string } | null; audit: ServiceAudit }> => {
  if (typeof tagId !== 'string' || tagId === '' || !classroomId) {
    return { tag: null, audit: NO_SERVICE_AUDIT };
  }
  const tag = await getPrisma().$transaction(async tx => {
    const tag = await tx.tag.findFirst({
      where: { id: tagId, classroom_id: classroomId },
      select: { id: true, name: true },
    });
    if (!tag) return null;
    const { count } = await tx.tag.deleteMany({ where: { id: tag.id, classroom_id: classroomId } });
    return count > 0 ? tag : null;
  });
  if (!tag) return { tag: null, audit: NO_SERVICE_AUDIT };
  const audit = await recordForActor(actor, {
    classroomId,
    resourceType: 'TAGS',
    resourceId: tag.id,
    action: 'DELETE',
    data: { name: tag.name },
  });
  return { tag, audit };
};

export const findByClassroomId = async (classroomId: string) => {
  return getPrisma().tag.findMany({
    where: { classroom_id: classroomId },
  });
};

/**
 * Every tag in the classroom with how many teams carry it and how many
 * repositories point at it, ordered by name.
 */
export const findByClassroomIdWithCounts = async (classroomId: string) => {
  return getPrisma().tag.findMany({
    where: { classroom_id: classroomId },
    select: {
      id: true,
      name: true,
      _count: { select: { teams: true, repositories: true } },
    },
    orderBy: { name: 'asc' },
  });
};

export const findByClassroomIdAndName = async (classroomId: string, name: string) => {
  return getPrisma().tag.findUnique({
    where: {
      classroom_id_name: {
        classroom_id: classroomId,
        name,
      },
    },
  });
};

export const upsert = async (classroomId: string, name: string) => {
  return getPrisma().tag.upsert({
    where: {
      classroom_id_name: {
        classroom_id: classroomId,
        name,
      },
    },
    create: {
      classroom_id: classroomId,
      name,
    },
    update: {},
  });
};

/**
 * `upsert` that also says whether it created the row — the same end state
 * (the tag named `name` exists in the classroom and is returned), plus
 * `created`.
 *
 * Race-safe by construction: it tries the INSERT and treats a unique violation
 * as "already existed", so of two concurrent calls for one name exactly one
 * reports `created: true`. A lookup-then-upsert would let both claim it. The
 * only unique index on Tag besides its uuid key is (classroom_id, name), and a
 * violation is only trusted once the row can be read back; otherwise the
 * original error is rethrown.
 *
 * Names are compared exactly (case-sensitive), as the unique index and the web
 * tag screens do: 'Frontend' and 'frontend' are two tags.
 *
 * A created tag is recorded for `actor`: TAGS / CREATE on the tag, with its
 * `name` (and `value`, the same name). A tag that already existed, or `actor:
 * null`: no row.
 */
export const findOrCreate = async (classroomId: string, name: string, actor: AuditActor | null) => {
  let tag: Prisma.TagGetPayload<object>;
  try {
    tag = await getPrisma().tag.create({
      data: { classroom_id: classroomId, name },
    });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== 'P2002') throw error;
    const existing = await findByClassroomIdAndName(classroomId, name);
    if (!existing) throw error;
    return { tag: existing, created: false, audit: NO_SERVICE_AUDIT };
  }
  const audit = await recordForActor(actor, {
    classroomId,
    resourceType: 'TAGS',
    resourceId: tag.id,
    action: 'CREATE',
    data: { name: tag.name, value: tag.name },
  });
  return { tag, created: true, audit };
};

export const findTeamsByTag = async (tagId: string) => {
  const tag = await getPrisma().tag.findUnique({
    where: { id: tagId },
    include: {
      teams: {
        include: {
          team: true,
        },
      },
    },
  });

  if (!tag) return [];

  return tag.teams.map(
    ({ team }: { team: Prisma.TeamTagGetPayload<{ include: { team: true } }>['team'] }) => team
  );
};
