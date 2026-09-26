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
 * Neither asks the database when the AI agent is not configured.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isAIAgentConfigured: vi.fn(),
  quizzesVisible: vi.fn(),
}));

vi.mock('~/utils/aiFeatures.server', () => ({
  isAIAgentConfigured: () => mocks.isAIAgentConfigured(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    entitlement: { quizzesVisible: (...a: unknown[]) => mocks.quizzesVisible(...a) },
  },
}));

const { quizzesVisibleOrThrow, loadQuizzesVisible } = await import('../classroomProFlag.server');

const CLASSROOM_ID = 'class-1';
const FAILURE = new Error("Can't reach database server at `db.internal:5432`");

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.isAIAgentConfigured.mockReturnValue(true);
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('quizzesVisibleOrThrow', () => {
  it('answers false without asking the service when the AI agent is not configured', async () => {
    mocks.isAIAgentConfigured.mockReturnValue(false);
    mocks.quizzesVisible.mockResolvedValue(true);

    await expect(quizzesVisibleOrThrow(CLASSROOM_ID)).resolves.toBe(false);
    expect(mocks.quizzesVisible).not.toHaveBeenCalled();
  });

  it.each([true, false])('answers what the service answers (%s)', async visible => {
    mocks.quizzesVisible.mockResolvedValue(visible);

    await expect(quizzesVisibleOrThrow(CLASSROOM_ID)).resolves.toBe(visible);
    expect(mocks.quizzesVisible).toHaveBeenCalledWith(CLASSROOM_ID);
  });

  it('throws when the service throws', async () => {
    mocks.quizzesVisible.mockRejectedValue(FAILURE);

    await expect(quizzesVisibleOrThrow(CLASSROOM_ID)).rejects.toBe(FAILURE);
  });
});

describe('loadQuizzesVisible', () => {
  it('answers false without asking the service when the AI agent is not configured', async () => {
    mocks.isAIAgentConfigured.mockReturnValue(false);
    mocks.quizzesVisible.mockResolvedValue(true);

    await expect(loadQuizzesVisible(CLASSROOM_ID)).resolves.toBe(false);
    expect(mocks.quizzesVisible).not.toHaveBeenCalled();
  });

  it('answers what the service answers', async () => {
    mocks.quizzesVisible.mockResolvedValue(true);

    await expect(loadQuizzesVisible(CLASSROOM_ID)).resolves.toBe(true);
    expect(mocks.quizzesVisible).toHaveBeenCalledWith(CLASSROOM_ID);
  });

  it('answers false and logs the failure when the service throws', async () => {
    mocks.quizzesVisible.mockRejectedValue(FAILURE);

    await expect(loadQuizzesVisible(CLASSROOM_ID)).resolves.toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[loadQuizzesVisible]'), FAILURE);
  });
});
