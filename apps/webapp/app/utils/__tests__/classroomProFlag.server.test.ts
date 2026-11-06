/**
 * The two quiz-visibility helpers (classroomProFlag.server.ts).
 *
 * Both answer the same question — may quizzes appear in this classroom? — and
 * differ only in what a failed lookup means:
 *
 *   - `quizzesVisibleOrThrow` is for GATES (a 404, the 403 refusal). A failed
 *     lookup throws, so a database blip surfaces as an error rather than as
 *     "this class has no quizzes".
 *   - `loadQuizzesVisible` is for RENDERING. A failed lookup is logged and
 *     answers false, so a page hides quiz rows rather than failing whole.
 *
 * Both delegate to `entitlement.quizzesVisibleOrThrow`, which also answers
 * false when the quiz runtime is not configured (its own tests cover that), so
 * the pages and the grade totals cannot disagree.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  quizzesVisibleOrThrow: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    entitlement: {
      quizzesVisibleOrThrow: (...a: unknown[]) => mocks.quizzesVisibleOrThrow(...a),
    },
  },
}));

const { quizzesVisibleOrThrow, loadQuizzesVisible } = await import('../classroomProFlag.server');

const CLASSROOM_ID = 'class-1';
const FAILURE = new Error("Can't reach database server at `db.internal:5432`");

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  vi.unstubAllEnvs();
});

describe('quizzesVisibleOrThrow', () => {
  it('reads no AI agent variable: with them unset it answers what the service answers', async () => {
    vi.stubEnv('AI_AGENT_URL', '');
    vi.stubEnv('AI_AGENT_SHARED_SECRET', '');
    mocks.quizzesVisibleOrThrow.mockResolvedValue(true);

    await expect(quizzesVisibleOrThrow(CLASSROOM_ID)).resolves.toBe(true);
    await expect(loadQuizzesVisible(CLASSROOM_ID)).resolves.toBe(true);
  });

  it.each([true, false])('answers what the service answers (%s)', async visible => {
    mocks.quizzesVisibleOrThrow.mockResolvedValue(visible);

    await expect(quizzesVisibleOrThrow(CLASSROOM_ID)).resolves.toBe(visible);
    expect(mocks.quizzesVisibleOrThrow).toHaveBeenCalledWith(CLASSROOM_ID);
  });

  it('throws when the service throws', async () => {
    mocks.quizzesVisibleOrThrow.mockRejectedValue(FAILURE);

    await expect(quizzesVisibleOrThrow(CLASSROOM_ID)).rejects.toBe(FAILURE);
  });
});

describe('loadQuizzesVisible', () => {
  it('answers what the service answers', async () => {
    mocks.quizzesVisibleOrThrow.mockResolvedValue(true);

    await expect(loadQuizzesVisible(CLASSROOM_ID)).resolves.toBe(true);
    expect(mocks.quizzesVisibleOrThrow).toHaveBeenCalledWith(CLASSROOM_ID);
  });

  it('answers false and logs the failure when the service throws', async () => {
    mocks.quizzesVisibleOrThrow.mockRejectedValue(FAILURE);

    await expect(loadQuizzesVisible(CLASSROOM_ID)).resolves.toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[loadQuizzesVisible]'), FAILURE);
  });
});
