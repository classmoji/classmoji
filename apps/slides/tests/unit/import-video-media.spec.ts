/**
 * The slides.com import's videos on a classroom with media storage
 * (`importVideoMedia.ts`), and the importer's wiring around it.
 *
 * The rules are pure with the write injected, so they run here with media
 * storage mocked: which entries the router sends to media, what a stored video
 * becomes in the deck (`media://{id}`), and what one that media storage refuses
 * becomes (left out, with a named warning through the same gate as the size
 * skips — never a failed import). The importer itself needs a database and
 * GitHub, so its use of those rules is pinned from its source, as
 * zip-repo-entries.spec does; so is the retirement of the Cloudinary choice
 * from the import flow.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

import {
  IMPORT_VIDEO_OPTIONS,
  importEntryGoesToMedia,
  importMediaSkippedWarning,
  storeImportVideosInMedia,
  type PutImportVideo,
} from '../../app/utils/importVideoMedia.ts';
import type { UploadCapability } from '../../app/utils/mediaUpload.ts';
import { RepoEntryGate, resolveMediaRef } from '../../app/utils/zipRepoEntries.ts';

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const source = (relative: string) => readFileSync(path(relative), 'utf8');

const MB = 1024 * 1024;
const GB = 1024 * MB;

const PRO: UploadCapability = {
  repoMaxBytes: 35 * MB,
  repoFileTypes: 'any',
  isPro: true,
  media: { perFileMaxBytes: 2 * GB, remainingBytes: 10 * GB },
};
const FREE: UploadCapability = { ...PRO, isPro: false, media: null };
const PRO_NO_MEDIA: UploadCapability = { ...PRO, media: null };

const ID_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ID_C = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';

test.describe('which ZIP entries go to media', () => {
  test('on a classroom with media, every video — whatever its size', () => {
    expect(importEntryGoesToMedia(PRO, 'intro.mp4', 2 * MB)).toBe(true);
    expect(importEntryGoesToMedia(PRO, 'lecture.mov', 120 * MB)).toBe(true);
    expect(importEntryGoesToMedia(PRO, 'clip.webm', 0)).toBe(true);
  });

  test('audio that fits stays in the repository; over the cap it goes to media', () => {
    expect(importEntryGoesToMedia(PRO, 'theme.mp3', 4 * MB)).toBe(false);
    expect(importEntryGoesToMedia(PRO, 'podcast.mp3', 40 * MB)).toBe(true);
  });

  test('never on a classroom without media — Free, or Pro whose media is unavailable', () => {
    expect(importEntryGoesToMedia(FREE, 'intro.mp4', 2 * MB)).toBe(false);
    expect(importEntryGoesToMedia(FREE, 'lecture.mp4', 80 * MB)).toBe(false);
    expect(importEntryGoesToMedia(PRO_NO_MEDIA, 'lecture.mp4', 80 * MB)).toBe(false);
    expect(importEntryGoesToMedia(null, 'intro.mp4', 2 * MB)).toBe(false);
  });

  test('stored with the uploader’s defaults: optimise, keep the original, no download', () => {
    expect(IMPORT_VIDEO_OPTIONS).toEqual({
      optimise: true,
      keepOriginal: true,
      allowDownload: false,
    });
  });
});

test.describe('writing the videos to media (media storage mocked)', () => {
  const queue = [
    { filePath: 'media/a/intro.mp4', filename: 'intro.mp4', buffer: Buffer.alloc(3 * MB) },
    { filePath: 'media/b/lecture.mp4', filename: 'lecture.mp4', buffer: Buffer.alloc(5 * MB) },
    { filePath: 'media/c/outro.mp4', filename: 'outro.mp4', buffer: Buffer.alloc(1 * MB) },
  ];

  /** Stores everything but `lecture.mp4`, which the quota refuses. */
  function mockPut() {
    const calls: Array<{ filename: string; bytes: number }> = [];
    const put: PutImportVideo = async ({ filename, bytes }) => {
      calls.push({ filename, bytes: bytes.length });
      if (filename === 'lecture.mp4') {
        throw Object.assign(new Error('Quota exceeded: 9.9 GB of 10 GB'), {
          name: 'MediaError',
          code: 'QUOTA_EXCEEDED',
        });
      }
      const mediaId = filename === 'intro.mp4' ? ID_A : ID_C;
      return { mediaId, ref: `media://${mediaId}` };
    };
    return { put, calls };
  }

  test('a stored video is referenced as media://{id}; a refused one is left out, named', async () => {
    const { put, calls } = mockPut();
    const gate = new RepoEntryGate();
    const videoMap = new Map<string, string>();
    const progress: string[] = [];
    const errors: string[] = [];

    const stored = await storeImportVideosInMedia({
      queue,
      put,
      gate,
      videoMap,
      onEach: (current, total, filename) => progress.push(`${current}/${total} ${filename}`),
      onError: filename => errors.push(filename),
    });

    // Every video was offered to media, with its own bytes — one failure does
    // not stop the ones after it.
    expect(calls).toEqual([
      { filename: 'intro.mp4', bytes: 3 * MB },
      { filename: 'lecture.mp4', bytes: 5 * MB },
      { filename: 'outro.mp4', bytes: 1 * MB },
    ]);
    expect(progress).toEqual(['1/3 intro.mp4', '2/3 lecture.mp4', '3/3 outro.mp4']);
    expect(stored).toEqual([ID_A, ID_C]);

    // Stored: under its zip path and its filename, as the importer maps.
    expect(videoMap.get('media/a/intro.mp4')).toBe(`media://${ID_A}`);
    expect(videoMap.get('intro.mp4')).toBe(`media://${ID_A}`);
    expect(videoMap.get('outro.mp4')).toBe(`media://${ID_C}`);
    expect(videoMap.has('lecture.mp4')).toBe(false);

    // Refused: through the gate, so the deck drops its references and the
    // warning names the slides that used it.
    expect(errors).toEqual(['lecture.mp4']);
    expect(gate.skippedPaths()).toEqual(new Set(['media/b/lecture.mp4']));
    const [warning] = gate.warnings(new Map([['media/b/lecture.mp4', ['4']]]));
    expect(warning).toBe(
      "Slide 4: Skipped lecture.mp4 (5 MB) — media storage could not take it (this class's media storage is full)"
    );
    expect(warning).not.toContain('QUOTA_EXCEEDED');

    // And the deck's references resolve accordingly.
    const skipped = gate.skippedPaths();
    expect(resolveMediaRef('media/a/intro.mp4', videoMap, skipped)).toEqual({
      kind: 'kept',
      url: `media://${ID_A}`,
    });
    expect(resolveMediaRef('media/b/lecture.mp4', videoMap, skipped)).toEqual({
      kind: 'skipped',
      path: 'media/b/lecture.mp4',
    });
  });

  test('a warning never carries a code or an upstream message', () => {
    for (const code of ['NOT_CONFIGURED', 'PRO_REQUIRED', 'FILE_TOO_LARGE', 'SOMETHING_NEW']) {
      const warning = importMediaSkippedWarning('a.mp4', MB, { code, message: 'R2 said 503' });
      expect(warning).toMatch(/^Skipped a\.mp4 \(1 MB\) — media storage could not take it \(/);
      expect(warning).not.toContain(code);
      expect(warning).not.toContain('R2 said');
    }
    expect(importMediaSkippedWarning('a.mp4', MB, new Error('socket hang up'))).toContain(
      '(the upload failed)'
    );
  });
});

