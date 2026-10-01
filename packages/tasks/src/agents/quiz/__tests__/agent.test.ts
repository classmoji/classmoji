/**
 * The quiz agent's run limits.
 *
 * - Turns: every message and action an attempt sends is a turn of the run
 *   that reads it, a refused one included, and the SDK reads the next message
 *   before it checks `maxTurns`: the run then ends without answering that
 *   message. So the limit sits above everything one attempt sends, with room
 *   to spare.
 * - Compute: after every turn the agent ends the run once it has used its
 *   compute budget (`chat.endRun()`), with room left for one more turn and the
 *   wait before it, so a run never reaches its `maxDuration` mid-turn.
 *
 * The SDK and services are faked: `chat.agent` hands back the options it was
 * given, and `usage.getCurrent()` reports the compute a test sets.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({
  endRun: vi.fn(),
  computeMs: 0,
}));

vi.mock('@trigger.dev/sdk/ai', () => ({
  chat: { agent: (options: unknown) => options, close: vi.fn(), endRun: fakes.endRun },
}));
vi.mock('@trigger.dev/sdk', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  usage: {
    getCurrent: () => ({
      compute: {
        attempt: { durationMs: fakes.computeMs, costInCents: 0 },
        total: { durationMs: fakes.computeMs, costInCents: 0 },
      },
    }),
  },
}));
vi.mock('@classmoji/database', () => ({ default: () => ({}) }));
vi.mock('@classmoji/services', () => ({ ClassmojiService: {}, getGitProvider: vi.fn() }));

const { quizAttemptAgent } = await import('../agent.ts');
const { TURN_DEADLINE_MS } = await import('../loop.ts');
const {
  MAX_STUDENT_TURNS,
  QUIZ_RUN_COMPUTE_BUDGET_MS,
  QUIZ_RUN_MAX_DURATION_SECONDS,
  QUIZ_RUN_MAX_TURNS,
  QUIZ_RUN_ROLLOVER_MARGIN_MS,
} = await import('@classmoji/utils/quiz-agent');

type TurnCompleteEvent = { chatId: string; turn: number; runId: string };
const agent = quizAttemptAgent as unknown as {
  maxTurns?: unknown;
  maxDuration?: unknown;
  idleTimeoutInSeconds: number;
  onTurnComplete: (event: TurnCompleteEvent) => Promise<void>;
};

/**
 * The turns an attempt's admitted path takes: the begin turn, every message
 * the attempt admits, and the one refused at the limit (which closes the
 * session).
 */
const ADMITTED_PATH_TURNS = 1 + MAX_STUDENT_TURNS + 1;

beforeEach(() => {
  fakes.endRun.mockClear();
  fakes.computeMs = 0;
});

describe('quizAttemptAgent maxTurns', () => {
  it('is QUIZ_RUN_MAX_TURNS', () => {
    expect(agent.maxTurns).toBe(QUIZ_RUN_MAX_TURNS);
  });

  it('is above the admitted path, with three times that again for refused and re-delivered messages', () => {
    expect(QUIZ_RUN_MAX_TURNS).toBeGreaterThan(ADMITTED_PATH_TURNS);
    expect(QUIZ_RUN_MAX_TURNS - ADMITTED_PATH_TURNS).toBeGreaterThanOrEqual(
      3 * ADMITTED_PATH_TURNS
    );
  });
});

describe('quizAttemptAgent compute budget', () => {
  it('runs for QUIZ_RUN_MAX_DURATION_SECONDS, ending between turns at the budget', () => {
    expect(agent.maxDuration).toBe(QUIZ_RUN_MAX_DURATION_SECONDS);
    expect(QUIZ_RUN_COMPUTE_BUDGET_MS).toBe(
      QUIZ_RUN_MAX_DURATION_SECONDS * 1_000 - QUIZ_RUN_ROLLOVER_MARGIN_MS
    );
    expect(QUIZ_RUN_COMPUTE_BUDGET_MS).toBeGreaterThan(0);
  });

  it('keeps room for one more turn at its deadline and the idle wait before it, with slack', () => {
    expect(QUIZ_RUN_ROLLOVER_MARGIN_MS).toBeGreaterThan(
      TURN_DEADLINE_MS + agent.idleTimeoutInSeconds * 1_000
    );
  });

  it('keeps the run under the budget', async () => {
    fakes.computeMs = QUIZ_RUN_COMPUTE_BUDGET_MS - 1;
    await agent.onTurnComplete({ chatId: 'attempt-1', turn: 41, runId: 'run_1' });
    expect(fakes.endRun).not.toHaveBeenCalled();
  });

  it('ends the run at the budget, logging ids and counts only', async () => {
    const lines: unknown[][] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args);
    });
    try {
      fakes.computeMs = QUIZ_RUN_COMPUTE_BUDGET_MS + 0.4;
      await agent.onTurnComplete({ chatId: 'attempt-1', turn: 41, runId: 'run_1' });
    } finally {
      spy.mockRestore();
    }
    expect(fakes.endRun).toHaveBeenCalledTimes(1);
    const rollover = lines.find(args => args[0] === '[quiz-agent] run rollover');
    expect(rollover).toBeDefined();
    expect(JSON.parse(String(rollover?.[1]))).toEqual({
      attemptId: 'attempt-1',
      runId: 'run_1',
      turnsInRun: 42,
      usedMs: QUIZ_RUN_COMPUTE_BUDGET_MS,
    });
  });
});
