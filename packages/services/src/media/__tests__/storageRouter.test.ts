/**
 * The storage router's rule (§7.10), as the truth table it is.
 *
 * And a guard on its import graph: the editors import it in the BROWSER through
 * `@classmoji/services/media/router`, so a change that made it reach Prisma or
 * the S3 client would ship a server package to every student's tab. Both are
 * mocked to throw on load here — a transitive import of either fails this file
 * before a single case runs.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@classmoji/database', () => {
  throw new Error('the storage router must not load @classmoji/database');
});
vi.mock('@aws-sdk/client-s3', () => {
  throw new Error('the storage router must not load @aws-sdk/client-s3');
});
vi.mock('@aws-sdk/s3-request-presigner', () => {
  throw new Error('the storage router must not load the presigner');
});

const { storageTargetFor, kindOfFilename } = await import('../storageRouter.ts');
type UploadCapability = import('../storageRouter.ts').UploadCapability;

const MB = 1024 * 1024;
const GB = 1024 * MB;
const REPO_MAX = 35 * MB;

const free: UploadCapability = {
  repoMaxBytes: REPO_MAX,
  repoFileTypes: 'any',
  isPro: false,
  media: null,
};
const freeAllowlist: UploadCapability = { ...free, repoFileTypes: 'allowlist' };
const pro: UploadCapability = {
  repoMaxBytes: REPO_MAX,
  repoFileTypes: 'any',
  isPro: true,
  media: { perFileMaxBytes: 2 * GB, remainingBytes: 10 * GB },
};
/** Pro, but media is off here (no bucket, or the class cannot deliver). */
const proNoMedia: UploadCapability = { ...pro, media: null };

describe('storageTargetFor — with media', () => {
  it('sends every video to media, however small', () => {
    expect(storageTargetFor(pro, { name: 'intro.mp4', size: 1 * MB })).toEqual({ kind: 'media' });
    expect(storageTargetFor(pro, { name: 'Lecture.MOV', size: 10 })).toEqual({ kind: 'media' });
  });

  it('keeps small non-video files in the repository', () => {
    for (const name of ['diagram.png', 'notes.pdf', 'deck.pptx', 'song.mp3', 'data.csv']) {
      expect(storageTargetFor(pro, { name, size: 5 * MB })).toEqual({ kind: 'repo' });
    }
  });

  it('keeps a file exactly at the cap in the repository', () => {
    expect(storageTargetFor(pro, { name: 'big.pdf', size: REPO_MAX })).toEqual({ kind: 'repo' });
  });

  it('sends anything over the cap to media', () => {
    expect(storageTargetFor(pro, { name: 'big.pdf', size: REPO_MAX + 1 })).toEqual({
      kind: 'media',
    });
    expect(storageTargetFor(pro, { name: 'dataset.zip', size: 800 * MB })).toEqual({
      kind: 'media',
    });
  });

  it('refuses a file over the per-file ceiling, naming it', () => {
    const target = storageTargetFor(pro, { name: 'raw.mov', size: 2 * GB + 1 });
    expect(target).toEqual({
      kind: 'refused',
      code: 'MEDIA_UNAVAILABLE',
      message: 'This file is larger than the 2 GB limit for one file.',
    });
  });

  it('does not refuse on remaining quota — the upload itself enforces that', () => {
    const full = { ...pro, media: { perFileMaxBytes: 2 * GB, remainingBytes: 0 } };
    expect(storageTargetFor(full, { name: 'intro.mp4', size: 5 * MB })).toEqual({
      kind: 'media',
    });
  });

  it('refuses a media-bound file with no extension, with the media store’s sentence', () => {
    const target = storageTargetFor(pro, { name: 'recording', size: 50 * MB });
    expect(target).toMatchObject({ kind: 'refused', code: 'TYPE_NOT_ALLOWED' });
    expect((target as { message: string }).message).toMatch(/needs an extension/);
  });

  it('takes a caller-supplied kind over the name', () => {
    expect(storageTargetFor(pro, { name: 'clip.bin', size: MB, kind: 'VIDEO' })).toEqual({
      kind: 'media',
    });
  });
});

describe('storageTargetFor — without media', () => {
  it('keeps a video that fits in the repository', () => {
    expect(storageTargetFor(free, { name: 'intro.mp4', size: 20 * MB })).toEqual({
      kind: 'repo',
    });
  });

  it('refuses a file over the cap, and tells a free class what Pro stores', () => {
    expect(storageTargetFor(free, { name: 'lecture.mp4', size: 120 * MB })).toEqual({
      kind: 'refused',
      code: 'TOO_LARGE_FOR_REPO',
      message:
        'This file is larger than the 35 MB your course repository accepts. ' +
        'Pro stores files up to 2 GB.',
    });
  });

  it('does not sell Pro to a class that already has it — media is what is unavailable', () => {
    expect(storageTargetFor(proNoMedia, { name: 'lecture.mp4', size: 120 * MB })).toEqual({
      kind: 'refused',
      code: 'MEDIA_UNAVAILABLE',
      message:
        "Media storage isn't available for this class right now, and this file is larger " +
        'than the 35 MB your course repository accepts.',
    });
  });

  it('names the per-file ceiling for a Pro class without media when the file is past it', () => {
    expect(storageTargetFor(proNoMedia, { name: 'raw.mov', size: 2 * GB + 1 })).toEqual({
      kind: 'refused',
      code: 'MEDIA_UNAVAILABLE',
      message: 'This file is larger than the 2 GB limit for one file.',
    });
  });

  it('applies the classroom’s repository type policy', () => {
    expect(storageTargetFor(freeAllowlist, { name: 'a.png', size: MB })).toEqual({ kind: 'repo' });
    const target = storageTargetFor(freeAllowlist, { name: 'a.mp4', size: MB });
    expect(target).toMatchObject({ kind: 'refused', code: 'TYPE_NOT_ALLOWED' });
    expect((target as { message: string }).message).toMatch(/Allowed:/);
  });

  it('refuses a name that is not one', () => {
    expect(storageTargetFor(free, { name: 'folder/a.png', size: MB })).toMatchObject({
      kind: 'refused',
      code: 'TYPE_NOT_ALLOWED',
    });
  });
});

describe('kindOfFilename', () => {
  it('reads the kind from the extension, OTHER when there is none', () => {
    expect(kindOfFilename('a.MP4')).toBe('VIDEO');
    expect(kindOfFilename('a.pdf')).toBe('DOCUMENT');
    expect(kindOfFilename('a.csv')).toBe('OTHER');
    expect(kindOfFilename('Makefile')).toBe('OTHER');
  });
});
