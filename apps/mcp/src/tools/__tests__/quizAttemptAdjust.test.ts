/**
 * Unit tests for quiz_attempt_adjust: the teaching team sets, changes or
 * reverts a quiz attempt's grade (an emoji on the classroom's scale) and the
 * comment the student reads with it.
 *
 * Held here: the tier is the teaching team, assistants included, never a
 * student; the attempt must be one of a quiz of the AUTHORIZED classroom (a
 * foreign quiz or attempt is the same not_found as an unknown id, and the
 * service is never called); the service's refusals map to tool errors (an
 * emoji off the scale is invalid_params, a student actor forbidden); revert
 * clears the adjustment; the result carries emoji only, never a number; the
 * tool writes no audit row of its own (the service does, named for the tool);
 * and the hints a client sees mark it destructive, idempotent, closed-world.
 *
 * `@classmoji/services` and the Prisma client are mocked; the payload shaping
 * runs for real.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  quizFindById: vi.fn(),
  attemptFindFirst: vi.fn(),
  adjust: vi.fn(),
  revert: vi.fn(),
  quizzesVisibleOrThrow: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('@classmoji/database', async () => ({
  ...(await vi.importActual<typeof import('@classmoji/database/gitIdentity')>(
    '@classmoji/database/gitIdentity'
  )),
  default: () => ({
    quizAttempt: { findFirst: (...a: unknown[]) => mocks.attemptFindFirst(...a) },
  }),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    quiz: { findById: (...a: unknown[]) => mocks.quizFindById(...a) },
    quizAttempt: {
      adjust: (...a: unknown[]) => mocks.adjust(...a),
      revert: (...a: unknown[]) => mocks.revert(...a),
    },
    entitlement: { quizzesVisibleOrThrow: (...a: unknown[]) => mocks.quizzesVisibleOrThrow(...a) },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
  },
}));

const { quizAttemptAdjustTool } = await import('../quizAttemptAdjust.ts');
const { toolAnnotations } = await import('../../mcp/registry.ts');

const QUIZ_ID = '22222222-2222-4222-8222-222222222222';
const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
const ARGS = { classroom: 'org/w26', quiz_id: QUIZ_ID, attempt_id: ATTEMPT_ID };

const ctx = (role: string, impersonatedBy: string | null = null): ToolContext =>
  ({
    viewer: { userId: 'staff-1', clientId: 'c', scopes: new Set(['write']), impersonatedBy },
    classroom: {
      classroomId: 'class-1',
      role,
      status: 'ACTIVE',
      membership: { id: 'm-1', role },
      classroom: { settings: {} },
    },
  }) as unknown as ToolContext;

/** A QuizGradeError as the service throws it (matched by name). */
class QuizGradeError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'QuizGradeError';
    this.code = code;
    this.status = status;
  }
}

/** The service's result: the attempt and its grade on the scale. */
const result = (over: Record<string, unknown> = {}) => ({
  attempt: {
    id: ATTEMPT_ID,
    quiz_id: QUIZ_ID,
    user_id: 'stu-1',
    partial_credit_percentage: 62,
    adjusted_emoji: 'rocket',
    instructor_comment: 'Q3 was ambiguous.',
    adjusted_by_id: 'staff-1',
    adjusted_at: new Date('2026-10-21T15:00:00Z'),
  },
  grade: {
    original: { percentage: 62, emoji: '-1', band: { evaluation: 'NEEDS WORK', numeric_score: 2 } },
    effective: {
      percentage: 100,
      emoji: 'rocket',
      band: { evaluation: 'EXCELLENT', numeric_score: 4 },
    },
    adjusted: true,
    adjusted_emoji: 'rocket',
  },
  classroomId: 'class-1',
  changed: true,
  ...over,
});

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

