/**
 * `media-video-process` against a fake database, bucket and ffmpeg: the
 * eligibility gate, the fenced DONE write and its zero-row cleanup, the
 * keep_original drop order, what is retried vs recorded, and that the tmp dir
 * goes whatever happens. The pure rules are in `videoPlan.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@trigger.dev/sdk', () => {
  class AbortTaskRunError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'AbortTaskRunError';
    }
  }
  return {
    AbortTaskRunError,
    task: (config: object) => config,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});
vi.mock('@classmoji/database', () => ({ default: () => ({}) }));

const { AbortTaskRunError } = await import('@trigger.dev/sdk');
const { mediaVideoProcess, processVideo, runVideoAttempt, VIDEO_MAX_ATTEMPTS } =
  await import('../mediaVideo.ts');
type Deps = import('../mediaVideo.ts').VideoJobDeps;
type Row = import('../mediaVideo.ts').VideoRow;
const { VideoRefusal, GENERIC_FAILURE_MESSAGE } = await import('../../helpers/videoPlan.ts');

const CLASSROOM = '11111111-2222-4333-8444-555555555555';
const MEDIA = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const PREFIX = `m/${CLASSROOM}/${MEDIA}/`;
const ORIG = `${PREFIX}orig.mp4`;
const HASH_WEB = 'aaaaaaaaaaaa'.padEnd(64, '0');
const HASH_POSTER = 'bbbbbbbbbbbb'.padEnd(64, '0');
const WEB = `${PREFIX}web-aaaaaaaaaaaa.mp4`;
const POSTER = `${PREFIX}poster-bbbbbbbbbbbb.jpg`;

const PROBE_IN = {
  streams: [
    {
      index: 0,
      codec_type: 'video',
      codec_name: 'h264',
      profile: 'High',
      pix_fmt: 'yuv420p',
      width: 1280,
      height: 720,
    },
    { index: 1, codec_type: 'audio', codec_name: 'aac' },
  ],
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '60', bit_rate: '2000000' },
};

function baseRow(over: Partial<Row> = {}): Row {
  return {
    id: MEDIA,
    classroom_id: CLASSROOM,
    kind: 'VIDEO',
    ext: 'mp4',
    size_bytes: 15_000_000n,
    status: 'READY',
    optimise: true,
    keep_original: true,
    processing: 'PENDING',
    rendition_key: null,
    poster_key: null,
    ...over,
  };
}

/** A fake world: one row, a bucket, and an event log in call order. */
function world(rowOver: Partial<Row> = {}) {
  const state = {
    row: baseRow(rowOver) as Row | null,
    bucket: new Set<string>([ORIG]),
    events: [] as string[],
    tmpDirs: new Set<string>(),
    removed: [] as string[],
    outputDuration: '60',
  };
  const deps: Deps = {
    findRow: vi.fn(async () => (state.row ? { ...state.row } : null)),
    commitDone: vi.fn(async (_id, fields) => {
      state.events.push('commitDone');
      const r = state.row;
      if (!r || r.status !== 'READY' || r.processing !== 'PENDING') return 0;
      state.row = {
        ...r,
        processing: 'DONE',
        rendition_key: fields.rendition_key,
        poster_key: fields.poster_key,
      };
      return 1;
    }),
    markOriginalDropped: vi.fn(async (_id, renditionKey) => {
      state.events.push('markOriginalDropped');
      const r = state.row;
      return r && r.status === 'READY' && r.rendition_key === renditionKey ? 1 : 0;
    }),
    recordFailure: vi.fn(async (_id, reason) => {
      state.events.push(`recordFailure:${reason}`);
      const r = state.row;
      if (!r || r.status !== 'READY' || r.processing !== 'PENDING') return 0;
      state.row = { ...r, processing: 'FAILED' };
      return 1;
    }),
    download: vi.fn(async key => {
      state.events.push(`download:${key}`);
    }),
    upload: vi.fn(async key => {
      state.events.push(`upload:${key}`);
      state.bucket.add(key);
    }),
    headBytes: vi.fn(async key => (state.bucket.has(key) ? 1000 : null)),
    deleteObject: vi.fn(async key => {
      state.events.push(`delete:${key}`);
      state.bucket.delete(key);
    }),
    probe: vi.fn(async (file: string) =>
      file.endsWith('input')
        ? PROBE_IN
        : { ...PROBE_IN, format: { ...PROBE_IN.format, duration: state.outputDuration } }
    ),
    ffmpeg: vi.fn(async (args: string[]) => {
      state.events.push(`ffmpeg:${args.at(-1)?.split('/').at(-1)}`);
    }),
    sha256: vi.fn(async (file: string) => (file.endsWith('.jpg') ? HASH_POSTER : HASH_WEB)),
    fileSize: vi.fn(async () => 1000),
    makeTmpDir: vi.fn(async () => {
      const dir = `/tmp/media-video-${state.tmpDirs.size}`;
      state.tmpDirs.add(dir);
      return dir;
    }),
    removeTmpDir: vi.fn(async dir => {
      state.removed.push(dir);
    }),
  };
  return { state, deps };
}

