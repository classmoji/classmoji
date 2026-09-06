/**
 * Unit tests for the deck-thumbnail render task.
 *
 * Four things matter here, and none of them is the plumbing:
 *
 *  - it does NOT render when the deck's `index.html` is the same document the
 *    stored thumbnail was taken of. That check is what makes a backfill, a
 *    Trigger retry and a save that only touched slide 40 all free — and it is
 *    what bounds git growth, because a WebP does not delta-compress and every
 *    render that lands is a whole new object in the repo's history;
 *  - a 429 rethrows so the task's own retry policy handles it, while a render
 *    that simply will not work returns quietly — either way NOTHING is
 *    committed and the deck keeps the thumbnail it already had;
 *  - the LOOP GUARD: this task must never reach a deck WRITE path, because the
 *    enqueue for it lives inside those. Asserted structurally, since the only
 *    way that regresses is somebody reaching for a convenient helper;
 *  - the render token never reaches a log line.
 *
 * `@trigger.dev/sdk`, `@classmoji/database`, `@classmoji/services` and the
 * Browser Run helper are mocked, so `run` is invoked directly and nothing
 * reaches Cloudflare, GitHub or Postgres.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findUnique = vi.fn();
const update = vi.fn();
const lookupContentAsset = vi.fn();
const recordContentAsset = vi.fn();
const signDeckRenderToken = vi.fn();
const uploadBatch = vi.fn();
const getMeta = vi.fn();
const screenshotToBase64 = vi.fn();
const isBrowserRunConfigured = vi.fn();
const warmContentBlob = vi.fn();

const loggerInfo = vi.fn();
const loggerWarn = vi.fn();
const loggerError = vi.fn();
const waitFor = vi.fn();

// `task()` normally returns a trigger handle; return the config so the test can
// call `run` directly.
vi.mock('@trigger.dev/sdk', () => ({
  task: (config: unknown) => config,
  logger: { info: loggerInfo, warn: loggerWarn, error: loggerError },
  wait: { for: waitFor },
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({ slide: { findUnique, update } }),
}));

/**
 * The thumbnail contract is mirrored rather than stubbed: these constants are
 * the agreement between this task and the render route, and a test that invents
 * its own values would pass while the two halves disagreed.
 */
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    contentAssets: { lookupContentAsset, recordContentAsset },
    contentDelivery: { warmContentBlob },
    deckRenderToken: { signDeckRenderToken },
    deckThumbnail: {
      THUMBNAIL_WIDTH: 1280,
      THUMBNAIL_HEIGHT: 720,
      THUMBNAIL_WEBP_QUALITY: 80,
      THUMBNAIL_READY_SELECTOR: '[data-thumbnail-ready]',
      RENDER_TOKEN_HEADER: 'X-Render-Token',
      thumbnailPathFor: (contentPath: string) => `${contentPath}/thumbnail.webp`,
      thumbnailSourceUrl: (origin: string, slideId: string) =>
        `${origin}/${slideId}/thumbnail-source`,
    },
  },
  ContentService: { uploadBatch, getMeta },
}));

// The error class is REAL — the task branches on `instanceof` and on
// `retryable`, and a stubbed class would make that branch untestable.
vi.mock('../../helpers/browserRun.ts', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, screenshotToBase64, isBrowserRunConfigured };
});

const { BrowserRunError } = await import('../../helpers/browserRun.ts');
const { deckThumbnailRender } = await import('../deckThumbnail.ts');

type Result = { status: string; reason?: string; sha?: string; path?: string; bytes?: number };

const run = (payload: { slideId?: string; force?: boolean } = {}): Promise<Result> =>
  (deckThumbnailRender as unknown as { run: (p: unknown, c?: unknown) => Promise<Result> }).run(
    { slideId: SLIDE_ID, ...payload },
    {}
  );

const SLIDE_ID = '22222222-3333-4444-8555-666666666666';
const CLASSROOM_ID = '11111111-2222-4333-8444-555555555555';
const INDEX_SHA = 'a'.repeat(40);
const THUMB_SHA = 'b'.repeat(40);

