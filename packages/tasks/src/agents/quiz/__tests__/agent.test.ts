/**
 * The quiz agent's run limits as the agent wires them (the limits themselves
 * and the budget's boundaries are in runBudget.test.ts):
 *
 * - `maxTurns` and `maxDuration` are the run limits;
 * - the margin leaves room for one more turn at its deadline and the idle
 *   wait before it;
 * - after a turn, the run ends (`chat.endRun()`) once this execution's
 *   compute reaches the budget, measured as `maxDuration` is: the attempt's,
 *   not the run's total across retries.
 *
 * The SDK and services are faked: `chat.agent` hands back the options it was
 * given, and `usage.getCurrent()` reports the attempt and total compute a test
 * sets, always different so that reading the wrong one fails.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({
  endRun: vi.fn(),
  attemptMs: 0,
  totalMs: 0,
}));

vi.mock('@trigger.dev/sdk/ai', () => ({
  chat: { agent: (options: unknown) => options, close: vi.fn(), endRun: fakes.endRun },
}));
vi.mock('@trigger.dev/sdk', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  usage: {
    getCurrent: () => ({
      compute: {
        attempt: { durationMs: fakes.attemptMs, costInCents: 0 },
        total: { durationMs: fakes.totalMs, costInCents: 0 },
      },
    }),
  },
}));
vi.mock('@classmoji/database', () => ({ default: () => ({}) }));
vi.mock('@classmoji/services', () => ({ ClassmojiService: {}, getGitProvider: vi.fn() }));

const { quizAttemptAgent } = await import('../agent.ts');
const { TURN_DEADLINE_MS } = await import('../loop.ts');
const {
  QUIZ_RUN_COMPUTE_BUDGET_MS,
  QUIZ_RUN_MAX_DURATION_SECONDS,
  QUIZ_RUN_MAX_TURNS,
  QUIZ_RUN_ROLLOVER_MARGIN_MS,
} = await import('../runBudget.ts');

type TurnCompleteEvent = { chatId: string; turn: number; runId: string };
const agent = quizAttemptAgent as unknown as {
  maxTurns?: unknown;
  maxDuration?: unknown;
  idleTimeoutInSeconds: number;
  onTurnComplete: (event: TurnCompleteEvent) => Promise<void>;
};

beforeEach(() => {
  fakes.endRun.mockClear();
  fakes.attemptMs = 0;
  fakes.totalMs = 0;
});

describe('quizAttemptAgent run limits', () => {
  it('are QUIZ_RUN_MAX_TURNS and QUIZ_RUN_MAX_DURATION_SECONDS', () => {
    expect(agent.maxTurns).toBe(QUIZ_RUN_MAX_TURNS);
    expect(agent.maxDuration).toBe(QUIZ_RUN_MAX_DURATION_SECONDS);
  });

  it('keep room for one more turn at its deadline and the idle wait before it, with slack', () => {
    expect(QUIZ_RUN_ROLLOVER_MARGIN_MS).toBeGreaterThan(
      TURN_DEADLINE_MS + agent.idleTimeoutInSeconds * 1_000
    );
  });
});

describe('quizAttemptAgent onTurnComplete', () => {
  it('keeps a run whose attempt is under the budget, whatever earlier attempts used', async () => {
    fakes.attemptMs = QUIZ_RUN_COMPUTE_BUDGET_MS / 2;
    fakes.totalMs = QUIZ_RUN_COMPUTE_BUDGET_MS + 600_000;
    await agent.onTurnComplete({ chatId: 'attempt-1', turn: 41, runId: 'run_1' });
    expect(fakes.endRun).not.toHaveBeenCalled();
  });

  it("ends a run whose attempt is over the budget, logging ids and the attempt's compute only", async () => {
    const lines: unknown[][] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args);
    });
    try {
      fakes.attemptMs = QUIZ_RUN_COMPUTE_BUDGET_MS + 60_000.4;
      fakes.totalMs = QUIZ_RUN_COMPUTE_BUDGET_MS + 900_000;
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
      usedMs: QUIZ_RUN_COMPUTE_BUDGET_MS + 60_000,
    });
  });
});
