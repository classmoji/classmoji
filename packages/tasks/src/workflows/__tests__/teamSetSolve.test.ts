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
 *  - a version-2 problem is written exactly as the run row holds it, and a
 *    two-stage (group) problem's `stages` reach completeRun; a group result
 *    without them (or a non-group result with them) is `bad_result`;
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

  it('passes a version-2 group problem through unchanged and completes with its stages', async () => {
    const problem = {
      ...PROBLEM,
      version: 2,
      people: ['u-1', 'u-2', 'u-3', 'u-4'],
      options: [{ id: 'o-1', open: 'auto', size: { min: 2, max: 3 } }],
      group: { src: 'non_respondents', members: [2, 3], option_cost: [0] },
    };
    const stages = {
      first: { status: 'OPTIMAL', objective: 10, bound: 10 },
      second: { status: 'OPTIMAL', objective: 2 },
    };
    loadRunForSolve.mockResolvedValue({ run: { status: 'QUEUED' }, problem });
    runScript.mockImplementation(async (_script: string, args: string[]) => {
      problemPath = args[0]!;
      expect(JSON.parse(readFileSync(problemPath, 'utf8'))).toEqual(problem);
      return { stdout: `${JSON.stringify({ ...RESULT, stages })}\n`, stderr: '', exitCode: 0 };
    });

    await expect(run('r10')).resolves.toEqual({ status: 'SOLVED' });
    expect(completeRun.mock.calls[0]![1]).toMatchObject({ objective: 12, stages });
    expect(logged()).toContain('"stages"');
    expect(existsSync(problemPath!)).toBe(false);
  });

  it('fails a group problem whose result line has no stages', async () => {
    loadRunForSolve.mockResolvedValue({
      run: { status: 'QUEUED' },
      problem: {
        ...PROBLEM,
        version: 2,
        group: { src: 'non_respondents', members: [1], option_cost: [0] },
      },
    });
    runScript.mockImplementation(async (_script: string, args: string[]) => {
      problemPath = args[0]!;
      return { stdout: `${JSON.stringify(RESULT)}\n`, stderr: '', exitCode: 0 };
    });

    await expect(run('r11')).rejects.toThrow('team-set-solve failed at engine: bad_result');
    expect(failRun).toHaveBeenCalledWith('r11', 'engine_error');
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
  /** A problem without a group (versions 1 and 2 alike). */
  const SINGLE = {};
  /** A two-stage problem; parseSolverOutput only asks whether it has a group. */
  const GROUP = { group: { src: 'non_respondents', members: [1], option_cost: [0] } };
  const reason = (stdout: string, problem: { group?: unknown } = SINGLE) => {
    try {
      parseSolverOutput(stdout, problem);
      return null;
    } catch (error) {
      return (error as EngineFailure).reason;
    }
  };

  it('passes core_status, engine and stats through', () => {
    const { type: _type, ...output } = RESULT;
    expect(parseSolverOutput(line({}), SINGLE)).toEqual(output);
  });

  it('accepts a line from an engine without the optional fields', () => {
    const parsed = parseSolverOutput(
      line({ core_status: undefined, engine: undefined, stats: undefined }),
      SINGLE
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
      }),
      SINGLE
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

  describe('stages (two-stage group problems)', () => {
    const STAGES = {
      first: { status: 'OPTIMAL', objective: 10, bound: 10 },
      second: { status: 'OPTIMAL', objective: 2 },
    };

    it('passes stages through for a group problem, dropping unknown keys', () => {
      const parsed = parseSolverOutput(
        line({
          stages: {
            first: { ...STAGES.first, extra: 1 },
            second: { ...STAGES.second, extra: 2 },
            third: null,
          },
        }),
        GROUP
      );
      expect(parsed.stages).toEqual(STAGES);
    });

    it('accepts the shapes a group problem can end in', () => {
      // Stage 2 found no room: INFEASIBLE, no teams, stage 1's numbers kept.
      const noRoom = parseSolverOutput(
        line({
          status: 'INFEASIBLE',
          teams: [],
          objective: null,
          bound: null,
          core: ['non_respondents'],
          core_status: 'complete',
          stages: { first: STAGES.first, second: { status: 'INFEASIBLE', objective: null } },
        }),
        GROUP
      );
      expect(noRoom.stages?.second).toEqual({ status: 'INFEASIBLE', objective: null });
      // Stage 1 found nothing: stage 2 never ran.
      const stageOne = parseSolverOutput(
        line({
          status: 'INFEASIBLE',
          teams: [],
          objective: null,
          bound: null,
          core: ['pin:p1'],
          core_status: 'complete',
          stages: { first: { status: 'INFEASIBLE', objective: null, bound: null }, second: null },
        }),
        GROUP
      );
      expect(stageOne.stages?.second).toBeNull();
      // Stage 1 timed out with an answer: FEASIBLE overall, bound null.
      const timedOut = parseSolverOutput(
        line({
          status: 'FEASIBLE',
          bound: null,
          stages: {
            first: { ...STAGES.first, status: 'FEASIBLE', bound: 4 },
            second: STAGES.second,
          },
        }),
        GROUP
      );
      expect(timedOut.stages?.first.status).toBe('FEASIBLE');
    });

    it('treats a null group as no group', () => {
      expect(reason(line({}), { group: null })).toBeNull();
      expect(reason(line({ stages: STAGES }), { group: null })).toBe('bad_result');
    });

    it.each([
      ['a group problem without stages', {}, GROUP],
      ['a problem without a group with stages', { stages: STAGES }, SINGLE],
      ['stages that are not an object', { stages: [STAGES.first] }, GROUP],
      ['stages without first', { stages: { second: STAGES.second } }, GROUP],
      ['stages without second', { stages: { first: STAGES.first } }, GROUP],
      [
        'an unknown stage status',
        { stages: { ...STAGES, first: { ...STAGES.first, status: 'DONE' } } },
        GROUP,
      ],
      [
        'a fractional stage objective',
        {
          stages: {
            first: { ...STAGES.first, objective: 9.5 },
            second: { ...STAGES.second, objective: 2.5 },
          },
        },
        GROUP,
      ],
      [
        'a stage bound that is a string',
        { stages: { ...STAGES, first: { ...STAGES.first, bound: '10' } } },
        GROUP,
      ],
      [
        'stage objectives that do not add up to the objective',
        { stages: { ...STAGES, second: { ...STAGES.second, objective: 3 } } },
        GROUP,
      ],
      ['an objective without a second stage', { stages: { ...STAGES, second: null } }, GROUP],
      [
        'OPTIMAL with a stage that is not',
        { stages: { ...STAGES, second: { ...STAGES.second, status: 'FEASIBLE' } } },
        GROUP,
      ],
    ])('rejects %s as bad_result', (_name, extra, problem) => {
      expect(reason(line(extra), problem)).toBe('bad_result');
    });
  });
});
