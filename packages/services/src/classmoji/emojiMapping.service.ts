import getPrisma from '@classmoji/database';
import type { Prisma, PrismaClient } from '@classmoji/database/client';
import { SCORE_EMOJI_MAPPINGS } from '@classmoji/utils';
import {
  NO_SERVICE_AUDIT,
  recordForActor,
  type AuditActor,
  type ServiceAudit,
} from './audit.service.ts';
import { describeSettingsChange, settingsChangeData, settingsValues } from './settingsAudit.ts';

type EmojiMappingInput = Prisma.EmojiMappingUncheckedCreateWithoutClassroomInput;

/** The fields one emoji of a scale is saved with; nothing else is written. */
export interface EmojiMappingFields {
  emoji: string;
  grade: number;
  extra_tokens?: number;
  description?: string;
}

/**
 * Add or update one emoji on a classroom's scale (the settings table, MCP
 * `emoji_mapping_upsert`). Under the scale lock (`lockScale`), so it lands
 * before or after a `replaceScale`, never between its delete and its insert.
 *
 * Writes only the named fields, to `classroomId`'s row for that emoji: the
 * row's id and classroom are never taken from `values`. A field left
 * undefined keeps its stored value on an update.
 *
 * Recorded for `actor` after the save, when it created the emoji or changed
 * one of its fields: SETTINGS / UPDATE on the mapping, `emoji` and `grade`,
 * and the changed `fields` with their `values` and `previous` values (the
 * description by name only), `created: true` for a new emoji. `actor: null`
 * records nothing.
 */
export const saveEmojiMapping = async (
  classroomId: string,
  values: EmojiMappingFields,
  actor: AuditActor | null
) => {
  const fields = {
    grade: values.grade,
    ...(values.extra_tokens !== undefined ? { extra_tokens: values.extra_tokens } : {}),
    ...(values.description !== undefined ? { description: values.description } : {}),
  };
  const where = { classroom_id_emoji: { classroom_id: classroomId, emoji: values.emoji } };
  const { mapping, before } = await getPrisma().$transaction(async tx => {
    await lockScale(tx, classroomId);
    const before = actor ? await tx.emojiMapping.findUnique({ where }) : null;
    const mapping = await tx.emojiMapping.upsert({
      where,
      update: fields,
      create: { ...fields, emoji: values.emoji, classroom_id: classroomId },
    });
    return { mapping, before };
  });

  let audit: ServiceAudit = NO_SERVICE_AUDIT;
  const change = actor
    ? describeSettingsChange(
        'EmojiMapping',
        before,
        mapping,
        before ? Object.keys(fields) : ['emoji', ...Object.keys(fields)]
      )
    : null;
  if (actor && change) {
    audit = await recordForActor(actor, {
      classroomId,
      resourceType: 'SETTINGS',
      resourceId: mapping.id,
      action: 'UPDATE',
      data: {
        ...settingsValues('EmojiMapping', mapping, ['emoji', 'grade']),
        ...settingsChangeData(change),
        ...(before ? {} : { created: true }),
      },
    });
  }
  return { mapping, audit };
};

export const findClassroomEmojiMappingDescription = async (classroomId: string) => {
  const mappings = await getPrisma().emojiMapping.findMany({
    where: { classroom_id: classroomId },
    orderBy: { grade: 'desc' },
  });

  return mappings.map(mapping => ({
    emoji: mapping.emoji,
    description: mapping.description,
  }));
};

/** The client a scale read or seed runs on: the shared one, or a transaction's. */
type ScaleClient = PrismaClient | Prisma.TransactionClient;

/**
 * Serialise every write that may leave a classroom's scale empty or fill an
 * empty one, and every insert that could collide with one: the settings
 * page's wipe-and-replace (`replaceScale`), the re-seed (`ensureDefaultScale`)
 * and the one-row upsert (`saveEmojiMapping`). Without it a re-seed that ran while the
 * owner's replacement was half done (or into a classroom emptied row by row
 * while a replacement ran) left a scale mixing both sets. Transaction-scoped:
 * released at commit or rollback. An advisory lock, not `FOR UPDATE` on the
 * classroom row, which would block every insert that references it.
 */
