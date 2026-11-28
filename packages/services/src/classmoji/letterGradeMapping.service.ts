import getPrisma from '@classmoji/database';
import {
  NO_SERVICE_AUDIT,
  recordForActor,
  type AuditActor,
  type ServiceAudit,
} from './audit.service.ts';
import { describeSettingsChange, settingsChangeData } from './settingsAudit.ts';

/** The fields one letter grade threshold is saved with; nothing else is written. */
export interface LetterGradeMappingFields {
  letter_grade: string;
  min_grade: number;
}

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
 */
export const save = async (
  classroomId: string,
  values: LetterGradeMappingFields,
  actor: AuditActor | null
) => {
  const prisma = getPrisma();
  const where = {
    classroom_id_letter_grade: { classroom_id: classroomId, letter_grade: values.letter_grade },
  };
  const before = actor ? await prisma.letterGradeMapping.findUnique({ where }) : null;
  const mapping = await prisma.letterGradeMapping.upsert({
    where,
    update: { min_grade: values.min_grade },
    create: {
      classroom_id: classroomId,
      letter_grade: values.letter_grade,
      min_grade: values.min_grade,
    },
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
        letter_grade: mapping.letter_grade,
        min_grade: mapping.min_grade,
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
 * `letter_grade` and its `previous` minimum. Nothing deleted, or `actor:
 * null`: no row.
 */
const deleteMapping = async (
  classroomId: string,
  letterGrade: unknown,
  actor: AuditActor | null
): Promise<{ count: number; audit: ServiceAudit }> => {
  if (typeof letterGrade !== 'string' || letterGrade === '' || !classroomId) {
    return { count: 0, audit: NO_SERVICE_AUDIT };
  }
  const prisma = getPrisma();
  const before = actor
    ? await prisma.letterGradeMapping.findUnique({
        where: {
          classroom_id_letter_grade: { classroom_id: classroomId, letter_grade: letterGrade },
        },
        select: { id: true, min_grade: true },
      })
    : null;
  const { count } = await prisma.letterGradeMapping.deleteMany({
    where: { classroom_id: classroomId, letter_grade: letterGrade },
  });
  if (!actor || count === 0) return { count, audit: NO_SERVICE_AUDIT };
  const audit = await recordForActor(actor, {
    classroomId,
    resourceType: 'SETTINGS',
    resourceId: before?.id ?? null,
    action: 'DELETE',
    data: {
      letter_grade: letterGrade,
      ...(before ? { previous: { min_grade: before.min_grade } } : {}),
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
 * page's "populate defaults"): each existing letter deleted, then each new one
 * saved, one call at a time as the page always did.
 *
 * Recorded for `actor` once, after the last save, when the thresholds differ
 * from the ones replaced: SETTINGS / UPDATE on the classroom, `count` and
 * `previous_count`. `actor: null` records nothing.
 */
export const replaceAll = async (
  classroomId: string,
  mappings: readonly LetterGradeMappingFields[],
  actor: AuditActor | null
) => {
  const existing = await findByClassroomId(classroomId);
  for (const mapping of existing) {
    await deleteMapping(classroomId, mapping.letter_grade, null);
  }
  for (const mapping of mappings) {
    await save(classroomId, mapping, null);
  }
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
