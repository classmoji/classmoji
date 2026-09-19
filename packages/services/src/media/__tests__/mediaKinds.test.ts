/**
 * The upload allowlist.
 *
 * What matters here is not that `mp4` is on the list — it is that the list is
 * the ONLY way a file gets a content type. The Worker serves whatever type the
 * object carries, so a filename that talks its way into a type it should not
 * have is served as that type from a classmoji.io origin.
 */

import { describe, expect, it } from 'vitest';

import {
  allowedExtensions,
  classifyFilename,
  contentTypeForExt,
  extensionOf,
  kindForExt,
} from '../mediaKinds.ts';

describe('extensionOf', () => {
  it('takes the last extension, lowercased', () => {
    expect(extensionOf('Lecture 1.MP4')).toBe('mp4');
    expect(extensionOf('archive.tar.gz')).toBe('gz');
    expect(extensionOf('a/b/c/slides.pdf')).toBe('pdf');
  });

  it('has no extension for a dotfile, a bare name or a trailing dot', () => {
    expect(extensionOf('.gitignore')).toBeNull();
    expect(extensionOf('README')).toBeNull();
    expect(extensionOf('weird.')).toBeNull();
    expect(extensionOf('')).toBeNull();
  });
});

describe('the allowlist', () => {
  it('maps each accepted extension to a kind and a type', () => {
    expect(kindForExt('mp4')).toBe('VIDEO');
    expect(kindForExt('m4a')).toBe('AUDIO');
    expect(kindForExt('pptx')).toBe('DOCUMENT');
    expect(kindForExt('zip')).toBe('ARCHIVE');
    expect(kindForExt('png')).toBe('IMAGE');

    expect(contentTypeForExt('mov')).toBe('video/quicktime');
    expect(contentTypeForExt('jpg')).toBe('image/jpeg');
    expect(contentTypeForExt('jpeg')).toBe('image/jpeg');
  });

  it('refuses anything a browser could be talked into executing', () => {
    for (const ext of ['html', 'htm', 'svg', 'js', 'mjs', 'xml', 'exe', 'sh']) {
      expect(kindForExt(ext)).toBeNull();
      expect(contentTypeForExt(ext)).toBeNull();
    }
  });

  it('is case-insensitive on the way in', () => {
    expect(kindForExt('MP4')).toBe('VIDEO');
    expect(contentTypeForExt('PDF')).toBe('application/pdf');
  });

  it('never answers with a type the caller supplied', () => {
    // The point of the whole module: the classification comes from the
    // extension and only the extension. A filename claiming otherwise, and a
    // browser-supplied `file.type`, have no way in.
    expect(classifyFilename('payload.html')).toBeNull();
    expect(classifyFilename('payload.mp4.html')).toBeNull();
    expect(classifyFilename('payload.html.mp4')).toEqual({
      ext: 'mp4',
      kind: 'VIDEO',
      contentType: 'video/mp4',
    });
  });
});

describe('classifyFilename', () => {
  it('answers with everything a create needs, or nothing at all', () => {
    expect(classifyFilename('Lecture 1 — Intro.pdf')).toEqual({
      ext: 'pdf',
      kind: 'DOCUMENT',
      contentType: 'application/pdf',
    });
    expect(classifyFilename('no-extension')).toBeNull();
  });
});

describe('allowedExtensions', () => {
  it('lists every accepted extension once', () => {
    const list = allowedExtensions();
    expect(new Set(list).size).toBe(list.length);
    expect(list).toContain('mp4');
    expect(list).toContain('zip');
    expect(list).not.toContain('svg');
  });
});
