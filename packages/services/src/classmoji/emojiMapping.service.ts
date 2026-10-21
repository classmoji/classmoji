import getPrisma from '@classmoji/database';
import type { Prisma, PrismaClient } from '@prisma/client';
import { SCORE_EMOJI_MAPPINGS } from '@classmoji/utils';

type EmojiMappingInput = Prisma.EmojiMappingUncheckedCreateWithoutClassroomInput;

export const saveEmojiMapping = async (classroomId: string, values: EmojiMappingInput) => {
  return getPrisma().emojiMapping.upsert({
    where: {
      classroom_id_emoji: {
        classroom_id: classroomId,
        emoji: values.emoji,
      },
    },
    update: values,
    create: { classroom_id: classroomId, ...values },
  });
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
type ScaleClient = Pick<PrismaClient, 'emojiMapping'> | Prisma.TransactionClient;

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
 * holds the attempt's row lock), so the seed and the read are in it.
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

export const deleteEmojiMapping = async (classroomId: string, emoji: string) => {
  return getPrisma().emojiMapping.delete({
    where: {
      classroom_id_emoji: {
        classroom_id: classroomId,
        emoji: emoji,
      },
    },
  });
};

/**
 * Give a classroom that has no grading scale the default one: the 0–100
 * number scale in tens. Called once a classroom exists (after any config
 * import, which may have copied a scale of its own), so a fresh classroom
 * never lands on the Grades tab with nothing to grade with. A classroom that
 * already has mappings is left exactly as it is.
 */
export const ensureDefaultScale = async (
  classroomId: string,
  client: ScaleClient = getPrisma()
) => {
  const prisma = client;
  const existing = await prisma.emojiMapping.count({ where: { classroom_id: classroomId } });
  if (existing > 0) return { seeded: false as const };
  await prisma.emojiMapping.createMany({
    data: SCORE_EMOJI_MAPPINGS.map(m => ({ classroom_id: classroomId, ...m })),
    skipDuplicates: true,
  });
  return { seeded: true as const, count: SCORE_EMOJI_MAPPINGS.length };
};