const PAYLOAD = { classroomId: CLASSROOM, mediaId: MEDIA };

beforeEach(() => vi.clearAllMocks());

describe('task settings', () => {
  it('runs on large-2x for up to 4 h, two at a time, three attempts', () => {
    const t = mediaVideoProcess as unknown as Record<string, unknown>;
    expect(t.id).toBe('media-video-process');
    expect(t.machine).toEqual({ preset: 'large-2x' });
    expect(t.maxDuration).toBe(4 * 60 * 60);
    expect(t.queue).toMatchObject({ concurrencyLimit: 2 });
    expect(t.retry).toMatchObject({ maxAttempts: 3 });
    expect(VIDEO_MAX_ATTEMPTS).toBe(3);
  });
});

describe('eligibility', () => {
  it.each([
    [{ status: 'DELETED' }, 'not-ready'],
    [{ kind: 'AUDIO' }, 'not-video'],
    [{ optimise: false }, 'not-optimised'],
    [{ processing: 'DONE' }, 'not-pending'],
    [{ processing: 'NONE' }, 'not-pending'],
    [{ classroom_id: '99999999-2222-4333-8444-555555555555' }, 'wrong-classroom'],
  ])('skips a row with %o quietly', async (over, reason) => {
    const { state, deps } = world(over as Partial<Row>);
    expect(await processVideo(PAYLOAD, deps)).toEqual({ status: 'skipped', reason });
    expect(deps.makeTmpDir).not.toHaveBeenCalled();
    expect(state.events).toEqual([]);
  });

  it('skips a missing row', async () => {
    const { state, deps } = world();
    state.row = null;
    expect(await processVideo(PAYLOAD, deps)).toEqual({ status: 'skipped', reason: 'missing' });
  });
});

describe('the happy path', () => {
  it('remuxes, uploads content-derived names, writes DONE, keeps the original', async () => {
    const { state, deps } = world();
    const result = await processVideo(PAYLOAD, deps);
    expect(result).toEqual({ status: 'done', mode: 'remux', renditionKey: WEB, posterKey: POSTER });
    expect(state.events).toEqual([
      `download:${ORIG}`,
      'ffmpeg:web.mp4',
      'ffmpeg:poster.jpg',
      `upload:${WEB}`,
      `upload:${POSTER}`,
      'commitDone',
    ]);
    expect(deps.commitDone).toHaveBeenCalledWith(MEDIA, {
      rendition_key: WEB,
      rendition_bytes: 1000n,
      poster_key: POSTER,
      duration_ms: 60_000,
      width: 1280,
      height: 720,
    });
    expect(state.bucket.has(ORIG)).toBe(true);
    expect(state.removed).toEqual(['/tmp/media-video-0']);
  });

  it('stream-uploads from the tmp files with the right types', async () => {
    const { deps } = world();
    await processVideo(PAYLOAD, deps);
    expect(deps.upload).toHaveBeenCalledWith(WEB, '/tmp/media-video-0/web.mp4', 1000, 'video/mp4');
    expect(deps.upload).toHaveBeenCalledWith(
      POSTER,
      '/tmp/media-video-0/poster.jpg',
      1000,
      'image/jpeg'
    );
  });

  it('a poster ffmpeg cannot make leaves poster_key null, not a failed job', async () => {
    const { state, deps } = world();
    (deps.ffmpeg as ReturnType<typeof vi.fn>).mockImplementation(async (args: string[]) => {
      if (args.at(-1)?.endsWith('.jpg')) throw new VideoRefusal('CONVERT_FAILED', 'mjpeg');
    });
    const result = await processVideo(PAYLOAD, deps);
    expect(result).toMatchObject({ status: 'done', posterKey: null });
    expect(state.row?.poster_key).toBeNull();
  });
});

