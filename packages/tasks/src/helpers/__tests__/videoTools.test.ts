/**
 * How the video job's processes are started and what their endings mean:
 * never a shell, stdin closed, and non-zero exit (a refusal) told apart from a
 * kill or a failure to start (retried).
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...a: unknown[]) => spawn(...a) }));

const { PROBE_STDOUT_MAX_BYTES, ToolCrashed, probeFile, runFfmpeg } =
  await import('../videoTools.ts');
const { VideoRefusal } = await import('../videoPlan.ts');

type Ending = {
  code?: number | null;
  signal?: string | null;
  stdout?: string | Buffer;
  stderr?: string;
  error?: Error;
  /** Never ends on its own: only a kill (or the abort signal) ends it. */
  hang?: boolean;
};

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

function fakeChild(ending: Ending, options?: { signal?: AbortSignal }) {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => {
    setImmediate(() => child.emit('close', null, 'SIGKILL'));
    return true;
  });
  // What spawn does with its `signal` option: kill, then report an AbortError.
  options?.signal?.addEventListener('abort', () => {
    child.emit(
      'error',
      Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    );
    setImmediate(() => child.emit('close', null, 'SIGKILL'));
  });
  setImmediate(() => {
    if (ending.error) {
      child.emit('error', ending.error);
      return;
    }
    if (ending.stdout) child.stdout.write(ending.stdout);
    child.stderr.write(ending.stderr ?? 'some ffmpeg complaint');
    if (ending.hang) return;
    setImmediate(() => child.emit('close', ending.code ?? null, ending.signal ?? null));
  });
  return child;
}

const spawning = (ending: Ending) =>
  spawn.mockImplementation((_bin: string, _args: string[], options: { signal?: AbortSignal }) =>
    fakeChild(ending, options)
  );

beforeEach(() => {
  spawn.mockReset();
  delete process.env.FFMPEG_PATH;
  delete process.env.FFPROBE_PATH;
});

describe('spawning', () => {
  it('runs ffmpeg from FFMPEG_PATH with an argument array, no shell, stdin ignored', async () => {
    process.env.FFMPEG_PATH = '/usr/bin/ffmpeg';
    spawn.mockImplementation(() => fakeChild({ code: 0 }));
    await runFfmpeg(['-nostdin', '-i', 'in', 'out']);
    const [bin, args, options] = spawn.mock.calls[0];
    expect(bin).toBe('/usr/bin/ffmpeg');
    expect(args).toEqual(['-nostdin', '-i', 'in', 'out']);
    expect(options).toMatchObject({ shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  });

  it('falls back to ffmpeg/ffprobe on PATH (trigger dev)', async () => {
    spawn.mockImplementation(() => fakeChild({ code: 0, stdout: '{"streams":[]}' }));
    await runFfmpeg([]);
    await probeFile('/tmp/x/input');
    expect(spawn.mock.calls.map(c => c[0])).toEqual(['ffmpeg', 'ffprobe']);
  });
});

describe('what an ending means', () => {
  it('non-zero exit from ffmpeg is a refusal (CONVERT_FAILED)', async () => {
    spawn.mockImplementation(() => fakeChild({ code: 1 }));
    await expect(runFfmpeg([])).rejects.toMatchObject({ code: 'CONVERT_FAILED' });
    await expect(runFfmpeg([])).rejects.toBeInstanceOf(VideoRefusal);
  });

  it('non-zero exit or non-JSON from ffprobe is a refusal (UNREADABLE)', async () => {
    spawn.mockImplementation(() => fakeChild({ code: 1 }));
    await expect(probeFile('f')).rejects.toMatchObject({ code: 'UNREADABLE' });
    spawn.mockImplementation(() => fakeChild({ code: 0, stdout: 'not json' }));
    await expect(probeFile('f')).rejects.toMatchObject({ code: 'UNREADABLE' });
  });

  it('a kill is retryable, not a refusal', async () => {
    spawn.mockImplementation(() => fakeChild({ code: null, signal: 'SIGKILL' }));
    const error = await runFfmpeg([]).catch(e => e);
    expect(error).toBeInstanceOf(ToolCrashed);
    expect(error).not.toBeInstanceOf(VideoRefusal);
  });

  it('a binary that will not start is retryable', async () => {
    spawn.mockImplementation(() => fakeChild({ error: new Error('spawn ffmpeg ENOENT') }));
    const error = await runFfmpeg([]).catch(e => e);
    expect(error).toBeInstanceOf(ToolCrashed);
  });

  it('exit 255 (ffmpeg stopped by SIGTERM/SIGINT) is retryable', async () => {
    spawning({ code: 255 });
    const error = await runFfmpeg([]).catch(e => e);
    expect(error).toBeInstanceOf(ToolCrashed);
    expect(error).not.toBeInstanceOf(VideoRefusal);
  });

  it.each(['No space left on device', 'Cannot allocate memory', 'av_malloc: ENOMEM'])(
    'a non-zero exit naming "%s" is the machine, not the file: retryable',
    async stderr => {
      spawning({ code: 1, stderr: `Error writing trailer: ${stderr}` });
      const ffmpeg = await runFfmpeg([]).catch(e => e);
      expect(ffmpeg).toBeInstanceOf(ToolCrashed);
      spawning({ code: 1, stderr });
      expect(await probeFile('f').catch(e => e)).toBeInstanceOf(ToolCrashed);
    }
  );

  it('ffprobe output past the limit is UNREADABLE, not a retryable kill', async () => {
    const child = fakeChild({ hang: true, stdout: Buffer.alloc(PROBE_STDOUT_MAX_BYTES + 1) });
    spawn.mockReturnValue(child);
    await expect(probeFile('f')).rejects.toMatchObject({ code: 'UNREADABLE' });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('parses ffprobe JSON', async () => {
    spawn.mockImplementation(() =>
      fakeChild({ code: 0, stdout: JSON.stringify({ format: { duration: '1.0' } }) })
    );
    await expect(probeFile('f')).resolves.toEqual({ format: { duration: '1.0' } });
  });
});

describe('the deadline', () => {
  it('passes the signal to spawn with SIGKILL, and a kill by it is TIMED_OUT (final)', async () => {
    const deadline = new AbortController();
    spawning({ hang: true });
    const running = runFfmpeg(['-i', 'in', 'out'], deadline.signal).catch(e => e);
    await new Promise(r => setImmediate(r));
    deadline.abort();
    const error = await running;
    expect(error).toBeInstanceOf(VideoRefusal);
    expect(error.code).toBe('TIMED_OUT');
    expect(error.userMessage).toBe('The video took too long to optimise.');
    const [, , options] = spawn.mock.calls[0];
    expect(options).toMatchObject({ signal: deadline.signal, killSignal: 'SIGKILL' });
  });

  it('a deadline already past spawns nothing', async () => {
    const deadline = new AbortController();
    deadline.abort();
    await expect(runFfmpeg([], deadline.signal)).rejects.toMatchObject({ code: 'TIMED_OUT' });
    await expect(probeFile('f', deadline.signal)).rejects.toMatchObject({ code: 'TIMED_OUT' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('without a signal, spawn gets no signal option', async () => {
    spawning({ code: 0 });
    await runFfmpeg([]);
    expect(spawn.mock.calls[0][2]).not.toHaveProperty('signal');
  });
});