/** A one-pixel WebP is not needed — the task only ever moves the base64 around. */
const IMAGE_BASE64 = Buffer.from('not really a webp, but bytes are bytes').toString('base64');

function slideRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SLIDE_ID,
    classroom_id: CLASSROOM_ID,
    slug: 'week-01-intro',
    title: 'Week 01 — Intro',
    content_path: 'slides/week-01-intro',
    is_public: false,
    thumbnail_path: null,
    thumbnail_rendered_sha: null,
    classroom: {
      id: CLASSROOM_ID,
      content_repo: 'content-cs52-25w',
      content_key_version: 0,
      content_delivery_enabled: true,
      git_organization: { login: 'cs52', provider: 'GITHUB' },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SLIDES_URL = 'https://slides.classmoji.test';
  isBrowserRunConfigured.mockReturnValue(true);
  findUnique.mockResolvedValue(slideRow());
  lookupContentAsset.mockResolvedValue({ sha: INDEX_SHA, type: 'blob', size: 1234 });
  signDeckRenderToken.mockResolvedValue('1767225720.c2lnbmF0dXJl');
  screenshotToBase64.mockResolvedValue(IMAGE_BASE64);
  uploadBatch.mockResolvedValue({
    commit: 'c'.repeat(40),
    filesUploaded: 1,
    files: [{ path: 'slides/week-01-intro/thumbnail.webp', sha: THUMB_SHA }],
  });
  recordContentAsset.mockResolvedValue(true);
  warmContentBlob.mockResolvedValue(undefined);
  update.mockResolvedValue({});
});

describe('skip when the deck has not changed', () => {
  it('returns unchanged without booting a browser or writing a commit', async () => {
    findUnique.mockResolvedValue(
      slideRow({
        thumbnail_path: 'slides/week-01-intro/thumbnail.webp',
        thumbnail_rendered_sha: INDEX_SHA,
      })
    );

    await expect(run()).resolves.toEqual({ status: 'unchanged', sha: INDEX_SHA });
    expect(screenshotToBase64).not.toHaveBeenCalled();
    expect(uploadBatch).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(signDeckRenderToken).not.toHaveBeenCalled();
  });

  it('still renders when the sha matches but no thumbnail was ever stored', async () => {
    // The sha alone is not enough: a row can carry a sha from a run whose
    // commit never landed, and answering "unchanged" there would leave the deck
    // permanently without a picture.
    findUnique.mockResolvedValue(
      slideRow({ thumbnail_path: null, thumbnail_rendered_sha: INDEX_SHA })
    );

    await expect(run()).resolves.toMatchObject({ status: 'rendered' });
    expect(screenshotToBase64).toHaveBeenCalledTimes(1);
  });

  it('falls back to a metadata read when the asset map has no row', async () => {
    lookupContentAsset.mockResolvedValue(null);
    getMeta.mockResolvedValue({ sha: INDEX_SHA });
    findUnique.mockResolvedValue(
      slideRow({
        thumbnail_path: 'slides/week-01-intro/thumbnail.webp',
        thumbnail_rendered_sha: INDEX_SHA,
      })
    );

    await expect(run()).resolves.toEqual({ status: 'unchanged', sha: INDEX_SHA });
    expect(getMeta).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'slides/week-01-intro/index.html', skipCache: true })
    );
    expect(screenshotToBase64).not.toHaveBeenCalled();
  });
});

