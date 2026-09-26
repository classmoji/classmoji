/**
 * teamSetEngine.ts — the Node side of the team-set solver's stdout contract.
 *
 * `python/team_set_solver.py <problem.json> --workers N` prints zero or more
 * `{"type":"progress",…}` lines while CP-SAT improves, then exactly ONE
 * `{"type":"result",…}` line carrying the SolverOutput, and exits 0 — even for
 * an infeasible model, which is an answer, not a failure. Malformed input exits
 * 2 with a `{"type":"error","code":…}` line instead.
 *
 * This module is pure (no Trigger, no Prisma, no services import) so the
 * cross-check test can run the real script through `child_process` and parse
 * its output with the same function the task uses.
 *
 * ── Why the result is validated, not just JSON.parse'd ──────────────────────
 * `completeRun` rescores the assignment and refuses a mismatch, but it trusts
 * the SHAPE it is handed. A result line with a missing `teams` or a string
 * objective would surface there as a TypeError deep in the scorer; here it is
 * a named `bad_result` before anything touches the database.
 *
 * ── Why failures carry a reason and not the output ──────────────────────────
 * The problem file holds user ids, and a non-zero exit's error message embeds
 * the script's whole stdout and stderr. `EngineFailure.reason` is a closed code
 * that is safe to log; nothing in this module ever echoes engine output.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Path of the solver as `python.runScript` sees it — relative to the task
 * process's cwd, which is `packages/tasks` under `trigger dev` and `/app` in a
 * deployed image; the build extension copies `python/**` to the same relative
 * path in both. */
export const TEAM_SET_SOLVER_SCRIPT = './python/team_set_solver.py';

/** CP-SAT search workers. Two, on a 2-vCPU machine (see teamSetSolve.ts). */
export const TEAM_SET_SOLVER_WORKERS = 2;

/** The local venv's interpreter (python/README.md), relative to the same cwd. */
export const LOCAL_VENV_PYTHON = './python/.venv/bin/python';

/**
 * Point `python.runScript` at the local venv when nothing else has.
 *
 * `runScript` spawns `process.env.PYTHON_BIN_PATH || 'python'`. Deployed images
 * set PYTHON_BIN_PATH=/opt/venv/bin/python (the build extension's layer), so
 * this is a no-op there — and the image has no `.venv` anyway (the scripts
 * glob skips dot-directories). Under `trigger dev` the extension's
 * `devPythonBinaryPath` is meant to set it, but the 4.6.3 CLI snapshots the
 * run processes' environment when the dev supervisor starts, BEFORE the first
 * build runs the extension that sets it, so a dev run would fall back to a bare
 * `python` without OR-Tools. The dev run's cwd is packages/tasks, where the
 * venv lives, so the same relative path finds it. No new env var involved.
 */
export function useLocalVenvIfUnset(): void {
  if (process.env.PYTHON_BIN_PATH) return;
  const venvPython = resolve(LOCAL_VENV_PYTHON);
  if (existsSync(venvPython)) process.env.PYTHON_BIN_PATH = venvPython;
}

/** Mirrors the service's SolverOutput (teamSet.service.ts). Kept structural
 * here so this module stays importable without the services package. */
export type SolverStatus = 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE' | 'UNKNOWN' | 'MODEL_INVALID';

/**
 * How far the infeasibility explanation got (python/README.md):
 *  - `complete` — INFEASIBLE and `core` is proven minimal; an EMPTY core then
 *    means the structure itself (sizes, slots, team_count) cannot fit.
 *  - `timeout`  — INFEASIBLE but core extraction ran out of time: `core` is what
 *    was found (possibly empty, possibly not minimal). An empty core here says
 *    nothing about structure — never present it as "the sizes don't fit".
 *  - `n/a`      — the status is not INFEASIBLE.
 */
export type CoreStatus = 'complete' | 'timeout' | 'n/a';