describe('fencing', () => {
  it('zero rows at the DONE write → delete what this run uploaded, then exit', async () => {
    const { state, deps } = world();
    (deps.commitDone as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      state.events.push('commitDone');
      state.row = { ...(state.row as Row), status: 'DELETED' }; // deleted mid-run
      return 0;
    });
    expect(await processVideo(PAYLOAD, deps)).toEqual({ status: 'skipped', reason: 'fenced' });
    expect(state.events.slice(-3)).toEqual(['commitDone', `delete:${WEB}`, `delete:${POSTER}`]);
    expect(state.bucket.has(ORIG)).toBe(true);
    expect(state.removed).toHaveLength(1);
  });

  it('keeps an upload the row now names (a replay that produced the same bytes)', async () => {
    const { state, deps } = world();
    (deps.commitDone as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      state.row = {
        ...(state.row as Row),
        processing: 'DONE',
        rendition_key: WEB,
        poster_key: null,
      };
      return 0;
    });
    await processVideo(PAYLOAD, deps);
    expect(deps.deleteObject).toHaveBeenCalledTimes(1);
    expect(deps.deleteObject).toHaveBeenCalledWith(POSTER);
    expect(state.bucket.has(WEB)).toBe(true);
  });

  it('compares by variant, so a bare-variant rendition_key is also kept', async () => {
    const { state, deps } = world();
    (deps.commitDone as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      state.row = { ...(state.row as Row), rendition_key: 'web-aaaaaaaaaaaa.mp4' };
      return 0;
    });
    await processVideo(PAYLOAD, deps);
    expect(deps.deleteObject).not.toHaveBeenCalledWith(WEB);
  });
});

