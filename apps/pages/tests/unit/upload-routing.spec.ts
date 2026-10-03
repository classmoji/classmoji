/**
 * The page editor's upload routing: where a file goes first, and the one
 * redirect it follows when the server disagrees.
 *
 * The rule itself is the storage router's and is tested with it; what is held
 * here is the editor's use of it — the capability it routes against may be
 * stale or missing, the server's answer wins, and a disagreement is followed
 * once and never ping-ponged.
 */

import { test, expect } from '@playwright/test';
import { MEDIA_QUOTA_FULL_MESSAGE, type UploadCapability } from '@classmoji/services/media/router';
import { REPO_REST_MAX_BYTES } from '@classmoji/utils/repo-limits';

import {
  UploadCancelled,
  UploadRefused,
  UploadReroute,
  firstDestination,
  fitsRepoInstead,
  mediaProgressLabel,
  mediaRefusalGoesToRepo,
  mediaUploadMessage,
  placeUpload,
  type UploadPorts,
} from '~/components/editor/media/uploadRouting.ts';

const GIB = 1024 * 1024 * 1024;
/** The media per-file ceiling: a DECIMAL 2 GB (`PER_FILE_MAX_BYTES`). */
const PER_FILE = 2_000_000_000;

const FREE: UploadCapability = {
  repoMaxBytes: REPO_REST_MAX_BYTES,
  repoFileTypes: 'any',
  isPro: false,
  media: null,
};
const PRO: UploadCapability = {
  ...FREE,
  isPro: true,
  media: { perFileMaxBytes: PER_FILE, remainingBytes: 10 * GIB },
};

/** A File-shaped stand-in: routing reads the name and the size only. */
const file = (name: string, size: number) => ({ name, size }) as unknown as File;

const SMALL_VIDEO = file('lecture.mp4', 5 * 1024 * 1024);
const SMALL_IMAGE = file('diagram.png', 200 * 1024);
const BIG_PDF = file('scans.pdf', REPO_REST_MAX_BYTES + 1);

/** What the uploader picks in the video dialog, in these tests. */
const CHOSEN = { optimise: false, keepOriginal: true, allowDownload: true };

/** Ports that record which side was called and answer as scripted. */
function ports(
  script: {
    repo?: () => unknown;
    media?: () => unknown;
    /** The dialog's answer; null = the uploader pressed Cancel. */
    ask?: () => typeof CHOSEN | null;
  } = {}
) {
  const calls: string[] = [];
  const mediaOptions: unknown[] = [];
  const impl: UploadPorts = {
    async askVideoOptions(asked) {
      calls.push(`ask:${asked.name}`);
      return script.ask ? script.ask() : CHOSEN;
    },
    async toRepo() {
      calls.push('repo');
      const out = script.repo?.();
      if (out instanceof Error) throw out;
      return { ref: 'pages/a/assets/x', displayUrl: 'https://signed/repo' };
    },
    async toMedia(_file, options) {
      calls.push('media');
      mediaOptions.push(options);
      const out = script.media?.();
      if (out instanceof Error) throw out;
      return { ref: 'media://id', displayUrl: 'https://signed/media' };
    },
  };
  return { impl, calls, mediaOptions };
}

test.describe('the first destination', () => {
  test('Pro: videos and anything over the repository cap go to media', () => {
    expect(firstDestination(PRO, SMALL_VIDEO)).toEqual({ kind: 'media' });
    expect(firstDestination(PRO, BIG_PDF)).toEqual({ kind: 'media' });
    expect(firstDestination(PRO, SMALL_IMAGE)).toEqual({ kind: 'repo' });
  });

  test('Free: a video that fits stays in the repository; a big file is refused with the Pro note', () => {
    expect(firstDestination(FREE, SMALL_VIDEO)).toEqual({ kind: 'repo' });
    const big = firstDestination(FREE, BIG_PDF);
    expect(big.kind).toBe('refused');
    expect((big as { message: string }).message).toContain('Pro stores files up to 2 GB');
  });

  test('no capability: the editor behaves as it did before routing, repository-only', () => {
    expect(firstDestination(null, SMALL_VIDEO)).toEqual({ kind: 'repo' });
    expect(firstDestination(undefined, BIG_PDF).kind).toBe('refused');
  });
});

