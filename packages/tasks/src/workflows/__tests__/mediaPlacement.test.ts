/**
 * The agent-upload tasks decide one thing the services cannot: whether a
 * failure is worth a retry or is recorded on the row now. These pin that
 * decision, the hand-off from import to placement, and the explicit run
 * settings (a task that inherited the config's defaults would stream a 2 GiB
 * import under a 900 s default with no per-classroom queue).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const placeStagedObject = vi.fn();
const failStagedPlacement = vi.fn();
const stagedImportContext = vi.fn();
const streamIntoStage = vi.fn();
const settleStagedImport = vi.fn();
const isPermanentPlacementError = vi.fn();
const fetchImportUrl = vi.fn();
const placeTrigger = vi.fn();

vi.mock('@trigger.dev/sdk', () => ({
  task: (config: { id: string }) => ({
    ...config,
    trigger: config.id === 'media-place-staged' ? placeTrigger : vi.fn(),
  }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    media: {
      stagingTaskSteps: async () => ({
        placeStagedObject,
        failStagedPlacement,
        stagedImportContext,
        streamIntoStage,
        settleStagedImport,
        isPermanentPlacementError,
      }),
    },
  },
}));

vi.mock('../../helpers/safeUrlFetch.ts', async () => {
  class UrlImportError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status?: number
    ) {
      super(message);
      this.name = 'UrlImportError';
    }
  }
  return { UrlImportError, fetchImportUrl: (...a: unknown[]) => fetchImportUrl(...a) };
});

const { mediaPlaceStaged, mediaImportUrl } = await import('../mediaPlacement.ts');
const { UrlImportError } = await import('../../helpers/safeUrlFetch.ts');

type Runnable<P> = {
  run: (payload: P, params: { ctx: { attempt: { number: number } } }) => unknown;
};
const run = <P>(t: unknown, payload: P, attempt = 1) =>
  (t as Runnable<P>).run(payload, { ctx: { attempt: { number: attempt } } });

const MEDIA_ID = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const CLASSROOM_ID = '11111111-2222-4333-8444-555555555555';

beforeEach(() => {
  for (const fn of [
    placeStagedObject,
    failStagedPlacement,
    stagedImportContext,
    streamIntoStage,
    settleStagedImport,
    isPermanentPlacementError,
    fetchImportUrl,
    placeTrigger,
  ]) {
    fn.mockReset();
  }
  isPermanentPlacementError.mockReturnValue(false);
});

describe('run settings', () => {
  it('sets duration, machine, and a per-classroom queue explicitly', () => {
    for (const t of [mediaPlaceStaged, mediaImportUrl] as unknown as {
      maxDuration: number;
      machine: string;
      queue: { concurrencyLimit: number };
    }[]) {
      expect(t.maxDuration).toBeGreaterThan(0);
      expect(t.machine).toBe('small-2x');
      expect(t.queue.concurrencyLimit).toBeGreaterThan(0);
    }
  });
});

describe('media-place-staged', () => {
  it('returns what the service placed', async () => {
    placeStagedObject.mockResolvedValue({ status: 'placed', ref: 'pages/a/assets/x.png' });
    await expect(run(mediaPlaceStaged, { mediaId: MEDIA_ID })).resolves.toEqual({
      status: 'placed',
      ref: 'pages/a/assets/x.png',
    });
    expect(failStagedPlacement).not.toHaveBeenCalled();
  });

  it('rethrows a transient failure for the retry policy', async () => {
    placeStagedObject.mockRejectedValue(new Error('GitHub 502'));
    await expect(run(mediaPlaceStaged, { mediaId: MEDIA_ID }, 1)).rejects.toThrow('GitHub 502');
    expect(failStagedPlacement).not.toHaveBeenCalled();
  });

  it('records a permanent refusal at once, with its sentence', async () => {
    const refusal = Object.assign(new Error('.exe files cannot be uploaded here.'), {
      code: 'FILE_REFUSED',
    });
    placeStagedObject.mockRejectedValue(refusal);
    isPermanentPlacementError.mockReturnValue(true);
    await expect(run(mediaPlaceStaged, { mediaId: MEDIA_ID })).resolves.toEqual({
      status: 'failed',
      reason: '.exe files cannot be uploaded here.',
    });
    expect(failStagedPlacement).toHaveBeenCalledWith(
      MEDIA_ID,
      '.exe files cannot be uploaded here.'
    );
  });

  it('records a transient failure on the last attempt, without leaking its detail', async () => {
    placeStagedObject.mockRejectedValue(new Error('socket hang up at 10.0.0.3'));
    await expect(run(mediaPlaceStaged, { mediaId: MEDIA_ID }, 3)).resolves.toMatchObject({
      status: 'failed',
    });
    expect(failStagedPlacement.mock.calls[0][1]).not.toContain('10.0.0.3');
  });
});

describe('media-import-url', () => {
  const row = { id: MEDIA_ID, classroom_id: CLASSROOM_ID };

  it('is a no-op for a row that is no longer staging', async () => {
    stagedImportContext.mockResolvedValue(null);
    await expect(
      run(mediaImportUrl, { mediaId: MEDIA_ID, url: 'https://example.com/a.mp4' })
    ).resolves.toEqual({ status: 'skipped', reason: 'not-staging' });
    expect(fetchImportUrl).not.toHaveBeenCalled();
  });

  it('fetches under the class cap, streams, settles, then hands off to placement', async () => {
    stagedImportContext.mockResolvedValue({ row, maxBytes: 1234 });
    const body = (async function* () {})();
    fetchImportUrl.mockResolvedValue({ body, cancel: vi.fn() });
    streamIntoStage.mockResolvedValue(1000);

    await expect(
      run(mediaImportUrl, { mediaId: MEDIA_ID, url: 'https://example.com/a.mp4' })
    ).resolves.toEqual({ status: 'queued' });

    expect(fetchImportUrl.mock.calls[0][0]).toBe('https://example.com/a.mp4');
    expect(fetchImportUrl.mock.calls[0][1]).toMatchObject({ maxBytes: 1234 });
    expect(streamIntoStage).toHaveBeenCalledWith(row, body, 1234);
    expect(settleStagedImport).toHaveBeenCalledWith(MEDIA_ID, 1000);
    expect(placeTrigger).toHaveBeenCalledWith(
      { mediaId: MEDIA_ID },
      { idempotencyKey: `media-place:${MEDIA_ID}`, concurrencyKey: CLASSROOM_ID }
    );
  });

  it('records a refused URL (redirect, private address, too large) at once', async () => {
    stagedImportContext.mockResolvedValue({ row, maxBytes: 10 });
    for (const [code, status] of [
      ['REDIRECT_REFUSED', 302],
      ['BLOCKED_ADDRESS', undefined],
      ['TOO_LARGE', undefined],
      ['HTTP_ERROR', 404],
    ] as const) {
      failStagedPlacement.mockReset();
      fetchImportUrl.mockRejectedValue(
        new UrlImportError(code as never, `refused: ${code}`, status)
      );
      await expect(
        run(mediaImportUrl, { mediaId: MEDIA_ID, url: 'https://example.com/a.mp4' })
      ).resolves.toEqual({ status: 'failed', reason: `refused: ${code}` });
      expect(failStagedPlacement).toHaveBeenCalledWith(MEDIA_ID, `refused: ${code}`);
    }
    expect(placeTrigger).not.toHaveBeenCalled();
  });

  it('retries a timeout or a 5xx once, then records it', async () => {
    stagedImportContext.mockResolvedValue({ row, maxBytes: 10 });
    fetchImportUrl.mockRejectedValue(new UrlImportError('TIMEOUT' as never, 'timed out'));
    await expect(
      run(mediaImportUrl, { mediaId: MEDIA_ID, url: 'https://example.com/a.mp4' }, 1)
    ).rejects.toThrow('timed out');
    expect(failStagedPlacement).not.toHaveBeenCalled();

    fetchImportUrl.mockRejectedValue(
      new UrlImportError('HTTP_ERROR' as never, 'answered 503', 503)
    );
    await expect(
      run(mediaImportUrl, { mediaId: MEDIA_ID, url: 'https://example.com/a.mp4' }, 2)
    ).resolves.toEqual({ status: 'failed', reason: 'answered 503' });
  });

  it('cancels the fetch when streaming into R2 fails', async () => {
    stagedImportContext.mockResolvedValue({ row, maxBytes: 10 });
    const cancel = vi.fn().mockResolvedValue(undefined);
    fetchImportUrl.mockResolvedValue({ body: (async function* () {})(), cancel });
    streamIntoStage.mockRejectedValue(new Error('r2 blip'));
    await expect(
      run(mediaImportUrl, { mediaId: MEDIA_ID, url: 'https://example.com/a.mp4' }, 1)
    ).rejects.toThrow('r2 blip');
    expect(cancel).toHaveBeenCalled();
  });
});

type Hooked<P> = { onFailure: (params: { payload: P; error: unknown }) => Promise<void> };

describe('review fixes: retry decisions and the final-failure backstop', () => {
  const row = { id: MEDIA_ID, classroom_id: CLASSROOM_ID };

  it('treats a far-end 408 or 429 as retryable, like a 5xx', async () => {
    for (const status of [408, 429]) {
      failStagedPlacement.mockReset();
      stagedImportContext.mockResolvedValue({ row, maxBytes: 10 });
      fetchImportUrl.mockRejectedValue(
        new UrlImportError('HTTP_ERROR', `The server answered HTTP ${status}.`, status)
      );
      await expect(
        run(mediaImportUrl, { mediaId: MEDIA_ID, url: 'https://x.test/a.mp4' }, 1)
      ).rejects.toThrow(String(status));
      expect(failStagedPlacement).not.toHaveBeenCalled();
    }
  });

  it('still records a 404 at once', async () => {
    stagedImportContext.mockResolvedValue({ row, maxBytes: 10 });
    fetchImportUrl.mockRejectedValue(
      new UrlImportError('HTTP_ERROR', 'The server answered HTTP 404.', 404)
    );
    await expect(
      run(mediaImportUrl, { mediaId: MEDIA_ID, url: 'https://x.test/a.mp4' }, 1)
    ).resolves.toEqual({ status: 'failed', reason: 'The server answered HTTP 404.' });
  });

  it('a hand-off that cannot be queued is retried, then recorded on the last attempt', async () => {
    stagedImportContext.mockResolvedValue({ row, maxBytes: 10 });
    fetchImportUrl.mockResolvedValue({ body: [], cancel: vi.fn(async () => {}) });
    streamIntoStage.mockResolvedValue(5);
    settleStagedImport.mockResolvedValue({});
    placeTrigger.mockRejectedValue(new Error('trigger API 503'));

    await expect(
      run(mediaImportUrl, { mediaId: MEDIA_ID, url: 'https://x.test/a.mp4' }, 1)
    ).rejects.toThrow('trigger API 503');
    expect(failStagedPlacement).not.toHaveBeenCalled();

    await expect(
      run(mediaImportUrl, { mediaId: MEDIA_ID, url: 'https://x.test/a.mp4' }, 2)
    ).resolves.toMatchObject({ status: 'failed' });
    expect(failStagedPlacement).toHaveBeenCalledTimes(1);
  });

  it('reports an expired import as skipped: expired', async () => {
    stagedImportContext.mockResolvedValue({ expired: true });
    await expect(
      run(mediaImportUrl, { mediaId: MEDIA_ID, url: 'https://x.test/a.mp4' })
    ).resolves.toEqual({ status: 'skipped', reason: 'expired' });
    expect(fetchImportUrl).not.toHaveBeenCalled();
  });

  it('both tasks record the row on final failure (onFailure), with a safe sentence', async () => {
    for (const t of [mediaPlaceStaged, mediaImportUrl]) {
      failStagedPlacement.mockReset();
      await (t as unknown as Hooked<{ mediaId: string }>).onFailure({
        payload: { mediaId: MEDIA_ID },
        error: new Error('connect ECONNREFUSED 10.1.2.3:5432'),
      });
      expect(failStagedPlacement).toHaveBeenCalledTimes(1);
      expect(failStagedPlacement.mock.calls[0][0]).toBe(MEDIA_ID);
      expect(failStagedPlacement.mock.calls[0][1]).not.toContain('10.1.2.3');
    }
  });

  it('onFailure never throws, even when recording fails', async () => {
    failStagedPlacement.mockRejectedValue(new Error('db down'));
    await expect(
      (mediaPlaceStaged as unknown as Hooked<{ mediaId: string }>).onFailure({
        payload: { mediaId: MEDIA_ID },
        error: new Error('x'),
      })
    ).resolves.toBeUndefined();
  });
});
