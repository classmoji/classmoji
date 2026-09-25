/**
 * teamSetSolve.ts — one solve of a team set: the run row's frozen problem in,
 * a proposal (or an infeasibility core) out.
 *
 * The webapp/MCP side (`teamSet.startRun`) compiles the problem, runs the
 * pre-checks, inserts a QUEUED `TeamSetRun` and triggers this task with a bare
 * `{ runId }` (idempotency key `team-set-solve:<runId>`). Everything the solve
 * needs is read back from that row, so a run is reproducible from the database
 * alone and the payload carries no user ids.
 *
 *   loadRunForSolve → markRunning → problem.json in a private temp dir
 *     → python/team_set_solver.py (OR-Tools CP-SAT) → parse the result line
 *     → completeRun (rescores with scoreAssignment; SOLVED / INFEASIBLE / FAILED)
 *
 * A run never touches Team rows. Creating teams from a solved run is the
 * separate, owner-only `team-set-apply` task.
 *
 * ── Only QUEUED runs are solved ────────────────────────────────────────────
 * A row that is RUNNING already belongs to another delivery, or to a solve
 * that died without reaching its catch; the service expires such rows lazily
 * when they are read (no sweeper). Either way this delivery must not solve it
 * a second time, so anything but QUEUED is skipped untouched. The read is only
 * a fast path: `markRunning` moves the row out of QUEUED atomically and says
 * whether this call did it, and a false there is skipped untouched too.
 *
 * ── Failure ────────────────────────────────────────────────────────────────
 * ANY throw — engine missing, killed, non-zero exit, no result line, a result
 * of the wrong shape, a database error — marks the run FAILED with the public
 * code `engine_error`, then rethrows a sanitized error so the Trigger run
 * shows failed too. A run left RUNNING would be polled until the service
 * expires it, so the catch covers every step, and the solver process is
 * killed well inside maxDuration (see `solverKillAfterMs`) so the catch is
 * actually reached. `maxAttempts: 1`: the solver is seeded from the row, so a
 * retry would redo the same work and fail the same way.
 *
 * ── Cancel ─────────────────────────────────────────────────────────────────
 * The run's abort signal is handed to `python.runScript`, so canceling the
 * Trigger run kills the solver at once. The catch then sees `signal.aborted`
 * and records `canceled` instead of `engine_error` (the service maps a code it
 * does not know to `engine_error`). `onCancel` waits for the run function to
 * settle — which is what keeps the process alive long enough for that catch
 * to write — and, only if it has not settled within CANCEL_GRACE_MS (stuck in
 * a database call the signal does not reach), fails the run as `canceled`
 * itself. `failRun` only touches a run that is still QUEUED or RUNNING, so a
 * run that finished first keeps its result.
 *
 * ── Privacy ────────────────────────────────────────────────────────────────
 * The problem holds user ids (no names, no answers). This task never logs it:
 * not the JSON, not the engine's stdout/stderr, and the error it rethrows is
 * sanitized. Its logs carry the run id, closed reason codes and solver numbers
 * only. One thing is outside its control: `python.runScript` wraps the spawn
 * in its own trace span, and on a non-zero exit (a crash, a kill, a cancel)
 * the error that span records embeds the script's whole stdout and stderr.
 * That is why the engine never prints a user id — its output is integers,
 * indices and src strings (rule, pin and option ids); see the docstring of
 * python/team_set_solver.py. The temp dir is created 0700 by mkdtemp and
 * removed in `finally`, whatever happened.
 *
 * ── Machine ────────────────────────────────────────────────────────────────
 * `medium-2x` (2 vCPU / 4 GB) — the smallest preset with two vCPUs; CP-SAT runs
 * two search workers (`--workers 2`), and on the 1-vCPU presets (`small-2x`,
 * `medium-1x`) they would only time-slice one core. At $0.00017/s a default
 * 30s solve costs about half a cent, a 120s one about two cents. The 4 GB also
 * leaves room for the pair-indicator model of a 300-person free-mode set.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { task, logger } from '@trigger.dev/sdk';
import { python } from '@trigger.dev/python';
import { ClassmojiService } from '@classmoji/services';

import {
  TEAM_SET_SOLVER_SCRIPT,
  TEAM_SET_SOLVER_WORKERS,
  classifyEngineError,
  parseSolverOutput,
  solverKillAfterMs,
  useLocalVenvIfUnset,
  type EngineFailureReason,
  type SolverOutput,
} from '../helpers/teamSetEngine.ts';

export interface TeamSetSolvePayload {
  runId: string;
}

/** The step a failure happened in — logged beside the reason, never shown. */
type SolveStage = 'load' | 'mark_running' | 'engine' | 'complete';

