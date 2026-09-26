/**
 * Unit tests for the team-set solve task's wiring and the engine's stdout
 * parser (the engine itself is covered by teamSetEngine.crosscheck.test.ts,
 * against real Python).
 *
 * What matters here:
 *  - the solver is invoked as the contract says (script path, temp problem
 *    file, `--workers 2`, a kill timeout inside maxDuration, the run's abort
 *    signal);
 *  - the final result line is parsed past progress lines and handed to
 *    completeRun, new optional fields (core_status, engine, stats) included;
 *  - ANY failure marks the run FAILED with `engine_error` and rethrows a
 *    SANITIZED error — the engine's stdout never reaches a log or the throw;
 *  - a cancel records `canceled`, and onCancel fails only a run function that
 *    is still stuck after the grace;
 *  - the temp problem file is removed on success and on failure;
 *  - only a QUEUED run is solved.
 *
 * `@trigger.dev/sdk`, `@trigger.dev/python` and `@classmoji/services` are mocked.
 */
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EngineFailure, parseSolverOutput } from '../../helpers/teamSetEngine.ts';

const runScript = vi.fn();
const loadRunForSolve = vi.fn();
const markRunning = vi.fn();
const completeRun = vi.fn();
const failRun = vi.fn();
const loggerInfo = vi.fn();
const loggerWarn = vi.fn();
const loggerError = vi.fn();

vi.mock('@trigger.dev/sdk', () => ({
  task: (config: unknown) => config,
  logger: { info: loggerInfo, warn: loggerWarn, error: loggerError },
}));
vi.mock('@trigger.dev/python', () => ({ python: { runScript } }));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: { teamSet: { loadRunForSolve, markRunning, completeRun, failRun } },
}));

const { teamSetSolveTask, CANCEL_GRACE_MS } = await import('../teamSetSolve.ts');
const solveTask = teamSetSolveTask as unknown as {
  run: (
    payload: { runId: string },
    params: { ctx: { run: { id: string } }; signal: AbortSignal }
  ) => Promise<unknown>;
  onCancel: (params: { payload: { runId: string }; runPromise: Promise<unknown> }) => Promise<void>;
};

const PROBLEM = { version: 1, people: ['u-1', 'u-2'], time_limit_s: 30, seed: 1 };
const RESULT = {
  type: 'result',
  status: 'OPTIMAL',
  teams: [{ slot: 0, members: [0, 1] }],
  objective: 12,
  bound: 12,
  wall_s: 0.4,
  core: [],
  core_status: 'n/a',
  engine: 'cpsat@9.15.6755',
  stats: { people: 2, slots: 1, pairs: 0, build_s: 0.001 },
};

let controller: AbortController;
const params = () => ({ ctx: { run: { id: 'run_trigger_1' } }, signal: controller.signal });
const run = (runId: string) => solveTask.run({ runId }, params());

/** Every string any logger mock was called with, flattened. */
const logged = () =>
  JSON.stringify([...loggerInfo.mock.calls, ...loggerWarn.mock.calls, ...loggerError.mock.calls]);