describe('keep_original off', () => {
  it('drops the original only AFTER the DONE write, marking before deleting', async () => {
    const { state, deps } = world({ keep_original: false });
    await processVideo(PAYLOAD, deps);
    expect(state.events.slice(-3)).toEqual(['commitDone', 'markOriginalDropped', `delete:${ORIG}`]);
    expect(deps.markOriginalDropped).toHaveBeenCalledWith(MEDIA, WEB);
    expect(state.bucket.has(ORIG)).toBe(false);
  });

  it('does not delete the original when the mark matched nothing', async () => {
    const { state, deps } = world({ keep_original: false });
    (deps.markOriginalDropped as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    await processVideo(PAYLOAD, deps);
    expect(state.bucket.has(ORIG)).toBe(true);
  });

  it('a failed drop is logged, not thrown: the rendition is live and stays', async () => {
    const { state, deps } = world({ keep_original: false });
    (deps.deleteObject as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('R2 500'));
    await expect(processVideo(PAYLOAD, deps)).resolves.toMatchObject({ status: 'done' });
    expect(state.bucket.has(WEB)).toBe(true);
  });

  it('never touches the original when the job fails', async () => {
    const { state, deps } = world({ keep_original: false });
    state.outputDuration = '20'; // truncated
    await expect(runVideoAttempt(PAYLOAD, 1, deps)).rejects.toBeInstanceOf(AbortTaskRunError);
    expect(state.bucket.has(ORIG)).toBe(true);
    expect(deps.markOriginalDropped).not.toHaveBeenCalled();
    expect(deps.deleteObject).not.toHaveBeenCalledWith(ORIG);
  });
});

describe('failure: refused, retried, recorded', () => {
  it('a truncated output is a refusal: recorded at once, run aborted, outputs never uploaded', async () => {
    const { state, deps } = world();
    state.outputDuration = '20';
    const error = await runVideoAttempt(PAYLOAD, 1, deps).catch(e => e);
    expect(error).toBeInstanceOf(AbortTaskRunError);
    expect(deps.recordFailure).toHaveBeenCalledWith(MEDIA, 'The optimised copy was incomplete.');
    expect(deps.upload).not.toHaveBeenCalled();
    expect(state.row?.processing).toBe('FAILED');
  });

  it('no video track and over 6 h are refusals with their own sentences', async () => {
    const audioOnly = world();
    (audioOnly.deps.probe as ReturnType<typeof vi.fn>).mockResolvedValue({
      streams: [PROBE_IN.streams[1]],
      format: PROBE_IN.format,
    });
    await expect(runVideoAttempt(PAYLOAD, 1, audioOnly.deps)).rejects.toBeInstanceOf(
      AbortTaskRunError
    );
    expect(audioOnly.deps.recordFailure).toHaveBeenCalledWith(
      MEDIA,
      'The file has no video track.'
    );

    const long = world();
    (long.deps.probe as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...PROBE_IN,
      format: { ...PROBE_IN.format, duration: String(7 * 3600) },
    });
    await expect(runVideoAttempt(PAYLOAD, 1, long.deps)).rejects.toBeInstanceOf(AbortTaskRunError);
    expect(long.deps.recordFailure).toHaveBeenCalledWith(
      MEDIA,
      'The video is longer than 6 hours.'
    );
    expect(long.deps.ffmpeg).not.toHaveBeenCalled();
  });

  it('a transient error before the last attempt is rethrown for a retry, not recorded', async () => {
    const { state, deps } = world();
    const blip = new Error('R2 503');
    (deps.headBytes as ReturnType<typeof vi.fn>).mockRejectedValueOnce(blip);
    const error = await runVideoAttempt(PAYLOAD, 1, deps).catch(e => e);
    expect(error).toBe(blip);
    expect(error).not.toBeInstanceOf(AbortTaskRunError);
    expect(deps.recordFailure).not.toHaveBeenCalled();
    expect(state.row?.processing).toBe('PENDING');
    // The rendition this attempt uploaded is gone; the next attempt re-makes it.
    expect(state.bucket.has(WEB)).toBe(false);
  });

  it('the same transient error on the last attempt is recorded with the generic sentence', async () => {
    const { state, deps } = world();
    (deps.download as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('socket hang up'));
    await expect(runVideoAttempt(PAYLOAD, VIDEO_MAX_ATTEMPTS, deps)).rejects.toThrow(
      'socket hang up'
    );
    expect(deps.recordFailure).toHaveBeenCalledWith(MEDIA, GENERIC_FAILURE_MESSAGE);
    expect(state.row?.processing).toBe('FAILED');
  });

  it('a stored-size mismatch after upload is retried and cleans up', async () => {
    const { state, deps } = world();
    (deps.headBytes as ReturnType<typeof vi.fn>).mockResolvedValueOnce(999);
    await expect(runVideoAttempt(PAYLOAD, 1, deps)).rejects.toThrow(/stored as 999/);
    expect(state.bucket.has(WEB)).toBe(false);
    expect(deps.recordFailure).not.toHaveBeenCalled();
  });

  it('onFailure records only a row still PENDING', async () => {
    const { state, deps } = world({ processing: 'FAILED' });
    expect(await deps.recordFailure(MEDIA, GENERIC_FAILURE_MESSAGE)).toBe(0);
    expect(state.row?.processing).toBe('FAILED');
  });
});

describe('tmp cleanup', () => {
  it('removes the tmp dir after success, a refusal and a transient error', async () => {
    const ok = world();
    await processVideo(PAYLOAD, ok.deps);
    expect(ok.state.removed).toEqual(['/tmp/media-video-0']);

    const refused = world();
    refused.state.outputDuration = '1';
    await processVideo(PAYLOAD, refused.deps).catch(() => {});
    expect(refused.state.removed).toEqual(['/tmp/media-video-0']);

    const blip = world();
    (blip.deps.ffmpeg as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('killed'));
    await processVideo(PAYLOAD, blip.deps).catch(() => {});
    expect(blip.state.removed).toEqual(['/tmp/media-video-0']);
  });

  it('the live tmp dir is created under the OS tmpdir and removed with its contents', async () => {
    const { liveDeps } = await import('../mediaVideo.ts');
    const { existsSync } = await import('node:fs');
    const { writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const live = liveDeps();
    const dir = await live.makeTmpDir();
    expect(dir.startsWith(tmpdir())).toBe(true);
    await writeFile(`${dir}/web.mp4`, 'x');
    await live.removeTmpDir(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('a failing tmp removal does not mask the result', async () => {
    const { deps } = world();
    (deps.removeTmpDir as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('EBUSY'));
    await expect(processVideo(PAYLOAD, deps)).resolves.toMatchObject({ status: 'done' });
  });
});
