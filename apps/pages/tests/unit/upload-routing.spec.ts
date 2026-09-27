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
import type { UploadCapability } from '@classmoji/services/media/router';
import { REPO_REST_MAX_BYTES } from '@classmoji/utils/repo-limits';

import {
  EDITOR_VIDEO_OPTIONS,
  UploadRefused,
  UploadReroute,
  firstDestination,
  mediaOptionsFor,
  mediaUploadMessage,
  placeUpload,
  type UploadPorts,
} from '~/components/editor/media/uploadRouting.ts';

const GIB = 1024 * 1024 * 1024;

const FREE: UploadCapability = {
  repoMaxBytes: REPO_REST_MAX_BYTES,
  repoFileTypes: 'any',
  isPro: false,
  media: null,
};
const PRO: UploadCapability = {
  ...FREE,
  isPro: true,
  media: { perFileMaxBytes: 2 * GIB, remainingBytes: 10 * GIB },
};

/** A File-shaped stand-in: routing reads the name and the size only. */
const file = (name: string, size: number) => ({ name, size }) as unknown as File;

const SMALL_VIDEO = file('lecture.mp4', 5 * 1024 * 1024);
const SMALL_IMAGE = file('diagram.png', 200 * 1024);
const BIG_PDF = file('scans.pdf', REPO_REST_MAX_BYTES + 1);

/** Ports that record which side was called and answer as scripted. */
function ports(script: { repo?: () => unknown; media?: () => unknown } = {}) {
  const calls: string[] = [];
  const mediaOptions: unknown[] = [];
  const impl: UploadPorts = {
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
    expect(p.calls).toEqual(['media']);
  });

  test('videos carry the editor defaults; nothing else carries options', async () => {
    const p = ports();
    await placeUpload(SMALL_VIDEO, PRO, p.impl);
    await placeUpload(BIG_PDF, PRO, p.impl);
    expect(p.mediaOptions).toEqual([EDITOR_VIDEO_OPTIONS, undefined]);
    expect(EDITOR_VIDEO_OPTIONS).toEqual({
      optimise: true,
      keepOriginal: true,
      allowDownload: false,
    });
    expect(mediaOptionsFor({ name: 'x.MOV' })).toEqual(EDITOR_VIDEO_OPTIONS);
    expect(mediaOptionsFor({ name: 'x.pdf' })).toBeUndefined();
  });

  test('a stale capability: the repository says USE_MEDIA, the file goes to media once', async () => {
    const p = ports({ repo: () => new UploadReroute('media') });
    const placed = await placeUpload(SMALL_VIDEO, FREE, p.impl);
    expect(placed.destination).toBe('media');
    expect(p.calls).toEqual(['repo', 'media']);
    // The redirected video still gets the video defaults.
    expect(p.mediaOptions).toEqual([EDITOR_VIDEO_OPTIONS]);
  });

  test('a missing capability is rescued by the same redirect', async () => {
    const p = ports({ repo: () => new UploadReroute('media') });
    expect((await placeUpload(SMALL_VIDEO, null, p.impl)).ref).toBe('media://id');
  });

  test('media says USE_REPO, the file goes to the repository once', async () => {
    const p = ports({ media: () => new UploadReroute('repo') });
    const placed = await placeUpload(SMALL_VIDEO, PRO, p.impl);
    expect(placed.destination).toBe('repo');
    expect(p.calls).toEqual(['media', 'repo']);
  });

  test('two disagreements are refused, never chased back', async () => {
    const p = ports({
      repo: () => new UploadReroute('media'),
      media: () => new UploadReroute('repo'),
    });
    await expect(placeUpload(SMALL_VIDEO, FREE, p.impl)).rejects.toBeInstanceOf(UploadRefused);
    expect(p.calls).toEqual(['repo', 'media']);
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
    expect(p.calls).toEqual(['media']);
  });
});

test.describe('media refusals read as sentences', () => {
  test('quota names the numbers when the server sent them', () => {
    expect(
      mediaUploadMessage({ code: 'QUOTA_EXCEEDED', usedBytes: 9 * GIB, quotaBytes: 10 * GIB }, PRO)
    ).toContain('9 GB of 10 GB');
  });

  test('the per-file limit comes from the capability', () => {
    expect(mediaUploadMessage({ code: 'FILE_TOO_LARGE' }, PRO)).toContain('2 GB');
  });

  test('an unknown failure reads as a connection problem, not silence', () => {
    expect(mediaUploadMessage({ code: 'NETWORK' }, PRO)).toMatch(/connection/);
  });
});