describe('rendering and committing', () => {
  it('commits the image as base64 beside the deck and records the asset row', async () => {
    await expect(run()).resolves.toMatchObject({
      status: 'rendered',
      path: 'slides/week-01-intro/thumbnail.webp',
      sha: THUMB_SHA,
    });

    expect(uploadBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: 'content-cs52-25w',
        message: 'chore(thumbnail): week-01-intro',
        // `put`/`putFile` are UTF-8 only; base64 through uploadBatch is the one
        // commit path that can carry a WebP intact.
        files: [
          {
            path: 'slides/week-01-intro/thumbnail.webp',
            content: IMAGE_BASE64,
            encoding: 'base64',
          },
        ],
        primeCache: false,
      })
    );

    expect(recordContentAsset).toHaveBeenCalledWith(CLASSROOM_ID, {
      path: 'slides/week-01-intro/thumbnail.webp',
      sha: THUMB_SHA,
      size: Buffer.from(IMAGE_BASE64, 'base64').length,
    });
  });

  it("warms the committed image at the deck's own visibility tier", async () => {
    await run();

    // `isPublic` is the deck's, because that is exactly what the index feeds
    // `tierFor` when it signs the URL a browser will ask for. A warm at any
    // other tier fills an entry nobody requests and reports nothing.
    expect(warmContentBlob).toHaveBeenCalledWith(
      {
        classroom: {
          id: CLASSROOM_ID,
          content_key_version: 0,
          content_delivery_enabled: true,
        },
      },
      ['slides/week-01-intro/thumbnail.webp'],
      { isPublic: false }
    );

    // A public deck is signed at `month`; the flag has to travel, not default.
    warmContentBlob.mockClear();
    findUnique.mockResolvedValue(slideRow({ is_public: true }));
    await run();
    expect(warmContentBlob).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      isPublic: true,
    });
  });

  it('warms only after the asset row lands, and does not wait for it', async () => {
    const order: string[] = [];
    recordContentAsset.mockImplementation(async () => {
      order.push('record');
      return true;
    });
    // The warm looks the sha up in the map, so a warm that ran first would look
    // up a row that is not there yet and quietly do nothing. Never resolving is
    // how "not awaited" is proved: an awaited warm would hang this test.
    warmContentBlob.mockImplementation(() => {
      order.push('warm');
      return new Promise(() => {});
    });

    await expect(run()).resolves.toMatchObject({ status: 'rendered' });
    expect(order).toEqual(['record', 'warm']);
  });

  it('does not warm when the commit produced no sha to warm', async () => {
    uploadBatch.mockResolvedValue({ commit: 'c'.repeat(40), filesUploaded: 0, files: [] });

    await expect(run()).resolves.toMatchObject({ status: 'rendered' });
    expect(recordContentAsset).not.toHaveBeenCalled();
    expect(warmContentBlob).not.toHaveBeenCalled();
  });

  it("stores the INDEX's sha, not the thumbnail's, as what was rendered from", async () => {
    await run();
    expect(update).toHaveBeenCalledWith({
      where: { id: SLIDE_ID },
      data: {
        thumbnail_path: 'slides/week-01-intro/thumbnail.webp',
        thumbnail_rendered_sha: INDEX_SHA,
        thumbnail_rendered_at: expect.any(Date),
      },
    });
  });

  it('renders at 1280x720 and waits for the readiness selector', async () => {
    await run();
    expect(screenshotToBase64).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 1280,
        height: 720,
        quality: 80,
        readySelector: '[data-thumbnail-ready]',
      })
    );
  });

  it('mints the token per run, sends it as a HEADER, and never logs it', async () => {
    await run();

    expect(signDeckRenderToken).toHaveBeenCalledWith({
      origin: 'https://slides.classmoji.test',
      classroomId: CLASSROOM_ID,
      slideId: SLIDE_ID,
      keyVersion: 0,
    });

    // The URL carries NO credential: it is written to the slides app's own
    // access log on every render, and a query-string token would be written
    // with it.
    const call = screenshotToBase64.mock.calls[0][0];
    expect(call.url).toBe(`https://slides.classmoji.test/${SLIDE_ID}/thumbnail-source`);
    expect(call.url).not.toContain('render=');
    expect(call.headers).toEqual({ 'X-Render-Token': '1767225720.c2lnbmF0dXJl' });

    const logged = JSON.stringify([
      loggerInfo.mock.calls,
      loggerWarn.mock.calls,
      loggerError.mock.calls,
    ]);
    expect(logged).not.toContain('1767225720.c2lnbmF0dXJl');
    expect(logged).not.toContain('render=');
  });

  it('leaves the recorded sha alone when nothing could tell it what the sha is', async () => {
    // Map miss AND a metadata read that threw: `indexSha` is null. Writing that
    // null would erase a previous, perfectly good answer and make the next run
    // re-render for no reason — the render still happens, the column does not
    // move.
    lookupContentAsset.mockResolvedValue(null);
    getMeta.mockRejectedValue(new Error('GitHub is having a moment'));
    findUnique.mockResolvedValue(slideRow({ thumbnail_rendered_sha: 'e'.repeat(40) }));

    await expect(run()).resolves.toMatchObject({ status: 'rendered' });

    expect(update).toHaveBeenCalledWith({
      where: { id: SLIDE_ID },
      data: {
        thumbnail_path: 'slides/week-01-intro/thumbnail.webp',
        thumbnail_rendered_at: expect.any(Date),
      },
    });
    expect(update.mock.calls[0][0].data).not.toHaveProperty('thumbnail_rendered_sha');
  });
});