test.describe('placing an upload', () => {
  test('goes where the router says, and says where it went', async () => {
    const p = ports();
    expect(await placeUpload(SMALL_VIDEO, PRO, p.impl)).toEqual({
      ref: 'media://id',
      displayUrl: 'https://signed/media',
      destination: 'media',
    });
    expect(p.calls).toEqual(['ask:lecture.mp4', 'media']);
  });

  test('a video bound for media carries what the uploader chose; nothing else is asked', async () => {
    const p = ports();
    await placeUpload(SMALL_VIDEO, PRO, p.impl);
    await placeUpload(BIG_PDF, PRO, p.impl);
    expect(p.mediaOptions).toEqual([CHOSEN, undefined]);
    expect(p.calls).toEqual(['ask:lecture.mp4', 'media', 'media']);
  });

  test('a video staying in the repository is not asked about media options', async () => {
    const p = ports();
    await placeUpload(SMALL_VIDEO, FREE, p.impl);
    expect(p.calls).toEqual(['repo']);
  });

  test('cancelling the video dialog sends nothing, and says nothing', async () => {
    const p = ports({ ask: () => null });
    await expect(placeUpload(SMALL_VIDEO, PRO, p.impl)).rejects.toBeInstanceOf(UploadCancelled);
    expect(p.calls).toEqual(['ask:lecture.mp4']);
  });

  test('a stale capability: the repository says USE_MEDIA, the file goes to media once', async () => {
    const p = ports({ repo: () => new UploadReroute('media') });
    const placed = await placeUpload(SMALL_VIDEO, FREE, p.impl);
    expect(placed.destination).toBe('media');
    // The redirected video is asked about, right before it goes to media.
    expect(p.calls).toEqual(['repo', 'ask:lecture.mp4', 'media']);
    expect(p.mediaOptions).toEqual([CHOSEN]);
  });

  test('a missing capability is rescued by the same redirect', async () => {
    const p = ports({ repo: () => new UploadReroute('media') });
    expect((await placeUpload(SMALL_VIDEO, null, p.impl)).ref).toBe('media://id');
  });

  test('media says USE_REPO, the file goes to the repository once', async () => {
    const p = ports({ media: () => new UploadReroute('repo') });
    const placed = await placeUpload(SMALL_VIDEO, PRO, p.impl);
    expect(placed.destination).toBe('repo');
    expect(p.calls).toEqual(['ask:lecture.mp4', 'media', 'repo']);
  });

  test('two disagreements are refused, never chased back', async () => {
    const p = ports({
      repo: () => new UploadReroute('media'),
      media: () => new UploadReroute('repo'),
    });
    await expect(placeUpload(SMALL_VIDEO, FREE, p.impl)).rejects.toBeInstanceOf(UploadRefused);
    expect(p.calls).toEqual(['repo', 'ask:lecture.mp4', 'media']);
  });

  test('a router refusal never reaches either store', async () => {
    const p = ports();
    await expect(placeUpload(BIG_PDF, FREE, p.impl)).rejects.toBeInstanceOf(UploadRefused);
    expect(p.calls).toEqual([]);
  });

  test('any other failure is passed through untouched', async () => {
    const boom = new UploadRefused('Quota full.');
    const p = ports({ media: () => boom });
    await expect(placeUpload(SMALL_VIDEO, PRO, p.impl)).rejects.toBe(boom);
    expect(p.calls).toEqual(['ask:lecture.mp4', 'media']);
  });
});

