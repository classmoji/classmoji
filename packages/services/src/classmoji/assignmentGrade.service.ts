/**
 * AssignmentGrade Service (formerly IssueGrade)
 *
 * Manages grades for GitRepoAssignments
 */
import getPrisma, { GIT_IDENTITY } from '@classmoji/database';
import { withLogins } from '@classmoji/utils';
import type { Prisma } from '@prisma/client';

/**
 * The functions that take an optional `tx` run inside the caller's transaction
 * when given one (a grade and its token rows commit together), else on the
 * shared client.
 */
type Db = Prisma.TransactionClient;

/**
 * Add a grade to a GitRepoAssignment
 * @param {string} repositoryAssignmentId - UUID of the GitRepoAssignment
 * @param {string} graderId - UUID of the grader User
 * @param {string} emoji - Emoji grade
 * @returns {Promise<Object>}
 */
export const addGrade = async (
  repositoryAssignmentId: string,
  graderId: string,
  emoji: string,
  tx?: Db
) => {
  return (tx ?? getPrisma()).assignmentGrade.create({
    data: {
      git_repo_assignment_id: repositoryAssignmentId,
      grader_id: graderId,
      emoji: emoji,
    },
  });
};

/**
 * Remove a grade by ID
 * @param {string} id - UUID of the AssignmentGrade
 * @returns {Promise<Object>}
 */
export const removeGrade = async (id: string) => {
  return getPrisma().assignmentGrade.delete({
    where: { id },
  });
};

/**
 * Check if a grade with a specific emoji already exists
 * @param {string} repositoryAssignmentId - UUID of the GitRepoAssignment
 * @param {string} emoji - Emoji to check
 * @returns {Promise<boolean>}
 */
export const doesGradeExist = async (repositoryAssignmentId: string, emoji: string, tx?: Db) => {
  const grades = await (tx ?? getPrisma()).assignmentGrade.findMany({
    where: {
      git_repo_assignment_id: repositoryAssignmentId,
      emoji: emoji,
    },
  });
  return grades.length === 1;
};

/**
 * Update a grade
 * @param {string} id - UUID of the AssignmentGrade
 * @param {Object} data - Data to update
 * @returns {Promise<Object>}
 */
export const update = async (
  id: string,
  data: Prisma.AssignmentGradeUncheckedUpdateInput,
  tx?: Db
) => {
  return (tx ?? getPrisma()).assignmentGrade.update({
    where: { id },
    data: data,
  });
};

/**
 * Remove all grades from a GitRepoAssignment
 * @param {string} repositoryAssignmentId - UUID of the GitRepoAssignment
 * @returns {Promise<{count: number}>}
 */
export const removeAllGrades = async (repositoryAssignmentId: string) => {
  return getPrisma().assignmentGrade.deleteMany({
    where: {
      git_repo_assignment_id: repositoryAssignmentId,
    },
  });
};

/**
 * Find grades by GitRepoAssignment
 * @param {string} repositoryAssignmentId - UUID of the GitRepoAssignment
 * @returns {Promise<Object[]>}
 */
export const findByAssignmentId = async (repositoryAssignmentId: string, tx?: Db) => {
  return withLogins(
    await (tx ?? getPrisma()).assignmentGrade.findMany({
      where: {
        git_repo_assignment_id: repositoryAssignmentId,
      },
      include: {
        grader: { include: GIT_IDENTITY },
        token_transaction: true,
      },
    })
  );
};

/**
 * Find a grade by ID
 * @param {string} id - UUID of the AssignmentGrade
 * @returns {Promise<Object|null>}
 */
export const findById = async (id: string) => {
  return withLogins(
    await getPrisma().assignmentGrade.findUnique({
      where: { id },
      include: {
        grader: { include: GIT_IDENTITY },
        git_repo_assignment: true,
        token_transaction: true,
      },
    })
  );
};

/** One emoji used by a grade or a quiz adjustment but no longer on the classroom's scale. */
export interface OrphanedGradeEmoji {
  emoji: string;
  /** Every use: repo grades plus quiz adjustments. */
  count: number;
  /** Of `count`, the quiz attempts whose staff adjustment is this emoji (E17). */
  quiz_count: number;
}

/**
 * Emojis used by grades in the classroom that are no longer on its scale
 * (`EmojiMapping`): repo grades and, since E17, quiz adjustments
 * (`QuizAttempt.adjusted_emoji`, on any attempt of the classroom's quizzes),
 * merged per emoji. The settings page's "Orphaned Grades Detected" banner.
 * The same scope `remapGradeEmojis` rewrites, so a remap clears the banner.
 */
export const findOrphanedGradeEmojis = async (
  classroomId: string
): Promise<OrphanedGradeEmoji[]> => {
  const prisma = getPrisma();
  const validEmojis = (
    await prisma.emojiMapping.findMany({
      where: { classroom_id: classroomId },
      select: { emoji: true },
    })
  ).map(m => m.emoji);
  const notOnScale = validEmojis.length > 0 ? { notIn: validEmojis } : {};

  const [grades, adjustments] = await Promise.all([
    prisma.assignmentGrade.groupBy({
      by: ['emoji'],
      where: {
        git_repo_assignment: { assignment: { repository: { classroom_id: classroomId } } },
        emoji: notOnScale,
      },
      _count: { _all: true },
    }),
    prisma.quizAttempt.groupBy({
      by: ['adjusted_emoji'],
      where: {
        quiz: { classroom_id: classroomId },
        adjusted_emoji: { not: null, ...notOnScale },
      },
      _count: { _all: true },
    }),
  ]);

  const byEmoji = new Map<string, OrphanedGradeEmoji>();
  const entry = (emoji: string) => {
    let row = byEmoji.get(emoji);
    if (!row) {
      row = { emoji, count: 0, quiz_count: 0 };
      byEmoji.set(emoji, row);
    }
    return row;
  };
  for (const g of grades) entry(g.emoji).count += g._count._all;
  for (const a of adjustments) {
    if (!a.adjusted_emoji) continue;
    const row = entry(a.adjusted_emoji);
    row.count += a._count._all;
    row.quiz_count += a._count._all;
  }
  return [...byEmoji.values()];
};

