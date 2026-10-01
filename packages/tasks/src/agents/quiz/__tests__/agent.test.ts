/**
 * The quiz agent's turn limit per run. Every message and action an attempt
 * sends is a turn of the run that reads it, a refused one included, and the
 * SDK reads the next message before it checks `maxTurns`: the run then ends
 * without answering that message. So the limit sits above everything one
 * attempt sends, with room to spare. The SDK and services are faked:
 * `chat.agent` hands back the options it was given.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@trigger.dev/sdk/ai', () => ({
  chat: { agent: (options: unknown) => options, close: vi.fn() },
}));
vi.mock('@classmoji/database', () => ({ default: () => ({}) }));
vi.mock('@classmoji/services', () => ({ ClassmojiService: {}, getGitProvider: vi.fn() }));

const { quizAttemptAgent } = await import('../agent.ts');
const { MAX_STUDENT_TURNS, QUIZ_RUN_MAX_TURNS } = await import('@classmoji/utils/quiz-agent');

/**
 * The turns an attempt's admitted path takes: the begin turn, every message
 * the attempt admits, and the one refused at the limit (which closes the
 * session).
 */
const ADMITTED_PATH_TURNS = 1 + MAX_STUDENT_TURNS + 1;

describe('quizAttemptAgent maxTurns', () => {
  it('is QUIZ_RUN_MAX_TURNS', () => {
    expect((quizAttemptAgent as unknown as { maxTurns?: unknown }).maxTurns).toBe(
      QUIZ_RUN_MAX_TURNS
    );
  });

  it('is above the admitted path, with three times that again for refused and re-delivered messages', () => {
    expect(QUIZ_RUN_MAX_TURNS).toBeGreaterThan(ADMITTED_PATH_TURNS);
    expect(QUIZ_RUN_MAX_TURNS - ADMITTED_PATH_TURNS).toBeGreaterThanOrEqual(
      3 * ADMITTED_PATH_TURNS
    );
  });
});
