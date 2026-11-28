import getPrisma from '@classmoji/database';
import type { Prisma } from '@classmoji/database/client';
import {
  NO_SERVICE_AUDIT,
  recordForActor,
  type AuditActor,
  type ServiceAudit,
} from './audit.service.ts';
import { describeSettingsChange, settingsChangeData, settingsValues } from './settingsAudit.ts';

/**
 * Serialise every recorded write of a classroom's letter grades (`save`,
 * `delete`, `replaceAll`), so each reads the thresholds it replaces in the
 * transaction that writes them and two overlapping saves are recorded one
 * after the other. Transaction-scoped, released at commit or rollback. An
 * advisory lock, as the emoji scale's (`lockScale` in emojiMapping.service),
 * not `FOR UPDATE` on the classroom row, which would block every insert that
 * references it.
 */
const lockLetterGrades = (tx: Prisma.TransactionClient, classroomId: string) =>
  tx.$queryRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtext(${`letter-grades:${classroomId}`}))) AS l`;

/** The fields one letter grade threshold is saved with; nothing else is written. */
export interface LetterGradeMappingFields {
  letter_grade: string;
  min_grade: number;
}

/** One threshold upserted through `tx`, with the row it replaced when `readBefore`. */
const upsertThreshold = async (
  tx: Prisma.TransactionClient,
  classroomId: string,
  values: LetterGradeMappingFields,
  readBefore: boolean
) => {
  const where = {
    classroom_id_letter_grade: { classroom_id: classroomId, letter_grade: values.letter_grade },
  };
  const before = readBefore ? await tx.letterGradeMapping.findUnique({ where }) : null;
  const mapping = await tx.letterGradeMapping.upsert({
    where,
    update: { min_grade: values.min_grade },
    create: {
      classroom_id: classroomId,
      letter_grade: values.letter_grade,
      min_grade: values.min_grade,
    },
  });
  return { mapping, before };
};

/**
 * Add or update one letter grade threshold of `classroomId` (the settings
 * table, MCP `letter_grade_mapping_upsert`). Writes only `min_grade`, to that
 * classroom's row for `letter_grade`: the row's id and classroom are never
 * taken from `values`.
 *
 * Recorded for `actor` after the save, when it created the letter or changed
 * its minimum: SETTINGS / UPDATE on the mapping, `letter_grade` and
 * `min_grade`, and the changed `fields` with their `values` and `previous`
 * values, `created: true` for a new letter. `actor: null` records nothing.
 * The previous minimum is read under the letter grades' lock, in the
 * transaction that writes; the row is written after the commit.
 */
export const save = async (
  classroomId: string,
  values: LetterGradeMappingFields,
  actor: AuditActor | null
) => {
  const { mapping, before } = await getPrisma().$transaction(async tx => {
    await lockLetterGrades(tx, classroomId);
    return upsertThreshold(tx, classroomId, values, actor !== null);
  });

  let audit: ServiceAudit = NO_SERVICE_AUDIT;
  const change = actor
    ? describeSettingsChange(
        'LetterGradeMapping',
        before,
        mapping,
        before ? ['min_grade'] : ['letter_grade', 'min_grade']
      )
    : null;
  if (actor && change) {
    audit = await recordForActor(actor, {
      classroomId,
      resourceType: 'SETTINGS',
      resourceId: mapping.id,
      action: 'UPDATE',
      data: {
        ...settingsValues('LetterGradeMapping', mapping, ['letter_grade', 'min_grade']),
        ...settingsChangeData(change),
        ...(before ? {} : { created: true }),
      },
    });
  }
  return { mapping, audit };
};

export const findByClassroomId = async (classroomId: string) => {
  return getPrisma().letterGradeMapping.findMany({
    where: { classroom_id: classroomId },
    orderBy: { min_grade: 'desc' },
  });
};

/**
 * Delete one letter grade of `classroomId`. Returns how many rows went (0 or
 * 1); a letter grade that is not a non-empty string deletes nothing.
 *
 * A delete is recorded for `actor`: SETTINGS / DELETE on the mapping, its
 * `letter_grade` and its `previous` minimum (read under the letter grades'
 * lock, in the transaction that deletes). Nothing deleted, or `actor: null`:
 * no row.
 */
const deleteMapping = async (
  classroomId: string,
  letterGrade: unknown,
  actor: AuditActor | null
): Promise<{ count: number; audit: ServiceAudit }> => {
  if (typeof letterGrade !== 'string' || letterGrade === '' || !classroomId) {
    return { count: 0, audit: NO_SERVICE_AUDIT };
  }
  const { before, count } = await getPrisma().$transaction(async tx => {
    await lockLetterGrades(tx, classroomId);
    const before = actor
      ? await tx.letterGradeMapping.findUnique({
          where: {
            classroom_id_letter_grade: { classroom_id: classroomId, letter_grade: letterGrade },
          },
          select: { id: true, min_grade: true },
        })
      : null;
    const { count } = await tx.letterGradeMapping.deleteMany({
      where: { classroom_id: classroomId, letter_grade: letterGrade },
    });
    return { before, count };
  });
  if (!actor || count === 0) return { count, audit: NO_SERVICE_AUDIT };
  const audit = await recordForActor(actor, {
    classroomId,
    resourceType: 'SETTINGS',
    resourceId: before?.id ?? null,
    action: 'DELETE',
    data: {
      letter_grade: letterGrade,
      ...(before ? { previous: settingsValues('LetterGradeMapping', before, ['min_grade']) } : {}),
    },
  });
  return { count, audit };
};
export { deleteMapping as delete };

/** A set of thresholds as comparable text, sorted by letter. */
const thresholdsKey = (rows: ReadonlyArray<{ letter_grade: string; min_grade: unknown }>) =>
  JSON.stringify(
    rows
      .map(r => [r.letter_grade, Number(r.min_grade)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  );

/**
 * Replace every letter grade of `classroomId` with `mappings` (the settings
 * page's "populate defaults"): every existing letter deleted, then each new
 * one saved in order (a letter given twice keeps its last minimum), in one
 * transaction under the letter grades' lock.
 *
 * Recorded for `actor` once, after the commit, when the thresholds differ
 * from the ones replaced (read in that transaction): SETTINGS / UPDATE on the
 * classroom, `count` and `previous_count`. `actor: null` records nothing.
 */
export const replaceAll = async (
  classroomId: string,
  mappings: readonly LetterGradeMappingFields[],
  actor: AuditActor | null
) => {
  const existing = await getPrisma().$transaction(async tx => {
    await lockLetterGrades(tx, classroomId);
    const existing = await tx.letterGradeMapping.findMany({
      where: { classroom_id: classroomId },
      select: { letter_grade: true, min_grade: true },
    });
    await tx.letterGradeMapping.deleteMany({ where: { classroom_id: classroomId } });
    for (const mapping of mappings) {
      await upsertThreshold(tx, classroomId, mapping, false);
    }
    return existing;
  });
  let audit: ServiceAudit = NO_SERVICE_AUDIT;
  if (actor && thresholdsKey(existing) !== thresholdsKey(mappings)) {
    audit = await recordForActor(actor, {
      classroomId,
      resourceType: 'SETTINGS',
      resourceId: classroomId,
      action: 'UPDATE',
      data: { count: mappings.length, previous_count: existing.length },
    });
  }
  return { count: mappings.length, audit };
};