/**
 * How long `onCancel` waits for the run function before failing the run
 * itself. Trigger gives cancel hooks 30 s before it kills the process; this
 * leaves room for the write.
 */
export const CANCEL_GRACE_MS = 20_000;

/** true when `promise` settles (either way) within `ms`, false otherwise. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true
      ),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Write the problem to a private temp file, run the solver on it, and parse
 * the final result line. The temp dir is removed on every path; a failure to
 * remove it is logged and swallowed, so a cleanup hiccup never fails a solve.
 */
async function runSolver(
  runId: string,
  problem: { time_limit_s: number },
  signal: AbortSignal | undefined
): Promise<SolverOutput> {
  const dir = await mkdtemp(join(tmpdir(), 'team-set-'));
  try {
    const problemPath = join(dir, 'problem.json');
    await writeFile(problemPath, JSON.stringify(problem), { mode: 0o600 });
    useLocalVenvIfUnset();
    const result = await python.runScript(
      TEAM_SET_SOLVER_SCRIPT,
      [problemPath, '--workers', String(TEAM_SET_SOLVER_WORKERS)],
      { timeout: solverKillAfterMs(problem.time_limit_s), ...(signal ? { signal } : {}) }
    );
    return parseSolverOutput(result.stdout);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      logger.warn('team-set-solve: temp dir cleanup failed', { runId });
    });
  }
}

export const teamSetSolveTask = task({
  id: 'team-set-solve',
  machine: 'medium-2x',
  // The solver's own limit is at most 120s (TeamSetConfig.time_limit_s); the
  // kill timer caps the process at 260s, leaving room for load and complete.
  maxDuration: 300,
  retry: { maxAttempts: 1 },
  // Five solves platform-wide: each holds two vCPUs for up to two minutes, and
  // a burst of re-runs from one impatient editor should queue, not fan out.
  queue: { concurrencyLimit: 5 },
  run: async ({ runId }: TeamSetSolvePayload, { ctx, signal }) => {
    let stage: SolveStage = 'load';
    try {
      const { run: queued, problem } = await ClassmojiService.teamSet.loadRunForSolve(runId);
      // Canceled, already finished, or RUNNING under another delivery (see
      // the header): nothing to do, and no solver time to spend.
      if (queued.status !== 'QUEUED') {
        logger.info('team-set-solve: run is not queued; skipping', {
          runId,
          status: queued.status,
        });
        return { status: queued.status };
      }

      stage = 'mark_running';
      // Only from QUEUED, atomically: a concurrent delivery (or an expiry)
      // that moved the row between the read above and here wins, and this one
      // leaves the row alone.
      if (!(await ClassmojiService.teamSet.markRunning(runId, ctx.run.id))) {
        logger.info('team-set-solve: run was claimed elsewhere; skipping', { runId });
        return { status: 'skipped' as const };
      }

      stage = 'engine';
      const output = await runSolver(runId, problem, signal);

      stage = 'complete';
      const run = await ClassmojiService.teamSet.completeRun(runId, output);

      logger.info('team-set-solve: finished', {
        runId,
        status: run.status,
        solver: output.status,
        objective: output.objective,
        bound: output.bound,
        wall_s: output.wall_s,
        teams: output.teams.length,
        core_status: output.core_status,
        engine: output.engine,
        stats: output.stats,
        // MODEL_INVALID only; names IR entries by index, never an id.
        ...(output.message ? { message: output.message } : {}),
      });
      return { status: run.status };
    } catch (error: unknown) {
      const reason: EngineFailureReason = signal?.aborted ? 'canceled' : classifyEngineError(error);
      logger.error('team-set-solve: failed', { runId, stage, reason });
      await ClassmojiService.teamSet
        .failRun(runId, reason === 'canceled' ? 'canceled' : 'engine_error')
        .catch(() => {
          logger.error('team-set-solve: could not mark the run failed', { runId });
        });
      // Sanitized on purpose: the original error can embed the engine's whole
      // stdout/stderr, and a thrown message lands in the Trigger dashboard.
      throw new Error(`team-set-solve failed at ${stage}: ${reason}`);
    }
  },
  onCancel: async ({ payload, runPromise }) => {
    // A run function that settles has already recorded its own outcome
    // (canceled in its catch, or a result, or a skip that must not touch a row
    // another delivery owns). Only one still stuck after the grace is failed
    // from here.
    if (await settlesWithin(runPromise, CANCEL_GRACE_MS)) return;
    logger.warn('team-set-solve: canceled run did not stop in time; failing it', {
      runId: payload.runId,
    });
    await ClassmojiService.teamSet.failRun(payload.runId, 'canceled').catch(() => {
      logger.error('team-set-solve: could not mark the canceled run failed', {
        runId: payload.runId,
      });
    });
  },
});