/** A large classroom's remap rewrites many rows; the grading writes' allowance. */
const REMAP_TX_OPTIONS = { timeout: 15_000 } as const;

/** Why a remap was refused; the settings action returns the message. */
export class RemapGradeEmojisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemapGradeEmojisError';
  }
}

export interface RemapGradeEmojisResult {
  /** Every row rewritten: repo grades plus quiz adjustments (not the snapshots). */
  totalRemapped: number;
  repoGrades: number;
  quizAdjustments: number;
  /** Quiz regrade requests whose resolution snapshot (`resolved_emoji`) was rewritten. */
  regradeSnapshots: number;
  /** Regrade requests (repo and quiz) whose asked-about grade (`previous_grade`) was rewritten. */
  regradePreviousGrades: number;
}

/**
 * Remap orphaned emojis to emojis on the classroom's scale, in one
 * transaction, within `classroomId` only (the caller's gate classroom): repo
 * grades, quiz adjustments (`QuizAttempt.adjusted_emoji` on the classroom's
 * quizzes, E17; who adjusted and when are kept, as a repo grade keeps its
 * grader) and the quiz regrade requests' resolution snapshots
 * (`RegradeRequest.resolved_emoji`), and the grade every regrade request of
 * the classroom asked about (`RegradeRequest.previous_grade`, each entry; repo
 * and quiz requests, their target checked in the classroom like the
 * snapshots'). Refused, with nothing written, when a
 * target is not on the scale or a source still is (only orphans are remapped).
 */
export const remapGradeEmojis = async (
  classroomId: string,
  mappings: ReadonlyArray<{ oldEmoji: string; newEmoji: string }>
): Promise<RemapGradeEmojisResult> =>
  getPrisma().$transaction(async tx => {
    const scale = new Set(
      (
        await tx.emojiMapping.findMany({
          where: { classroom_id: classroomId },
          select: { emoji: true },
        })
      ).map(m => m.emoji)
    );
    for (const { oldEmoji, newEmoji } of mappings) {
      if (!scale.has(newEmoji)) {
        throw new RemapGradeEmojisError(`:${newEmoji}: is not on this classroom's scale.`);
      }
      if (scale.has(oldEmoji)) {
        throw new RemapGradeEmojisError(
          `:${oldEmoji}: is still on the scale; only orphaned emojis are remapped.`
        );
      }
    }

    const result: RemapGradeEmojisResult = {
      totalRemapped: 0,
      repoGrades: 0,
      quizAdjustments: 0,
      regradeSnapshots: 0,
      regradePreviousGrades: 0,
    };
    for (const { oldEmoji, newEmoji } of mappings) {
      const grades = await tx.assignmentGrade.updateMany({
        where: {
          emoji: oldEmoji,
          git_repo_assignment: { assignment: { repository: { classroom_id: classroomId } } },
        },
        data: { emoji: newEmoji, updated_at: new Date() },
      });
      const adjustments = await tx.quizAttempt.updateMany({
        where: { adjusted_emoji: oldEmoji, quiz: { classroom_id: classroomId } },
        data: { adjusted_emoji: newEmoji },
      });
      const snapshots = await tx.regradeRequest.updateMany({
        where: {
          resolved_emoji: oldEmoji,
          classroom_id: classroomId,
          // Quiz requests only, on an attempt of this classroom's quizzes.
          quiz_attempt: { quiz: { classroom_id: classroomId } },
        },
        data: { resolved_emoji: newEmoji },
      });
      // An array column: Prisma's updateMany cannot rewrite its entries, so
      // the ids are scoped here and the entries replaced in SQL.
      const asked = await tx.regradeRequest.findMany({
        where: {
          classroom_id: classroomId,
          previous_grade: { has: oldEmoji },
          OR: [
            { quiz_attempt: { quiz: { classroom_id: classroomId } } },
            {
              git_repo_assignment: {
                assignment: { repository: { classroom_id: classroomId } },
              },
            },
          ],
        },
        select: { id: true },
      });
      const askedIds = asked.map(r => r.id);
      const previousGrades =
        askedIds.length > 0
          ? await tx.$executeRaw`UPDATE regrade_requests SET previous_grade = array_replace(previous_grade, ${oldEmoji}::text, ${newEmoji}::text) WHERE id = ANY(${askedIds}::text[])`
          : 0;
      result.repoGrades += grades.count;
      result.quizAdjustments += adjustments.count;
      result.regradeSnapshots += snapshots.count;
      result.regradePreviousGrades += previousGrades;
    }
    result.totalRemapped = result.repoGrades + result.quizAdjustments;
    return result;
  }, REMAP_TX_OPTIONS);