describe('force', () => {
  it('renders a deck whose sha has not moved when the payload says to', async () => {
    // A theme edit changes how every deck in a classroom LOOKS without touching
    // a byte of any of them, so the sha check answers the wrong question there.
    findUnique.mockResolvedValue(
      slideRow({
        thumbnail_path: 'slides/week-01-intro/thumbnail.webp',
        thumbnail_rendered_sha: INDEX_SHA,
      })
    );

    await expect(run({ force: true })).resolves.toMatchObject({ status: 'rendered' });
    expect(screenshotToBase64).toHaveBeenCalledTimes(1);
  });

  it('still records the sha it rendered from', async () => {
    findUnique.mockResolvedValue(
      slideRow({
        thumbnail_path: 'slides/week-01-intro/thumbnail.webp',
        thumbnail_rendered_sha: INDEX_SHA,
      })
    );

    await run({ force: true });

    expect(update).toHaveBeenCalledWith({
      where: { id: SLIDE_ID },
      data: expect.objectContaining({ thumbnail_rendered_sha: INDEX_SHA }),
    });
  });

  it('is off by default — the ordinary save path still skips', async () => {
    findUnique.mockResolvedValue(
      slideRow({
        thumbnail_path: 'slides/week-01-intro/thumbnail.webp',
        thumbnail_rendered_sha: INDEX_SHA,
      })
    );

    await expect(run()).resolves.toMatchObject({ status: 'unchanged' });
    expect(screenshotToBase64).not.toHaveBeenCalled();
  });
});