/** Model-size numbers for logs and diagnostics (counts only, no ids). */
export interface SolverStats {
  people: number;
  slots: number;
  /** Pair-cost entries after merging duplicates. */
  pairs: number;
  /** Seconds spent building the main CP-SAT model. */
  build_s: number;
}

export interface SolverOutput {
  status: SolverStatus;
  teams: { slot: number; members: number[] }[];
  objective: number | null;
  bound: number | null;
  wall_s: number;
  core: string[];
  /** Optional so an older engine's line still parses; the current one always sends them. */
  core_status?: CoreStatus;
  /** `cpsat@<ortools version>` — what the run row's `engine` should record. */
  engine?: string;
  stats?: SolverStats;
  /** Only with MODEL_INVALID: why, naming IR entries by index (no ids). */
  message?: string;
}

const SOLVER_STATUSES: ReadonlySet<string> = new Set<SolverStatus>([
  'OPTIMAL',
  'FEASIBLE',
  'INFEASIBLE',
  'UNKNOWN',
  'MODEL_INVALID',
]);

const CORE_STATUSES: ReadonlySet<string> = new Set<CoreStatus>(['complete', 'timeout', 'n/a']);

/** `cpsat@9.15.6755` — short, and nothing but a version after the `@`. */
const ENGINE_PATTERN = /^cpsat@[0-9A-Za-z.+-]{1,32}$/;

/** A MODEL_INVALID message is diagnostic text for logs; cap what is kept. */
const MAX_MESSAGE_LENGTH = 500;

/**
 * Closed vocabulary for why a solve produced no usable answer. Logged and put
 * in the thrown error's message; never shown to users (the run row gets the
 * single public code `engine_error`).
 */
export type EngineFailureReason =
  | 'no_result_line'
  | 'bad_result'
  | 'script_missing'
  | 'spawn_failed'
  | 'timeout'
  | 'canceled'
  | 'nonzero_exit'
  | 'bad_input'
  | 'unexpected';

export class EngineFailure extends Error {
  readonly reason: EngineFailureReason;
  constructor(reason: EngineFailureReason) {
    super(`team-set engine failure: ${reason}`);
    this.name = 'EngineFailure';
    this.reason = reason;
  }
}

/**
 * How long the solver process may live before it is killed.
 *
 * CP-SAT honours `time_limit_s` itself; this is the backstop for a process that
 * does not come back (a hung import, a re-solve for the infeasibility core that
 * runs long). Twice the limit plus startup headroom, capped so the kill — and
 * the `failRun` after it — always lands inside the task's 300s maxDuration.
 * A run killed by maxDuration instead would never reach its catch and would sit
 * RUNNING forever.
 */
export function solverKillAfterMs(timeLimitS: number): number {
  const limit = Number.isFinite(timeLimitS) && timeLimitS > 0 ? timeLimitS : 30;
  return Math.min(2 * limit + 30, 260) * 1000;
}

const isInt = (value: unknown): value is number => Number.isSafeInteger(value);
const isNumOrNull = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value));

/**
 * Parse the solver's stdout into a SolverOutput.
 *
 * Scans from the END for the last line that parses as `{"type":"result"}`, so
 * progress lines (and any stray non-JSON output a library prints) are ignored.
 * Throws EngineFailure('no_result_line') when there is none and
 * EngineFailure('bad_result') when the line does not have the contract's shape.
 */
export function parseSolverOutput(stdout: string): SolverOutput {
  const lines = stdout.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    if (!line.startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || (parsed as { type?: unknown }).type !== 'result') {
      continue;
    }
    return validateResult(parsed as Record<string, unknown>);
  }
  throw new EngineFailure('no_result_line');
}

