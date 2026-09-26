/**
 * The rules behind the upload dialog's options and pre-checks.
 *
 * Worth their own suite because they are the only chance an instructor gets:
 * the three video choices are made once, at upload time, and the media page
 * shows the result read-only. A default that quietly flipped, or a coupling
 * that let "Keep the original" be unticked when there is no second copy to
 * keep it beside, would delete someone's only lecture recording.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VIDEO_OPTIONS,
  MAX_MEDIA_EXTENSION_LENGTH,
  applyVideoOption,
  canDropOriginal,
  extensionOf,
  formatBytes,
  isVideoFilename,
  kindForFilename,
  precheck,
  warnsWithoutOptimising,
  type QuotaSummary,
} from '../mediaUploadOptions';

const GiB = 1024 ** 3;
const quota: QuotaSummary = { usedBytes: 0, quotaBytes: 10 * GiB, perFileBytes: 2 * GiB };

describe('kinds', () => {
  it.each([
    ['lecture.mp4', 'video'],
    ['screen.MOV', 'video'],
    ['clip.m4v', 'video'],
    ['clip.webm', 'video'],
    ['intro.mp3', 'audio'],
    ['notes.pdf', 'document'],
    ['deck.pptx', 'document'],
    ['deck.key', 'document'],
    ['starter.zip', 'archive'],
    ['diagram.png', 'image'],
  ])('reads %s as %s', (filename, kind) => {
    expect(kindForFilename(filename)).toBe(kind);
  });

  it.each(['virus.exe', 'index.html', 'page.svg', 'Week 3.ipynb'])(
    'takes %s as a file of no particular kind',
    filename => {
      // Any extension goes to media; unknown ones are stored as downloads.
      expect(kindForFilename(filename)).toBe('other');
    }
  );

  it.each(['README', '.gitignore', 'notes.データ'])('has no kind for %s', filename => {
    expect(kindForFilename(filename)).toBeNull();
  });

  it('reads an extension the way the server does', () => {
    expect(extensionOf('Week 1 — Lecture.Final.MP4')).toBe('mp4');
    expect(extensionOf('noextension')).toBe('');
    expect(extensionOf('.gitignore')).toBe('');
    expect(extensionOf('data.tar-gz')).toBe('targz');
  });
});

describe('the video options', () => {
  it('starts optimised, keeping the original, with no student download', () => {
    expect(DEFAULT_VIDEO_OPTIONS).toEqual({
      optimise: true,
      keepOriginal: true,
      allowDownload: false,
    });
  });

  it('shows options for a video and nothing for anything else', () => {
    expect(isVideoFilename('lecture.mp4')).toBe(true);
    expect(isVideoFilename('syllabus.pdf')).toBe(false);
    expect(isVideoFilename('podcast.mp3')).toBe(false);
  });

  it('forces the original to be kept the moment optimising is turned off', () => {
    const dropped = applyVideoOption(DEFAULT_VIDEO_OPTIONS, 'keepOriginal', false);
    expect(dropped.keepOriginal).toBe(false);

    const unoptimised = applyVideoOption(dropped, 'optimise', false);
    expect(unoptimised.keepOriginal).toBe(true);
    expect(canDropOriginal(unoptimised)).toBe(false);
  });

  it('lets the original be dropped again once optimising is back on', () => {
    const unoptimised = applyVideoOption(DEFAULT_VIDEO_OPTIONS, 'optimise', false);
    const reoptimised = applyVideoOption(unoptimised, 'optimise', true);

    expect(canDropOriginal(reoptimised)).toBe(true);
    expect(applyVideoOption(reoptimised, 'keepOriginal', false).keepOriginal).toBe(false);
  });

  it('leaves the download choice alone whichever way the other two go', () => {
    const allowed = applyVideoOption(DEFAULT_VIDEO_OPTIONS, 'allowDownload', true);
    expect(applyVideoOption(allowed, 'optimise', false).allowDownload).toBe(true);
  });

  it('warns about a .mov only while optimising is off', () => {
    const off = applyVideoOption(DEFAULT_VIDEO_OPTIONS, 'optimise', false);
    expect(warnsWithoutOptimising('screen.mov', off)).toBe(true);
    expect(warnsWithoutOptimising('screen.mov', DEFAULT_VIDEO_OPTIONS)).toBe(false);
    expect(warnsWithoutOptimising('lecture.mp4', off)).toBe(false);
  });
});

describe('pre-checks', () => {
  it('passes a file that fits', () => {
    expect(precheck({ name: 'lecture.mp4', size: 500 * 1024 * 1024 }, quota)).toBeNull();
  });

  it('passes any file with an extension', () => {
    for (const name of ['notebook.ipynb', 'data.csv', 'tool.exe', 'page.html']) {
      expect(precheck({ name, size: 10 }, quota), name).toBeNull();
    }
  });

  it('names a missing or too-long extension first, because freeing space would not help', () => {
    expect(precheck({ name: 'Makefile', size: 3 * GiB }, quota)).toContain('needs an extension');

    const tooLong = precheck({ name: 'export.longextension', size: 10 }, quota);
    expect(tooLong).toContain(`at most ${MAX_MEDIA_EXTENSION_LENGTH}`);
    expect(tooLong).toContain('.longextension is 13');
    expect(precheck({ name: 'a.abcdefgh', size: 10 }, quota)).toBeNull();
  });

  it('quotes the per-file ceiling', () => {
    const message = precheck({ name: 'huge.mp4', size: 3 * GiB }, quota);
    expect(message).toContain('3.0 GB');
    expect(message).toContain('2.0 GB');
  });

  it('quotes what is actually free, not the whole quota', () => {
    const nearlyFull = { ...quota, usedBytes: 9.5 * GiB };
    const message = precheck({ name: 'lecture.mp4', size: GiB }, nearlyFull);
    expect(message).toContain('512 MB');
    expect(message).toContain('10 GB');
  });

  it('refuses everything once the quota is zero, which is where a free classroom sits', () => {
    const free = { usedBytes: 0, quotaBytes: 0, perFileBytes: 2 * GiB };
    expect(precheck({ name: 'lecture.mp4', size: 1 }, free)).toContain('0 bytes');
  });
});

describe('formatBytes', () => {
  it.each([
    [0, '0 bytes'],
    [999, '999 bytes'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [35 * 1024 * 1024, '35 MB'],
    [2 * GiB, '2.0 GB'],
  ])('renders %i as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});
