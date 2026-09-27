import { spawn } from 'node:child_process';

import { VideoRefusal, probeArgs, type ProbeJson } from './videoPlan.ts';

/**
 * Running ffmpeg and ffprobe for the video job.
 *
 * `spawn(bin, args)` — an argument ARRAY, never a shell, stdin closed — so no
 * character in any argument is ever interpreted. The binaries come from
 * `FFMPEG_PATH` / `FFPROBE_PATH`, which the `ffmpeg` build extension sets in
 * the deployed image; a local `trigger dev` has neither set and uses the ones
 * on PATH.
 *
 * What a failure MEANS is decided here, because only here is it visible how
 * the process ended. In this order:
 *   - the run's deadline passed (the `signal`)   → `VideoRefusal('TIMED_OUT')`:
 *     the job ran out of time, and another attempt has less of it;
 *   - ffprobe printed more than a probe can be   → `VideoRefusal('UNREADABLE')`;
 *   - it could not be started (ENOENT, EACCES)   → `ToolCrashed`, retried;
 *   - it was killed by a signal (OOM, shutdown)  → `ToolCrashed`, retried;
 *   - exit 255 (ffmpeg's exit on SIGTERM/SIGINT), or stderr naming ENOMEM or
 *     ENOSPC — the machine, not the file       → `ToolCrashed`, retried;
 *   - any other non-zero exit                    → `VideoRefusal`: ffmpeg read
 *     the file and gave up on it, and it will give up the same way next time.
 */

/** How much of stderr is kept for the run log. ffmpeg can be chatty. */
const STDERR_TAIL_BYTES = 4096;

/** ffprobe's JSON for one file is kilobytes; anything past this is not a probe. */
export const PROBE_STDOUT_MAX_BYTES = 8 * 1024 * 1024;

/** The machine ran out of memory or disk: a fresh attempt may not. */
const RESOURCE_EXHAUSTED = /Cannot allocate memory|No space left on device|ENOMEM|ENOSPC/i;

export function ffmpegBin(): string {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

export function ffprobeBin(): string {
  return process.env.FFPROBE_PATH || 'ffprobe';
}

export interface ToolResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderrTail: string;
  /** Killed because the caller's `signal` fired. */
  aborted: boolean;
  /** Killed because stdout passed `PROBE_STDOUT_MAX_BYTES`. */
  overflowed: boolean;
}

/** A process that did not run to a verdict on the file: retryable. */
export class ToolCrashed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolCrashed';
  }
}

export interface RunToolOptions {
  captureStdout?: boolean;
  /** Kills the process (SIGKILL) when it fires; the result says `aborted`. */
  signal?: AbortSignal;
}

/**
 * Spawn without a shell and collect the outcome. Rejects only if it never
 * started; a process killed by `signal` resolves with `aborted: true`, not the
 * `AbortError` spawn raises for it.
 */
export function runTool(
  bin: string,
  args: string[],
  { captureStdout = false, signal }: RunToolOptions = {}
): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve({
        code: null,
        signal: null,
        stdout: '',
        stderrTail: '',
        aborted: true,
        overflowed: false,
      });
      return;
    }
    const child = spawn(bin, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      // SIGKILL, not ffmpeg's graceful SIGTERM exit: whatever it wrote is
      // thrown away, so there is nothing to finish.
      ...(signal ? { signal, killSignal: 'SIGKILL' as const } : {}),
    });
    const out: Buffer[] = [];
    let outBytes = 0;
    let overflowed = false;
    let err = Buffer.alloc(0);

    child.stdout.on('data', (chunk: Buffer) => {
      if (!captureStdout || overflowed) return;
      outBytes += chunk.length;
      if (outBytes > PROBE_STDOUT_MAX_BYTES) {
        overflowed = true;
        child.kill('SIGKILL');
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err = Buffer.concat([err, chunk]);
      if (err.length > STDERR_TAIL_BYTES) err = err.subarray(err.length - STDERR_TAIL_BYTES);
    });
    child.on('error', error => {
      // The kill `signal` asked for: 'close' follows and reports it.
      if (signal?.aborted) return;
      reject(new ToolCrashed(`${bin} did not start: ${error.message}`));
    });
    child.on('close', (code, exitSignal) =>
      resolve({
        code,
        signal: exitSignal,
        stdout: Buffer.concat(out).toString('utf8'),
        stderrTail: err.toString('utf8').trim(),
        aborted: Boolean(signal?.aborted),
        overflowed,
      })
    );
  });
}

/**
 * The endings that say nothing about the file, or null. The deadline is
 * checked first: the kill it causes looks like any other kill.
 */
function machineFailure(bin: string, result: ToolResult): Error | null {
  if (result.aborted) return new VideoRefusal('TIMED_OUT', `${bin} stopped at the deadline`);
  if (result.overflowed) return new VideoRefusal('UNREADABLE', 'probe output too large');
  if (result.signal || result.code === null) {
    return new ToolCrashed(
      `${bin} was stopped by ${result.signal ?? 'an unknown cause'}: ${result.stderrTail}`
    );
  }
  if (result.code === 255 || (result.code !== 0 && RESOURCE_EXHAUSTED.test(result.stderrTail))) {
    return new ToolCrashed(`${bin} exited ${result.code}: ${result.stderrTail.slice(-300)}`);
  }
  return null;
}

/**
 * Probe a local file. A file ffprobe cannot open — a format outside the
 * whitelist, a truncated upload, not a video at all — is `UNREADABLE`.
 */
export async function probeFile(file: string, signal?: AbortSignal): Promise<ProbeJson> {
  const bin = ffprobeBin();
  const result = await runTool(bin, probeArgs(file), { captureStdout: true, signal });
  const machine = machineFailure(bin, result);
  if (machine) throw machine;
  if (result.code !== 0) throw new VideoRefusal('UNREADABLE', result.stderrTail.slice(-300));
  try {
    return JSON.parse(result.stdout) as ProbeJson;
  } catch {
    throw new VideoRefusal('UNREADABLE', 'probe output was not JSON');
  }
}

/** Run ffmpeg with a prepared argument list. Non-zero exit → `CONVERT_FAILED`. */
export async function runFfmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  const bin = ffmpegBin();
  const result = await runTool(bin, args, { signal });
  const machine = machineFailure(bin, result);
  if (machine) throw machine;
  if (result.code !== 0) throw new VideoRefusal('CONVERT_FAILED', result.stderrTail.slice(-300));
}
