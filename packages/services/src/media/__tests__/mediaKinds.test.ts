/**
 * What the media store accepts, and what it serves each file as.
 *
 * Any extension is accepted; what matters here is the TYPE. Only an extension
 * the store knows gets a real content type, and everything else is an opaque
 * download — so an `.html` or `.svg` is never served as a page from a
 * classmoji.io origin, whatever the uploader called it or declared it as.
 */

import { describe, expect, it } from 'vitest';

import {
  classifyFilename,
  contentTypeForExt,
  extensionOf,
  extensionsOfKind,
  filenameRefusal,
  kindForExt,
  knownExtensions,
  MEDIA_KINDS,
} from '../mediaKinds.ts';

describe('extensionOf', () => {
  it('takes the last extension, lowercased', () => {
    expect(extensionOf('Lecture 1.MP4')).toBe('mp4');
    expect(extensionOf('archive.tar.gz')).toBe('gz');
    expect(extensionOf('a/b/c/slides.pdf')).toBe('pdf');
    expect(extensionOf('dir.v2/notes')).toBeNull();
  });

  it('has no extension for a dotfile, a bare name or a trailing dot', () => {
    expect(extensionOf('.gitignore')).toBeNull();
    expect(extensionOf('README')).toBeNull();
    expect(extensionOf('weird.')).toBeNull();
    expect(extensionOf('')).toBeNull();
  });

  it('keeps only letters and digits, like the repository does', () => {
    expect(extensionOf('data.tar-gz')).toBe('targz');
    expect(extensionOf('x.データ')).toBeNull();
  });
});

describe('kinds and types', () => {
  it('maps each known extension to a kind and a type', () => {
    expect(kindForExt('mp4')).toBe('VIDEO');
    expect(kindForExt('m4a')).toBe('AUDIO');
    expect(kindForExt('pptx')).toBe('DOCUMENT');
    expect(kindForExt('zip')).toBe('ARCHIVE');
    expect(kindForExt('png')).toBe('IMAGE');

    expect(contentTypeForExt('mov')).toBe('video/quicktime');
    expect(contentTypeForExt('jpg')).toBe('image/jpeg');
    expect(contentTypeForExt('jpeg')).toBe('image/jpeg');
  });

  it('takes Matroska and AVI as video, with their registered types', () => {
    // Screen recorders (OBS defaults to .mkv) and older lecture captures (.avi)
    // produce these; as VIDEO the router sends them to media on Pro rather than
    // refusing or committing them to git.
    expect(kindForExt('mkv')).toBe('VIDEO');
    expect(kindForExt('AVI')).toBe('VIDEO');
    expect(contentTypeForExt('mkv')).toBe('video/x-matroska');
    expect(contentTypeForExt('avi')).toBe('video/x-msvideo');
  });

  it('takes Ogg video as video, and Ogg, AAC and FLAC as audio', () => {
    // `.ogg` is audio by convention (Vorbis/Opus); Ogg video is `.ogv`. As
    // named kinds they are served with their real types, so a browser plays
    // them rather than saving them.
    expect(kindForExt('ogv')).toBe('VIDEO');
    for (const ext of ['ogg', 'oga', 'aac', 'flac']) expect(kindForExt(ext), ext).toBe('AUDIO');
    expect(contentTypeForExt('ogv')).toBe('video/ogg');
    expect(contentTypeForExt('ogg')).toBe('audio/ogg');
    expect(contentTypeForExt('oga')).toBe('audio/ogg');
    expect(contentTypeForExt('aac')).toBe('audio/aac');
    expect(contentTypeForExt('flac')).toBe('audio/flac');
  });

  it('serves anything a browser could be talked into running as a download', () => {
    for (const ext of ['html', 'htm', 'svg', 'js', 'mjs', 'xml', 'exe', 'sh']) {
      expect(kindForExt(ext)).toBe('OTHER');
      expect(contentTypeForExt(ext)).toBe('application/octet-stream');
    }
  });

  it('is case-insensitive on the way in', () => {
    expect(kindForExt('MP4')).toBe('VIDEO');
    expect(contentTypeForExt('PDF')).toBe('application/pdf');
  });

  it('never answers with a type the caller supplied', () => {
    // The classification comes from the extension and only the extension. A
    // filename claiming otherwise, and a browser-supplied `file.type`, have no
    // way in.
    expect(classifyFilename('payload.html')).toEqual({
      ext: 'html',
      kind: 'OTHER',
      contentType: 'application/octet-stream',
    });
    expect(classifyFilename('payload.mp4.html')).toMatchObject({ kind: 'OTHER' });
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
    expect(classifyFilename('Week 3.ipynb')).toEqual({
      ext: 'ipynb',
      kind: 'OTHER',
      contentType: 'application/octet-stream',
    });
    expect(classifyFilename('no-extension')).toBeNull();
  });

  it('refuses an extension longer than the orig.{ext} variant can carry', () => {
    // The repository keeps up to 16 characters; the variant grammar the
    // signer and the Worker share allows 8.
    expect(classifyFilename('a.abcdefgh')).toMatchObject({ ext: 'abcdefgh' });
    expect(classifyFilename('a.abcdefghi')).toBeNull();
  });
});

describe('filenameRefusal', () => {
  it('says which of the two shapes it was', () => {
    expect(filenameRefusal('Makefile')).toContain('needs an extension');
    expect(filenameRefusal('a.abcdefghi')).toContain('at most 8');
    expect(filenameRefusal('a.pdf')).toBeNull();
  });

  it("reports an over-long extension's real length, not the capped one", () => {
    expect(filenameRefusal('dir.v2/a.abcdefghijklmnopqrst')).toBe(
      'File extensions can be at most 8 letters or digits (.abcdefghijklmnop… is 20).'
    );
  });
});

describe('knownExtensions', () => {
  it('lists every typed extension once', () => {
    const list = knownExtensions();
    expect(new Set(list).size).toBe(list.length);
    expect(list).toContain('mp4');
    expect(list).toContain('zip');
    expect(list).not.toContain('svg');
  });
});

describe('extensionsOfKind', () => {
  it('is the kind table itself, for a picker to offer', () => {
    expect(extensionsOfKind('VIDEO')).toEqual(MEDIA_KINDS.find(k => k.kind === 'VIDEO')?.exts);
    expect(extensionsOfKind('AUDIO')).toContain('flac');
    expect(extensionsOfKind('OTHER')).toEqual([]);
  });

  it('hands back a copy the caller cannot use to edit the table', () => {
    extensionsOfKind('VIDEO').push('exe');
    expect(kindForExt('exe')).toBe('OTHER');
    expect(extensionsOfKind('VIDEO')).not.toContain('exe');
  });
});