/** Every [key, value] in a JSON value, at any depth. */
const entriesOf = (value: unknown): Array<[string, unknown]> =>
  Array.isArray(value)
    ? value.flatMap(entriesOf)
    : value && typeof value === 'object'
      ? Object.entries(value).flatMap(([k, v]) => [[k, v] as [string, unknown], ...entriesOf(v)])
      : [];

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.quizzesVisibleOrThrow.mockResolvedValue(true);
  mocks.quizFindById.mockResolvedValue({ id: QUIZ_ID, classroom_id: 'class-1' });
  mocks.attemptFindFirst.mockResolvedValue({ id: ATTEMPT_ID });
  mocks.adjust.mockResolvedValue(result());
  mocks.revert.mockResolvedValue(result());
});

describe('quiz_attempt_adjust: tier and hints', () => {
  it('is the teaching team, assistants included, never a student', () => {
    expect([...(quizAttemptAdjustTool.roles ?? [])].sort()).toEqual([
      'ASSISTANT',
      'OWNER',
      'TEACHER',
    ]);
    expect(quizAttemptAdjustTool.roles).not.toContain('STUDENT');
    expect(quizAttemptAdjustTool.scope).toBe('write');
  });

  it('emits destructive, idempotent, closed-world write hints', () => {
    expect(toolAnnotations(quizAttemptAdjustTool as never)).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it('keeps its description under 1,500 bytes and points at the scale', () => {
    expect(Buffer.byteLength(quizAttemptAdjustTool.description, 'utf8')).toBeLessThan(1500);
    expect(quizAttemptAdjustTool.description).toContain('emoji_scale');
  });
});

describe('quiz_attempt_adjust: adjusting', () => {
  it('lets an assistant adjust, through the service, named for the tool', async () => {
    const payload = parse(
      await quizAttemptAdjustTool.handler(
        { ...ARGS, emoji: 'rocket', comment: 'Q3 was ambiguous.' },
        ctx('ASSISTANT', 'admin-9')
      )
    );

    expect(mocks.adjust).toHaveBeenCalledWith({
      attemptId: ATTEMPT_ID,
      actorUserId: 'staff-1',
      tool: 'quiz_attempt_adjust',
      impersonatedBy: 'admin-9',
      emoji: 'rocket',
      comment: 'Q3 was ambiguous.',
    });
    expect(payload).toMatchObject({
      success: true,
      changed: true,
      attempt: {
        id: ATTEMPT_ID,
        grade_emoji: 'rocket',
        original_emoji: '-1',
        adjusted: true,
        band: 'EXCELLENT',
        instructor_comment: 'Q3 was ambiguous.',
      },
    });
    // The service audits; the tool writes no second row.
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('returns no grade as a number', async () => {
    const payload = parse(
      await quizAttemptAdjustTool.handler({ ...ARGS, emoji: 'rocket' }, ctx('TEACHER'))
    );
    for (const [key, value] of entriesOf(payload)) {
      expect(typeof value, key).not.toBe('number');
      expect(key).not.toMatch(/percentage|score/);
    }
  });

  it('maps a student actor refused by the service to forbidden', async () => {
    mocks.adjust.mockRejectedValue(
      new QuizGradeError('forbidden', 'Only the teaching team may adjust quiz grades', 403)
    );
    await expect(
      quizAttemptAdjustTool.handler({ ...ARGS, emoji: 'rocket' }, ctx('STUDENT'))
    ).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('refuses an emoji off the classroom scale as invalid_params', async () => {
    mocks.adjust.mockRejectedValue(
      new QuizGradeError('invalid_emoji', '"tada" is not in this classroom\'s grading scale')
    );
    await expect(
      quizAttemptAdjustTool.handler({ ...ARGS, emoji: 'tada' }, ctx('TEACHER'))
    ).rejects.toMatchObject({ kind: 'invalid_params', code: 'INVALID_EMOJI' });
  });

  it('refuses an attempt of another classroom like an unknown one, before the service', async () => {
    // The attempt is not one of this classroom's quiz's attempts.
    mocks.attemptFindFirst.mockResolvedValue(null);
    await expect(
      quizAttemptAdjustTool.handler({ ...ARGS, emoji: 'rocket' }, ctx('OWNER'))
    ).rejects.toMatchObject({ kind: 'not_found' });
    expect(mocks.attemptFindFirst).toHaveBeenCalledWith({
      where: { id: ATTEMPT_ID, quiz_id: QUIZ_ID },
      select: { id: true },
    });

    // A quiz of another classroom: the same not_found.
    mocks.attemptFindFirst.mockResolvedValue({ id: ATTEMPT_ID });
    mocks.quizFindById.mockResolvedValue({ id: QUIZ_ID, classroom_id: 'other-class' });
    await expect(
      quizAttemptAdjustTool.handler({ ...ARGS, emoji: 'rocket' }, ctx('OWNER'))
    ).rejects.toMatchObject({ kind: 'not_found' });
    expect(mocks.adjust).not.toHaveBeenCalled();
  });

  it('maps the service not_found (attempt of a classroom the actor is not in) to not_found', async () => {
    mocks.adjust.mockRejectedValue(new QuizGradeError('not_found', 'Quiz attempt not found', 404));
    await expect(
      quizAttemptAdjustTool.handler({ ...ARGS, emoji: 'rocket' }, ctx('OWNER'))
    ).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('is refused where the classroom shows no quizzes', async () => {
    mocks.quizzesVisibleOrThrow.mockResolvedValue(false);
    await expect(
      quizAttemptAdjustTool.handler({ ...ARGS, emoji: 'rocket' }, ctx('OWNER'))
    ).rejects.toMatchObject({ kind: 'forbidden' });
    expect(mocks.adjust).not.toHaveBeenCalled();
  });

  it('needs an emoji, a comment or revert, and never emoji with revert', async () => {
    await expect(quizAttemptAdjustTool.handler(ARGS, ctx('OWNER'))).rejects.toMatchObject({
      kind: 'invalid_params',
    });
    await expect(
      quizAttemptAdjustTool.handler({ ...ARGS, emoji: 'rocket', revert: true }, ctx('OWNER'))
    ).rejects.toMatchObject({ kind: 'invalid_params' });
    expect(mocks.adjust).not.toHaveBeenCalled();
    expect(mocks.revert).not.toHaveBeenCalled();
  });

  it('passes an empty comment through, so the service clears it', async () => {
    await quizAttemptAdjustTool.handler({ ...ARGS, comment: '' }, ctx('OWNER'));
    expect(mocks.adjust).toHaveBeenCalledWith(expect.objectContaining({ comment: '' }));
    expect(mocks.adjust.mock.calls[0][0]).not.toHaveProperty('emoji');
  });
});

describe('quiz_attempt_adjust: revert', () => {
  it("clears the adjustment so the AI's grade counts again", async () => {
    mocks.revert.mockResolvedValue(
      result({
        attempt: { ...result().attempt, adjusted_emoji: null },
        grade: {
          ...result().grade,
          effective: result().grade.original,
          adjusted: false,
          adjusted_emoji: null,
        },
      })
    );

    const payload = parse(
      await quizAttemptAdjustTool.handler({ ...ARGS, revert: true }, ctx('ASSISTANT'))
    );

    expect(mocks.revert).toHaveBeenCalledWith({
      attemptId: ATTEMPT_ID,
      actorUserId: 'staff-1',
      tool: 'quiz_attempt_adjust',
      impersonatedBy: null,
    });
    expect(mocks.adjust).not.toHaveBeenCalled();
    expect(payload.attempt).toMatchObject({ grade_emoji: '-1', adjusted: false });
  });

  it('reports changed: false when there was nothing to revert', async () => {
    mocks.revert.mockResolvedValue(result({ changed: false }));
    const payload = parse(
      await quizAttemptAdjustTool.handler({ ...ARGS, revert: true }, ctx('OWNER'))
    );
    expect(payload.changed).toBe(false);
  });

  it('sets the comment after reverting when one is given', async () => {
    await quizAttemptAdjustTool.handler(
      { ...ARGS, revert: true, comment: 'Back to the AI grade.' },
      ctx('OWNER')
    );
    expect(mocks.revert).toHaveBeenCalledTimes(1);
    expect(mocks.adjust).toHaveBeenCalledWith(
      expect.objectContaining({ comment: 'Back to the AI grade.' })
    );
  });
});
