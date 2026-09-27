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
 * the process ended:
 *   - it could not be started (ENOENT, EACCES)   → plain Error, retried;
 *   - it was killed by a signal (OOM, shutdown)  → plain Error, retried;
 *   - it ran and exited non-zero                 → `VideoRefusal`: ffmpeg read
 *     the file and gave up on it, and it will give up the same way next time.
 */

/** How much of stderr is kept for the run log. ffmpeg can be chatty. */
const STDERR_TAIL_BYTES = 4096;

/** ffprobe's JSON for one file is kilobytes; anything past this is not a probe. */
const PROBE_STDOUT_MAX_BYTES = 8 * 1024 * 1024;

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
}

/** A process that did not run to an exit code: retryable. */
export class ToolCrashed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolCrashed';
  }
}

/** Spawn without a shell and collect the outcome. Rejects only if it never started. */
export function runTool(
  bin: string,
  args: string[],
  { captureStdout = false }: { captureStdout?: boolean } = {}
): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = Buffer.alloc(0);

    child.stdout.on('data', (chunk: Buffer) => {
      if (!captureStdout) return;
      outBytes += chunk.length;
      if (outBytes > PROBE_STDOUT_MAX_BYTES) {
        child.kill('SIGKILL');
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err = Buffer.concat([err, chunk]);
      if (err.length > STDERR_TAIL_BYTES) err = err.subarray(err.length - STDERR_TAIL_BYTES);
    });
    child.on('error', error => reject(new ToolCrashed(`${bin} did not start: ${error.message}`)));
    child.on('close', (code, signal) =>
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out).toString('utf8'),
        stderrTail: err.toString('utf8').trim(),
      })
    );
  });
}

function crashed(bin: string, result: ToolResult): ToolCrashed {
  return new ToolCrashed(
    `${bin} was stopped by ${result.signal ?? 'an unknown cause'}: ${result.stderrTail}`
  );
}

/**
 * Probe a local file. A file ffprobe cannot open — a format outside the
 * whitelist, a truncated upload, not a video at all — is `UNREADABLE`.
 */
export async function probeFile(file: string): Promise<ProbeJson> {
  const bin = ffprobeBin();
  const result = await runTool(bin, probeArgs(file), { captureStdout: true });
  if (result.signal || result.code === null) throw crashed(bin, result);
  if (result.code !== 0) throw new VideoRefusal('UNREADABLE', result.stderrTail.slice(-300));
  try {
    return JSON.parse(result.stdout) as ProbeJson;
  } catch {
    throw new VideoRefusal('UNREADABLE', 'probe output was not JSON');
  }
}

/** Run ffmpeg with a prepared argument list. Non-zero exit → `CONVERT_FAILED`. */
export async function runFfmpeg(args: string[]): Promise<void> {
  const bin = ffmpegBin();
  const result = await runTool(bin, args);
  if (result.signal || result.code === null) throw crashed(bin, result);
  if (result.code !== 0) throw new VideoRefusal('CONVERT_FAILED', result.stderrTail.slice(-300));
}