function validateResult(raw: Record<string, unknown>): SolverOutput {
  const { status, teams, objective, bound, wall_s, core } = raw;
  if (typeof status !== 'string' || !SOLVER_STATUSES.has(status))
    throw new EngineFailure('bad_result');
  if (!Array.isArray(teams)) throw new EngineFailure('bad_result');
  const parsedTeams = teams.map(team => {
    if (!team || typeof team !== 'object') throw new EngineFailure('bad_result');
    const { slot, members } = team as { slot?: unknown; members?: unknown };
    if (!isInt(slot) || slot < 0) throw new EngineFailure('bad_result');
    if (!Array.isArray(members) || !members.every(m => isInt(m) && m >= 0)) {
      throw new EngineFailure('bad_result');
    }
    return { slot, members: members as number[] };
  });
  if (!isNumOrNull(objective) || !isNumOrNull(bound)) throw new EngineFailure('bad_result');
  if (typeof wall_s !== 'number' || !Number.isFinite(wall_s)) throw new EngineFailure('bad_result');
  const parsedCore = core === undefined ? [] : core;
  if (!Array.isArray(parsedCore) || !parsedCore.every(src => typeof src === 'string')) {
    throw new EngineFailure('bad_result');
  }
  const output: SolverOutput = {
    status: status as SolverStatus,
    teams: parsedTeams,
    objective,
    bound,
    wall_s,
    core: parsedCore as string[],
  };
  // The optional fields: absent is fine, present-but-malformed is the same
  // contract drift as a malformed required field.
  const { core_status, engine, stats, message } = raw;
  if (core_status !== undefined) {
    if (typeof core_status !== 'string' || !CORE_STATUSES.has(core_status)) {
      throw new EngineFailure('bad_result');
    }
    output.core_status = core_status as CoreStatus;
  }
  if (engine !== undefined) {
    if (typeof engine !== 'string' || !ENGINE_PATTERN.test(engine)) {
      throw new EngineFailure('bad_result');
    }
    output.engine = engine;
  }
  if (stats !== undefined) output.stats = validateStats(stats);
  if (message !== undefined) {
    if (typeof message !== 'string') throw new EngineFailure('bad_result');
    output.message = message.slice(0, MAX_MESSAGE_LENGTH);
  }
  return output;
}

function validateStats(raw: unknown): SolverStats {
  if (!raw || typeof raw !== 'object') throw new EngineFailure('bad_result');
  const { people, slots, pairs, build_s } = raw as Record<string, unknown>;
  for (const count of [people, slots, pairs]) {
    if (!isInt(count) || count < 0) throw new EngineFailure('bad_result');
  }
  if (typeof build_s !== 'number' || !Number.isFinite(build_s) || build_s < 0) {
    throw new EngineFailure('bad_result');
  }
  return {
    people: people as number,
    slots: slots as number,
    pairs: pairs as number,
    build_s,
  };
}

/**
 * Map anything the solve path threw onto the closed reason vocabulary WITHOUT
 * reading it back out. `python.runScript` rejects with an assertion when the
 * script is missing, a spawn error (ENOENT) when there is no interpreter, an
 * AbortError when the kill timer fires, and a plain Error whose message embeds
 * stdout+stderr on a non-zero exit — only the exit code and the script's own
 * `{"type":"error","code":"bad_input"}` marker are extracted from that message.
 *
 * A run CANCEL is not recognisable from the error: tinyexec swallows an
 * AbortError that is not a timeout, the killed process exits with code null,
 * and runScript reports that as an ordinary non-zero exit. The caller checks
 * its own abort signal first and uses `canceled`; see teamSetSolve.ts.
 */
export function classifyEngineError(error: unknown): EngineFailureReason {
  if (error instanceof EngineFailure) return error.reason;
  if (!(error instanceof Error)) return 'unexpected';
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'timeout';
  if (error.name === 'AssertionError' && error.message.startsWith('Script does not exist')) {
    return 'script_missing';
  }
  if (
    (error as NodeJS.ErrnoException).code === 'ENOENT' ||
    (error as NodeJS.ErrnoException).code === 'EACCES'
  ) {
    return 'spawn_failed';
  }
  if (/exited with a non-zero code/.test(error.message)) {
    return /"type"\s*:\s*"error"[^\n]*"code"\s*:\s*"bad_input"/.test(error.message)
      ? 'bad_input'
      : 'nonzero_exit';
  }
  return 'unexpected';
}
