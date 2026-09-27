/**
 * The rules behind the upload dialog's options and pre-checks.
 *
 * The three video choices and their coupling are tested where they live, in
 * `@classmoji/ui-components/media-options`. What is here is which files get
 * them, what an upload from this dialog asks the server for, and the checks
 * made before any bytes move.
 */

import { describe, expect, it } from 'vitest';
import {
  createUploadOptions,
  MAX_MEDIA_EXTENSION_LENGTH,
  extensionOf,
  formatBytes,
  isVideoFilename,
  kindForFilename,
  precheck,
  type QuotaSummary,
} from '../mediaUploadOptions';
import { DEFAULT_VIDEO_OPTIONS } from '@classmoji/ui-components/media-options';

const GiB = 1024 ** 3;
const quota: QuotaSummary = { usedBytes: 0, quotaBytes: 10 * GiB, perFileBytes: 2 * GiB };

describe('kinds', () => {
  it.each([
    ['lecture.mp4', 'video'],
    ['screen.MOV', 'video'],
    ['clip.m4v', 'video'],
    ['clip.webm', 'video'],
    ['recording.mkv', 'video'],
    ['old-lecture.AVI', 'video'],
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

describe('which files get the video options', () => {
  it('shows options for a video and nothing for anything else', () => {
    expect(isVideoFilename('lecture.mp4')).toBe(true);
    expect(isVideoFilename('syllabus.pdf')).toBe(false);
    expect(isVideoFilename('podcast.mp3')).toBe(false);
  });

  it('reads video by the storage router, so mkv and avi get the options too', () => {
    // One list: the router's. A container the server processes as video but
    // this dialog did not know would upload with no options at all.
    expect(isVideoFilename('capture.mkv')).toBe(true);
    expect(isVideoFilename('capture.avi')).toBe(true);
  });
});

describe('createUploadOptions', () => {
  it('marks every upload from this dialog explicit, video options only for a video', () => {
    expect(createUploadOptions('lecture.mp4', DEFAULT_VIDEO_OPTIONS)).toEqual({
      ...DEFAULT_VIDEO_OPTIONS,
      explicit: true,
    });
    expect(createUploadOptions('notes.pdf', DEFAULT_VIDEO_OPTIONS)).toEqual({ explicit: true });
    expect(createUploadOptions('data.csv', DEFAULT_VIDEO_OPTIONS)).toEqual({ explicit: true });
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