describe('team-set-solve', () => {
  let problemPath: string | null;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new AbortController();
    problemPath = null;
    loadRunForSolve.mockResolvedValue({ run: { status: 'QUEUED' }, problem: PROBLEM });
    markRunning.mockResolvedValue(true);
    completeRun.mockResolvedValue({ status: 'SOLVED' });
    failRun.mockResolvedValue(undefined);
    runScript.mockImplementation(async (_script: string, args: string[]) => {
      problemPath = args[0]!;
      // The file exists while the solver runs, and holds the problem.
      expect(JSON.parse(readFileSync(problemPath, 'utf8'))).toEqual(PROBLEM);
      return {
        stdout: [
          JSON.stringify({ type: 'progress', objective: 40, bound: 0, elapsed: 0.1 }),
          JSON.stringify(RESULT),
          '',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      };
    });
  });

  it('solves: marks running, runs the script with --workers 2, completes with the result line', async () => {
    await expect(run('r1')).resolves.toEqual({ status: 'SOLVED' });

    expect(markRunning).toHaveBeenCalledWith('r1', 'run_trigger_1');
    const [script, args, options] = runScript.mock.calls[0]!;
    expect(script).toBe('./python/team_set_solver.py');
    expect(args.slice(1)).toEqual(['--workers', '2']);
    expect(options.timeout).toBeLessThanOrEqual(260_000);
    expect(options.signal).toBe(controller.signal);
    const { type: _type, ...output } = RESULT;
    expect(completeRun).toHaveBeenCalledWith('r1', output);
    expect(failRun).not.toHaveBeenCalled();
    expect(existsSync(problemPath!)).toBe(false);
  });

  it('leaves the row alone when markRunning did not move it out of QUEUED', async () => {
    markRunning.mockResolvedValue(false);

    await expect(run('r0')).resolves.toEqual({ status: 'skipped' });
    expect(runScript).not.toHaveBeenCalled();
    expect(completeRun).not.toHaveBeenCalled();
    expect(failRun).not.toHaveBeenCalled();
  });

  it('fails the run with engine_error when there is no result line', async () => {
    runScript.mockImplementation(async (_script: string, args: string[]) => {
      problemPath = args[0]!;
      return { stdout: '{"type":"progress","objective":1}\n', stderr: '', exitCode: 0 };
    });

    await expect(run('r2')).rejects.toThrow('engine: no_result_line');
    expect(failRun).toHaveBeenCalledWith('r2', 'engine_error');
    expect(completeRun).not.toHaveBeenCalled();
    expect(existsSync(problemPath!)).toBe(false);
  });

  it('never logs or rethrows the engine output of a non-zero exit', async () => {
    runScript.mockImplementation(async (_script: string, args: string[]) => {
      problemPath = args[0]!;
      throw new Error(
        `./python/team_set_solver.py ${args.join(' ')} exited with a non-zero code 2:\n` +
          '{"type":"error","code":"bad_input","message":"people[3] u-secret-id"}\n'
      );
    });

    const error = await run('r3').catch((e: Error) => e);
    expect((error as Error).message).toBe('team-set-solve failed at engine: bad_input');
    expect(failRun).toHaveBeenCalledWith('r3', 'engine_error');
    expect(logged()).not.toContain('u-secret-id');
    expect(existsSync(problemPath!)).toBe(false);
  });

  it('fails the run when completeRun throws, and still cleans up', async () => {
    completeRun.mockRejectedValue(new Error('db down'));

    await expect(run('r4')).rejects.toThrow('team-set-solve failed at complete');
    expect(failRun).toHaveBeenCalledWith('r4', 'engine_error');
    expect(existsSync(problemPath!)).toBe(false);
  });

  it.each(['CANCELED', 'RUNNING', 'SOLVED'])('skips a %s run without solving', async status => {
    loadRunForSolve.mockResolvedValue({ run: { status }, problem: PROBLEM });

    await expect(run('r5')).resolves.toEqual({ status });
    expect(markRunning).not.toHaveBeenCalled();
    expect(runScript).not.toHaveBeenCalled();
    expect(failRun).not.toHaveBeenCalled();
  });

  it('records a cancel during the solve as canceled, not engine_error', async () => {
    runScript.mockImplementation(async (_script: string, args: string[]) => {
      problemPath = args[0]!;
      // What runScript does on a cancel: tinyexec swallows the AbortError, the
      // killed process has no exit code, and runScript reports a non-zero exit.
      controller.abort();
      throw new Error(`${args.join(' ')} exited with a non-zero code null:\n{"type":"progress"}\n`);
    });

    await expect(run('r6')).rejects.toThrow('team-set-solve failed at engine: canceled');
    expect(failRun).toHaveBeenCalledWith('r6', 'canceled');
    expect(completeRun).not.toHaveBeenCalled();
    expect(existsSync(problemPath!)).toBe(false);
  });

  it('logs a MODEL_INVALID message (indices only) and still completes the run', async () => {
    runScript.mockResolvedValue({
      stdout: `${JSON.stringify({
        ...RESULT,
        status: 'MODEL_INVALID',
        teams: [],
        objective: null,
        bound: null,
        message: 'balance[0].values[3] is 250; balance values must be within [-100, 100]',
      })}\n`,
      stderr: '',
      exitCode: 0,
    });
    completeRun.mockResolvedValue({ status: 'FAILED' });

    await expect(run('r7')).resolves.toEqual({ status: 'FAILED' });
    expect(completeRun.mock.calls[0]![1]).toMatchObject({ status: 'MODEL_INVALID' });
    expect(logged()).toContain('balance[0].values[3]');
  });

  describe('onCancel', () => {
    afterEach(() => vi.useRealTimers());

    it('leaves the outcome to a run function that settles', async () => {
      await solveTask.onCancel({ payload: { runId: 'r8' }, runPromise: Promise.resolve() });
      await solveTask.onCancel({
        payload: { runId: 'r8' },
        runPromise: Promise.reject(new Error('team-set-solve failed at engine: canceled')),
      });
      expect(failRun).not.toHaveBeenCalled();
    });

    it('fails the run as canceled when the run function is still stuck after the grace', async () => {
      vi.useFakeTimers();
      const pending = solveTask.onCancel({
        payload: { runId: 'r9' },
        runPromise: new Promise(() => {}),
      });
      await vi.advanceTimersByTimeAsync(CANCEL_GRACE_MS);
      await pending;
      expect(failRun).toHaveBeenCalledWith('r9', 'canceled');
    });
  });
});

describe('parseSolverOutput', () => {
  const line = (extra: Record<string, unknown>) => `${JSON.stringify({ ...RESULT, ...extra })}\n`;
  const reason = (stdout: string) => {
    try {
      parseSolverOutput(stdout);
      return null;
    } catch (error) {
      return (error as EngineFailure).reason;
    }
  };

  it('passes core_status, engine and stats through', () => {
    const { type: _type, ...output } = RESULT;
    expect(parseSolverOutput(line({}))).toEqual(output);
  });

  it('accepts a line from an engine without the optional fields', () => {
    const parsed = parseSolverOutput(
      line({ core_status: undefined, engine: undefined, stats: undefined })
    );
    expect(parsed).not.toHaveProperty('core_status');
    expect(parsed).not.toHaveProperty('engine');
    expect(parsed).not.toHaveProperty('stats');
  });

  it('keeps an infeasible answer that ran out of time distinguishable from a structural one', () => {
    const parsed = parseSolverOutput(
      line({
        status: 'INFEASIBLE',
        teams: [],
        objective: null,
        bound: null,
        core_status: 'timeout',
      })
    );
    expect(parsed).toMatchObject({ status: 'INFEASIBLE', core: [], core_status: 'timeout' });
  });

  it.each([
    ['an unknown core_status', { core_status: 'partial' }],
    ['an engine that is not cpsat@<version>', { engine: 'cpsat@9.15 u-1' }],
    ['stats with a negative count', { stats: { ...RESULT.stats, pairs: -1 } }],
    ['stats without build_s', { stats: { people: 2, slots: 1, pairs: 0 } }],
    ['a non-string message', { message: 42 }],
  ])('rejects %s as bad_result', (_name, extra) => {
    expect(reason(line(extra))).toBe('bad_result');
  });
});