const lockScale = (tx: Prisma.TransactionClient, classroomId: string) =>
  tx.$queryRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtext(${`emoji-scale:${classroomId}`}))) AS l`;

/** Run `fn` in a transaction: the caller's when given one, else a new one. */
const inTransaction = <T>(
  client: ScaleClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> =>
  '$transaction' in client && typeof client.$transaction === 'function'
    ? (client as PrismaClient).$transaction(fn)
    : fn(client as Prisma.TransactionClient);

export const findByClassroomId = async (
  classroomId: string,
  includeExtraTokens = false,
  client: ScaleClient = getPrisma()
) => {
  const mappings = await client.emojiMapping.findMany({
    where: { classroom_id: classroomId },
    orderBy: { grade: 'desc' },
  });

  if (includeExtraTokens) {
    return mappings;
  }

  // create object with emoji property as key and grade as value
  const emojiMappings: Record<string, number> = {};

  mappings.forEach(mapping => {
    emojiMappings[mapping.emoji] = Math.trunc(mapping.grade as unknown as number);
  });

  return emojiMappings;
};

/**
 * The classroom's grading scale as emoji → grade, exactly as the grade totals
 * read it (`findByClassroomId` without tokens, grades truncated). What a quiz
 * adjustment's emoji is worth (`effectivePercentage` in @classmoji/utils).
 */
export const findScaleByClassroomId = async (
  classroomId: string,
  client: ScaleClient = getPrisma()
) => (await findByClassroomId(classroomId, false, client)) as Record<string, number>;

/**
 * The classroom's grading scale for quiz GRADING (E10): what a question's
 * result emoji, an adjustment and a regrade resolution are picked from, and
 * what the quiz chat model is shown. Always the classroom's own, editable
 * scale: a classroom that has none (every row deleted in settings) is first
 * given the one a new classroom gets (`ensureDefaultScale`), so a grade is
 * never taken off a set the faculty cannot see or edit. Display paths read
 * `findScaleByClassroomId` and write nothing.
 *
 * `client` is a transaction's when the caller is inside one (quiz grading
 * holds the attempt's row lock), so the seed and the read are in it. Call it
 * only for an authorized actor or the server's own grading: it may write.
 */
export const quizScaleForClassroom = async (
  classroomId: string,
  client: ScaleClient = getPrisma()
): Promise<Record<string, number>> => {
  const scale = await findScaleByClassroomId(classroomId, client);
  if (Object.keys(scale).length > 0) return scale;
  await ensureDefaultScale(classroomId, client);
  return findScaleByClassroomId(classroomId, client);
};

/**
 * The quiz scale's emoji, best first (grade descending, then emoji). Sorted
 * here, not read off the record's key order: an integer-like shortcode
 * (`100`) would otherwise jump to the front.
 */
export const quizScaleEmojis = (scale: Readonly<Record<string, number>>): string[] =>
  Object.entries(scale)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([emoji]) => emoji);

/**
 * Delete one emoji from `classroomId`'s scale. Returns how many rows went (0
 * or 1); an emoji that is not a non-empty string deletes nothing.
 *
 * A delete is recorded for `actor`: SETTINGS / DELETE on the mapping, its
 * `emoji` and its `previous` grade and bonus tokens. Nothing deleted, or
 * `actor: null`: no row.
 */
export const deleteEmojiMapping = async (
  classroomId: string,
  emoji: unknown,
  actor: AuditActor | null
): Promise<{ count: number; audit: ServiceAudit }> => {
  if (typeof emoji !== 'string' || emoji === '' || !classroomId) {
    return { count: 0, audit: NO_SERVICE_AUDIT };
  }
  const prisma = getPrisma();
  const before = actor
    ? await prisma.emojiMapping.findUnique({
        where: { classroom_id_emoji: { classroom_id: classroomId, emoji } },
        select: { id: true, grade: true, extra_tokens: true },
      })
    : null;
  const { count } = await prisma.emojiMapping.deleteMany({
    where: { classroom_id: classroomId, emoji },
  });
  if (!actor || count === 0) return { count, audit: NO_SERVICE_AUDIT };
  const audit = await recordForActor(actor, {
    classroomId,
    resourceType: 'SETTINGS',
    resourceId: before?.id ?? null,
    action: 'DELETE',
    data: {
      emoji,
      ...(before
        ? { previous: settingsValues('EmojiMapping', before, ['grade', 'extra_tokens']) }
        : {}),
    },
  });
  return { count, audit };
};

/**
 * Give a classroom that has no grading scale the default one: the 0–100
 * number scale in tens. Called once a classroom exists (after any config
 * import, which may have copied a scale of its own), so a fresh classroom
 * never lands on the Grades tab with nothing to grade with. A classroom that
 * already has mappings is left exactly as it is.
 */
export const ensureDefaultScale = async (classroomId: string, client: ScaleClient = getPrisma()) =>
  // Counted and seeded under the scale lock (`lockScale`), so it never lands
  // in the middle of a `replaceScale`.
  inTransaction(client, async tx => {
    await lockScale(tx, classroomId);
    const existing = await tx.emojiMapping.count({ where: { classroom_id: classroomId } });
    if (existing > 0) return { seeded: false as const };
    await tx.emojiMapping.createMany({
      data: SCORE_EMOJI_MAPPINGS.map(m => ({ classroom_id: classroomId, ...m })),
      skipDuplicates: true,
    });
    return { seeded: true as const, count: SCORE_EMOJI_MAPPINGS.length };
  });

/** A scale as comparable text: each emoji with its grade and bonus tokens, sorted. */
const scaleKey = (rows: ReadonlyArray<{ emoji: string; grade: unknown; extra_tokens?: unknown }>) =>
  JSON.stringify(
    rows
      .map(r => [r.emoji, Number(r.grade), Number(r.extra_tokens ?? 0)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  );

/**
 * Replace a classroom's whole grading scale with `mappings` (the settings
 * page's "populate" buttons): one transaction under the scale lock, so no
 * reader sees it empty and a concurrent re-seed (`ensureDefaultScale`) cannot
 * mix its rows in. Grades and quiz adjustments on emojis that left the scale
 * become orphaned (the settings page's remap banner).
 *
 * Recorded for `actor` after the commit, when the scale is not the one it
 * replaced: SETTINGS / UPDATE on the classroom, `count` (emojis now) and
 * `previous_count`. `actor: null` records nothing.
 */
export const replaceScale = async (
  classroomId: string,
  mappings: readonly EmojiMappingInput[],
  actor: AuditActor | null
) => {
  const { previous } = await getPrisma().$transaction(
    async tx => {
      await lockScale(tx, classroomId);
      const previous = actor
        ? await tx.emojiMapping.findMany({
            where: { classroom_id: classroomId },
            select: { emoji: true, grade: true, extra_tokens: true },
          })
        : null;
      await tx.emojiMapping.deleteMany({ where: { classroom_id: classroomId } });
      await tx.emojiMapping.createMany({
        data: mappings.map(m => ({ ...m, classroom_id: classroomId })),
      });
      return { previous };
    },
    { timeout: 15_000 }
  );
  let audit: ServiceAudit = NO_SERVICE_AUDIT;
  if (actor && previous && scaleKey(previous) !== scaleKey(mappings)) {
    audit = await recordForActor(actor, {
      classroomId,
      resourceType: 'SETTINGS',
      resourceId: classroomId,
      action: 'UPDATE',
      data: { count: mappings.length, previous_count: previous.length },
    });
  }
  return { count: mappings.length, audit };
};