test.describe('media refusals read as sentences', () => {
  test('a full quota shows the server sentence verbatim', () => {
    const server = 'Your class media is full. Contact hello@classmoji.io to upgrade your storage.';
    expect(
      mediaUploadMessage(
        {
          code: 'QUOTA_EXCEEDED',
          serverMessage: server,
          usedBytes: 9 * GIB,
          quotaBytes: 10 * GIB,
        },
        PRO
      )
    ).toBe(server);
  });

  test('a full quota with no server sentence says the same thing the server would', () => {
    expect(
      mediaUploadMessage({ code: 'QUOTA_EXCEEDED', usedBytes: 9 * GIB, quotaBytes: 10 * GIB }, PRO)
    ).toBe(MEDIA_QUOTA_FULL_MESSAGE);
    expect(MEDIA_QUOTA_FULL_MESSAGE).toContain('hello@classmoji.io');
  });

  test('the per-file limit comes from the capability, in decimal gigabytes', () => {
    // 2,000,000,000 bytes is "2 GB", not the "1.9 GB" binary units would say.
    expect(mediaUploadMessage({ code: 'FILE_TOO_LARGE' }, PRO)).toBe(
      'That file is over the 2 GB limit for a single upload.'
    );
  });

  test('an unknown failure reads as a connection problem, not silence', () => {
    expect(mediaUploadMessage({ code: 'NETWORK' }, PRO)).toMatch(/connection/);
  });
});

test.describe('the media progress toast', () => {
  test('names the destination and the room there was before the upload', () => {
    expect(mediaProgressLabel({ name: 'lecture.mp4' }, PRO)).toBe(
      'Saving lecture.mp4 to your class media — 10 GB free'
    );
  });

  test('a full store reads as none free, not a rounding artefact', () => {
    const full = { ...PRO, media: { perFileMaxBytes: PER_FILE, remainingBytes: 0 } };
    expect(mediaProgressLabel({ name: 'a.mp4' }, full)).toContain('— 0 KB free');
  });

  test('without a capability it still says where the file is going', () => {
    expect(mediaProgressLabel({ name: 'a.mp4' }, null)).toBe('Saving a.mp4 to your class media');
  });

  test('says nothing about the environment when storage is not set up', () => {
    const message = mediaUploadMessage({ code: 'NOT_CONFIGURED' }, PRO);
    expect(message).toBe("Uploading here isn't available right now.");
    expect(message).not.toMatch(/configured|environment/);
  });
});

test.describe('a stale capability falls back to the repository', () => {
  const SMALL_PDF = file('notes.pdf', 1024 * 1024);

  test('no longer Pro, not delivering, or media down: a file that fits goes to the repository', () => {
    for (const code of ['PRO_REQUIRED', 'DELIVERY_REQUIRED', 'NOT_CONFIGURED']) {
      expect(mediaRefusalGoesToRepo(code, SMALL_VIDEO, PRO), code).toBe(true);
      expect(mediaRefusalGoesToRepo(code, SMALL_PDF, PRO), code).toBe(true);
    }
  });

  test('a full quota never falls back: a Pro class whose media is full is refused', () => {
    expect(mediaRefusalGoesToRepo('QUOTA_EXCEEDED', SMALL_VIDEO, PRO)).toBe(false);
  });

  test('a file the repository cannot take is refused, not bounced', () => {
    expect(mediaRefusalGoesToRepo('PRO_REQUIRED', BIG_PDF, PRO)).toBe(false);
  });

  test("the repository's type policy counts too, not only its size", () => {
    const imagesOnly: UploadCapability = { ...PRO, repoFileTypes: 'allowlist' };
    expect(fitsRepoInstead(file('notes.pdf', 1024), imagesOnly)).toBe(true);
    expect(fitsRepoInstead(file('lecture.mp4', 1024), imagesOnly)).toBe(false);
  });

  test('with no capability, the repository size cap is all there is', () => {
    expect(fitsRepoInstead(SMALL_VIDEO, null)).toBe(true);
    expect(fitsRepoInstead(BIG_PDF, null)).toBe(false);
  });

  test('every other refusal stays a refusal', () => {
    for (const code of ['FILE_TOO_LARGE', 'KIND_NOT_ALLOWED', 'SIZE_MISMATCH', 'NETWORK']) {
      expect(mediaRefusalGoesToRepo(code, SMALL_PDF, PRO), code).toBe(false);
    }
  });
});
