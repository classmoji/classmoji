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

const { ToolCrashed, probeFile, runFfmpeg } = await import('../videoTools.ts');
const { VideoRefusal } = await import('../videoPlan.ts');

type Ending = { code?: number | null; signal?: string | null; stdout?: string; error?: Error };

function fakeChild(ending: Ending) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: () => void;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  setImmediate(() => {
    if (ending.error) {
      child.emit('error', ending.error);
      return;
    }
    if (ending.stdout) child.stdout.write(ending.stdout);
    child.stderr.write('some ffmpeg complaint');
    setImmediate(() => child.emit('close', ending.code ?? null, ending.signal ?? null));
  });
  return child;
}

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

  it('parses ffprobe JSON', async () => {
    spawn.mockImplementation(() =>
      fakeChild({ code: 0, stdout: JSON.stringify({ format: { duration: '1.0' } }) })
    );
    await expect(probeFile('f')).resolves.toEqual({ format: { duration: '1.0' } });
  });
});