describe('failure keeps the existing thumbnail', () => {
  it('honours a 429’s Retry-After before rethrowing into the retry policy', async () => {
    screenshotToBase64.mockRejectedValue(
      new BrowserRunError('Rate limited', {
        status: 429,
        retryable: true,
        retryAfterSeconds: 7,
      })
    );

    await expect(run()).rejects.toThrow('Rate limited');

    // The server said when to come back; retrying inside that window just burns
    // an attempt to arrive at the same 429.
    expect(waitFor).toHaveBeenCalledWith({ seconds: 7 });
    expect(uploadBatch).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('back off'),
      expect.objectContaining({ status: 429, retryAfterSeconds: 7, waitingSeconds: 7 })
    );
  });

  it('caps the wait at 90s — this run has a maxDuration to keep', async () => {
    screenshotToBase64.mockRejectedValue(
      new BrowserRunError('Rate limited', {
        status: 429,
        retryable: true,
        retryAfterSeconds: 3600,
      })
    );

    await expect(run()).rejects.toThrow('Rate limited');
    expect(waitFor).toHaveBeenCalledWith({ seconds: 90 });
  });

  it('does not wait at all when there is no Retry-After to honour', async () => {
    screenshotToBase64.mockRejectedValue(
      new BrowserRunError('Rate limited', { status: 429, retryable: true })
    );

    await expect(run()).rejects.toThrow('Rate limited');
    expect(waitFor).not.toHaveBeenCalled();
  });

  it('rethrows a 5xx as well', async () => {
    screenshotToBase64.mockRejectedValue(
      new BrowserRunError('Bad gateway', { status: 502, retryable: true })
    );
    await expect(run()).rejects.toThrow('Bad gateway');
    expect(uploadBatch).not.toHaveBeenCalled();
    expect(waitFor).not.toHaveBeenCalled();
  });

  it('returns quietly on a 422, leaving the stored thumbnail and its sha alone', async () => {
    findUnique.mockResolvedValue(
      slideRow({
        thumbnail_path: 'slides/week-01-intro/thumbnail.webp',
        thumbnail_rendered_sha: 'd'.repeat(40),
      })
    );
    screenshotToBase64.mockRejectedValue(
      new BrowserRunError('Navigation timed out', { status: 422, retryable: false })
    );

    await expect(run()).resolves.toMatchObject({ status: 'failed' });
    expect(uploadBatch).not.toHaveBeenCalled();
    expect(recordContentAsset).not.toHaveBeenCalled();

    // The ATTEMPT is stamped and nothing else. `thumbnail_path` and
    // `thumbnail_rendered_sha` still describe the picture that is actually in
    // the repo, and the index rate-limits its on-view enqueue against the
    // timestamp — without this, a deck whose renders keep failing would be
    // re-asked for by every single page load.
    expect(update).toHaveBeenCalledWith({
      where: { id: SLIDE_ID },
      data: { thumbnail_rendered_at: expect.any(Date) },
    });
  });

  it('never deletes or blanks a thumbnail on any failure path', async () => {
    screenshotToBase64.mockRejectedValue(new Error('something else entirely'));
    await expect(run()).resolves.toMatchObject({ status: 'failed' });

    const data = update.mock.calls[0][0].data;
    expect(Object.keys(data)).toEqual(['thumbnail_rendered_at']);
  });

  it('redacts the render token out of the reason it reports and logs', async () => {
    // The `reason` is stored on the Trigger run where anyone with dashboard
    // access reads it, and Cloudflare quotes the request back in its errors.
    const token = '1767225720.c2lnbmF0dXJl';
    screenshotToBase64.mockRejectedValue(
      new BrowserRunError(
        `Navigation failed for https://slides.classmoji.test/d/thumbnail-source?render=${token} headers {"X-Render-Token":"${token}"}`,
        { status: 422, retryable: false }
      )
    );

    const result = await run();

    expect(result.status).toBe('failed');
    expect(result.reason).not.toContain(token);
    expect(result.reason).toContain('Navigation failed');

    const logged = JSON.stringify(loggerError.mock.calls);
    expect(logged).not.toContain(token);
  });
});

describe('skips rather than fails when it cannot run at all', () => {
  it('skips when Browser Run is unconfigured', async () => {
    isBrowserRunConfigured.mockReturnValue(false);
    await expect(run()).resolves.toEqual({
      status: 'skipped',
      reason: 'browser-run-unconfigured',
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('skips when SLIDES_URL is unset', async () => {
    delete process.env.SLIDES_URL;
    await expect(run()).resolves.toEqual({ status: 'skipped', reason: 'slides-url-unset' });
  });

  it('skips a slide that no longer exists', async () => {
    findUnique.mockResolvedValue(null);
    await expect(run()).resolves.toEqual({ status: 'skipped', reason: 'slide-not-found' });
  });

  it('skips a classroom with no content repo', async () => {
    findUnique.mockResolvedValue(
      slideRow({ classroom: { ...slideRow().classroom, content_repo: null } })
    );
    await expect(run()).resolves.toEqual({ status: 'skipped', reason: 'no-content-repo' });
  });

  it('skips when nothing can sign a render token', async () => {
    signDeckRenderToken.mockResolvedValue(null);
    await expect(run()).resolves.toEqual({ status: 'skipped', reason: 'signing-unconfigured' });
    expect(screenshotToBase64).not.toHaveBeenCalled();
  });
});

describe('loop guard', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../deckThumbnail.ts', import.meta.url)),
    'utf8'
  );
  // The prose above the task names these deliberately; strip comments so the
  // assertion is about the CODE and not about the explanation of the rule.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it.each(['saveDeck', 'saveDeckWithMerge', 'saveDeckFromOps', 'recordDeckFiles'])(
    'never calls %s — the enqueue for this task lives inside those',
    name => {
      expect(code).not.toContain(name);
    }
  );

  it('does not import the deck engine at all', () => {
    expect(code).not.toContain('@classmoji/services/slides');
  });

  it('never touches deck.json, whose sha the editor watches for its own save', () => {
    expect(code).not.toContain('deck.json');
  });
});