test.describe('the importer’s wiring', () => {
  const IMPORTER = source('../../app/utils/slidesComImporter.server.ts');
  const START = source('../../app/routes/api.slides.import.start/route.ts');
  const PAGE = source('../../app/routes/import/route.tsx');
  const PROGRESS = source('../../app/components/ImportProgressModal.tsx');
  const RULES = source('../../app/utils/importVideoMedia.ts');

  test('routes each video with the classroom’s own capability', () => {
    expect(IMPORTER).toContain('ClassmojiService.media.uploadCapabilityFor(classroom)');
    // By the declared size first, then by the bytes themselves.
    expect(IMPORTER).toContain('importEntryGoesToMedia(uploadCapability, filename, declared ?? 0)');
    expect(IMPORTER).toContain('importEntryGoesToMedia(uploadCapability, filename, buffer.length)');
  });

  test('writes with putMediaObject and the import’s video options', () => {
    expect(IMPORTER).toContain('ClassmojiService.media.putMediaObject({');
    expect(IMPORTER).toContain('options: { ...IMPORT_VIDEO_OPTIONS }');
    // Through the gate the size skips use, so a refusal is a named warning.
    expect(IMPORTER).toContain('gate: repoGate,');
  });

  test('a failed import deletes the media it wrote', () => {
    const cleanup = IMPORTER.slice(IMPORTER.indexOf('const cleanupFailedImport'));
    expect(
      cleanup.indexOf('ClassmojiService.media.deleteMedia({ classroom, mediaId })')
    ).toBeGreaterThan(-1);
    // The media writes happen after the slide row exists, so that cleanup
    // covers every one of them.
    expect(IMPORTER.indexOf('storeImportVideosInMedia({')).toBeGreaterThan(
      IMPORTER.indexOf('getPrisma().slide.create(')
    );
  });

  test('the media goes first, and a failing slide delete cannot strand it', () => {
    const start = IMPORTER.indexOf('const cleanupFailedImport');
    const cleanup = IMPORTER.slice(start, IMPORTER.indexOf('\n  };', start));
    const media = cleanup.indexOf('ClassmojiService.media.deleteMedia(');
    const slide = cleanup.indexOf('getPrisma().slide.delete(');
    expect(media).toBeGreaterThan(-1);
    expect(slide).toBeGreaterThan(media);
    // The slide delete is guarded on its own, so its failure is logged rather
    // than replacing the import's error.
    expect(cleanup.lastIndexOf('try {', slide)).toBeGreaterThan(media);
    expect(cleanup.slice(slide)).toContain('catch (cleanupErr: unknown)');
  });

  test('Cloudinary is gone from the import flow', () => {
    for (const text of [IMPORTER, START, PAGE, PROGRESS]) {
      expect(text).not.toMatch(/cloudinary/i);
    }
    expect(existsSync(path('../../app/components/VideoSelectionModal.tsx'))).toBe(false);
    expect(existsSync(path('../../app/utils/zipAnalyzer.ts'))).toBe(false);
    expect(PROGRESS).toContain('uploading_media');
  });

  test('the rules module stays off the services barrel', () => {
    // The router subpath only — the barrel would pull Prisma and the S3 client.
    expect(RULES).toContain("from '@classmoji/services/media/router'");
    expect(RULES).not.toMatch(/from '@classmoji\/services'/);
  });
});
