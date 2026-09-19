/**
 * The slide SOURCE policy, on its own.
 *
 * Everything here is what a teacher is allowed to hand the product, so every
 * test below is really one of two questions: does a legitimate upload get
 * through, and does a name or a URL that has no business in a git path, a
 * response header or a redirect get refused BEFORE anything is committed.
 *
 * Pure — no database, no GitHub, no signing. That is the point of the module.
 */

import { describe, it, expect } from 'vitest';

import {
  SLIDE_FILE_MAX_BYTES,
  assertDeckSlide,
  assertFileSlide,
  isDeckSlide,
  slideFileExtension,
  slideFileSourceProblem,
  slideFileStorageName,
  slideKindLabel,
  slideLinkHost,
  validateSlideFile,
  validateSlideLinkUrl,
  SlideKindError,
} from '../slideSource.ts';

describe('slideFileExtension', () => {
  it('takes the four allowed types, in any case', () => {
    expect(slideFileExtension('Lecture.PDF')).toBe('pdf');
    expect(slideFileExtension('deck.pptx')).toBe('pptx');
    expect(slideFileExtension('old.ppt')).toBe('ppt');
    expect(slideFileExtension('mac.key')).toBe('key');
  });

  it('refuses everything else, including the ones that look close', () => {
    // `.html` and `.json` are the deck engine's own artifacts; `.zip` is a
    // Keynote export nobody's browser will open.
    for (const name of ['notes.html', 'deck.json', 'export.zip', 'image.png', 'noextension']) {
      expect(slideFileExtension(name)).toBeNull();
    }
  });

  it('reads the extension off the BASENAME, not the path', () => {
    // A browser on Windows sends the whole path in some cases, and a `.pdf`
    // folder with an extensionless file inside is not a PDF.
    expect(slideFileExtension('C:\\decks\\week1.pdf')).toBe('pdf');
    expect(slideFileExtension('archive.pdf/readme')).toBeNull();
  });
});

describe('validateSlideFile', () => {
  it('accepts a real upload and names its MIME type', () => {
    expect(validateSlideFile({ filename: 'Lecture 1.pdf', size: 4_000_000 })).toEqual({
      valid: true,
      extension: 'pdf',
      mime: 'application/pdf',
    });
  });

  it('refuses an empty file and one over the cap', () => {
    expect(validateSlideFile({ filename: 'a.pdf', size: 0 })).toMatchObject({ valid: false });
    expect(validateSlideFile({ filename: 'a.pdf', size: SLIDE_FILE_MAX_BYTES + 1 })).toMatchObject({
      valid: false,
    });
    // Exactly at the cap is allowed — the limit is a maximum, not a ceiling.
    expect(validateSlideFile({ filename: 'a.pdf', size: SLIDE_FILE_MAX_BYTES })).toMatchObject({
      valid: true,
    });
  });

  it('is not the shared 5 MB image policy', () => {
    // The whole reason this module exists: a 40 MB lecture PDF is a normal
    // upload here and would be refused by `validateFile.ts`.
    expect(validateSlideFile({ filename: 'lecture.pdf', size: 40 * 1024 * 1024 })).toMatchObject({
      valid: true,
    });
  });
});

describe('slideFileStorageName', () => {
  it('sanitizes to lowercase ASCII and keeps the extension', () => {
    expect(slideFileStorageName('Lecture 1 — Intro.pdf', 'week-1')).toBe('lecture-1-intro.pdf');
  });

  it('falls back to the slug when nothing ASCII survives', () => {
    expect(slideFileStorageName('講義.pdf', 'week-1')).toBe('week-1.pdf');
  });

  it('never produces a path segment that could shadow the deck engine', () => {
    // Not reachable today (none of the four extensions spells one of these),
    // which is exactly why the check has to be here rather than remembered.
    expect(slideFileStorageName('../../etc/passwd.pdf', 'week-1')).toBe('passwd.pdf');
    expect(slideFileStorageName('a/b/c.pdf', 'week-1')).toBe('c.pdf');
  });

  it('refuses a name it cannot type at all', () => {
    expect(slideFileStorageName('notes.txt', 'week-1')).toBeNull();
  });
});

describe('validateSlideLinkUrl', () => {
  it('takes an absolute https URL and normalizes it', () => {
    expect(validateSlideLinkUrl('  https://Example.COM/Slides?a=1  ')).toEqual({
      ok: true,
      url: 'https://example.com/Slides?a=1',
      host: 'example.com',
    });
  });

  it('punycodes a unicode host, so what is stored is what is shown', () => {
    const result = validateSlideLinkUrl('https://аpple.com/deck');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.host.startsWith('xn--')).toBe(true);
      expect(result.url).toContain('xn--');
    }
  });

  it('refuses anything that is not plain https', () => {
    for (const raw of [
      '',
      '   ',
      'example.com/deck',
      'http://example.com/deck',
      'javascript:alert(1)',
      'data:text/html,<h1>hi</h1>',
      'file:///etc/passwd',
      '//example.com/deck',
    ]) {
      expect(validateSlideLinkUrl(raw).ok).toBe(false);
    }
  });

  it('refuses credentials in the authority', () => {
    // `https://good.example.com@evil.test/` reads as good.example.com to a
    // student and resolves to evil.test.
    expect(validateSlideLinkUrl('https://user:pass@example.com/').ok).toBe(false);
    expect(validateSlideLinkUrl('https://good.example.com@evil.test/').ok).toBe(false);
  });

  it('refuses control characters rather than letting URL strip them', () => {
    // `new URL` silently drops tab/CR/LF. A stored link must be the one that
    // was typed, or nothing.
    expect(validateSlideLinkUrl('https://exa\tmple.com/deck').ok).toBe(false);
    expect(validateSlideLinkUrl('https://example.com/a\nb').ok).toBe(false);
  });

  it('refuses a link past the length cap', () => {
    expect(validateSlideLinkUrl(`https://example.com/${'a'.repeat(3000)}`).ok).toBe(false);
  });

  it('refuses a host that is not a host', () => {
    // `URL` takes any non-empty authority, so all of these parse — and none of
    // them resolve anywhere. Stored, each is a slide that looks fine in the
    // list and dead-ends the first student who clicks it.
    for (const raw of [
      'https://.',
      'https://./deck',
      'https://..',
      'https://a..b/deck',
      'https://.example.com/deck',
    ]) {
      expect(validateSlideLinkUrl(raw).ok).toBe(false);
    }
  });

  it('strips one trailing dot rather than storing a second spelling of a host', () => {
    // `example.com.` is the legal absolute-root form of `example.com`, not a
    // different site — keeping both would put two chips and two stored links on
    // one destination.
    expect(validateSlideLinkUrl('https://Example.com./deck')).toEqual({
      ok: true,
      url: 'https://example.com/deck',
      host: 'example.com',
    });
  });

  it('still takes an IP literal, which is deliberate', () => {
    // Nothing here ever FETCHES the destination — the browser is redirected to
    // it — so a private address is a link that will not load, not an SSRF.
    expect(validateSlideLinkUrl('https://10.0.0.5/deck').ok).toBe(true);
    expect(validateSlideLinkUrl('https://[::1]/deck').ok).toBe(true);
    expect(validateSlideLinkUrl('https://localhost/deck').ok).toBe(true);
  });
});

/**
 * The read-time guard on a stored FILE row.
 *
 * No write path in this codebase can produce a row that fails here — the
 * storage name is sanitized ASCII and the cap is enforced before a byte is
 * committed. It is checked anyway because the write and the read are separated
 * by a database, and on the read side `source_path` is what gets signed into a
 * public URL and handed to the git blobs API.
 */
describe('slideFileSourceProblem', () => {
  const slide = {
    content_path: 'slides/lecture-1',
    source_path: 'slides/lecture-1/lecture-1.pdf',
    source_size: 2048,
  };

  it('passes the row every upload path writes', () => {
    expect(slideFileSourceProblem(slide)).toBeNull();
    // Nested under the folder is still under the folder.
    expect(
      slideFileSourceProblem({ ...slide, source_path: 'slides/lecture-1/a/b.pdf' })
    ).toBeNull();
    // Size is optional — a legacy row with none is not a row to refuse.
    expect(slideFileSourceProblem({ ...slide, source_size: null })).toBeNull();
    expect(slideFileSourceProblem({ ...slide, source_size: SLIDE_FILE_MAX_BYTES })).toBeNull();
  });

  it('names a row with no document at all', () => {
    expect(slideFileSourceProblem({ ...slide, source_path: null })).toBe('no_source');
    expect(slideFileSourceProblem({ ...slide, source_path: '' })).toBe('no_source');
  });

  it('refuses anything that is not strictly inside the slide’s own folder', () => {
    for (const source_path of [
      'slides/other/lecture.pdf',
      'slides/lecture-1/../../.env',
      'slides/lecture-1/./a.pdf',
      'slides/lecture-10/a.pdf', // prefix of the folder name, not the folder
      'slides/lecture-1', // the folder itself
      'slides/lecture-1/',
      '.env',
    ]) {
      expect(slideFileSourceProblem({ ...slide, source_path })).toBe('escapes_folder');
    }
    // A row with no folder to check against cannot be checked, so it fails.
    expect(slideFileSourceProblem({ ...slide, content_path: null })).toBe('escapes_folder');
  });

  it('refuses a row claiming more bytes than an upload may carry', () => {
    expect(slideFileSourceProblem({ ...slide, source_size: SLIDE_FILE_MAX_BYTES + 1 })).toBe(
      'too_large'
    );
  });
});

describe('slideLinkHost', () => {
  it('reads a host back out, and shrugs at anything else', () => {
    expect(slideLinkHost('https://example.com/deck')).toBe('example.com');
    expect(slideLinkHost('not a url')).toBeNull();
    expect(slideLinkHost(null)).toBeNull();
  });
});

describe('slideKindLabel', () => {
  it('labels a slide by what it actually is', () => {
    expect(slideKindLabel({ kind: 'DECK' })).toBe('deck');
    expect(slideKindLabel({ kind: 'LINK' })).toBe('link');
    expect(slideKindLabel({ kind: 'FILE', source_filename: 'Lecture.PDF' })).toBe('pdf');
    expect(slideKindLabel({ kind: 'FILE', source_path: 'slides/a/deck.pptx' })).toBe('pptx');
    // A FILE row with nothing usable still gets a word rather than an empty chip.
    expect(slideKindLabel({ kind: 'FILE' })).toBe('file');
    // An older caller with no kind at all is looking at a deck.
    expect(slideKindLabel({})).toBe('deck');
  });
});

describe('the kind guards', () => {
  it('treats an absent kind as DECK, because the synthetic targets are decks', () => {
    expect(isDeckSlide({})).toBe(true);
    expect(isDeckSlide({ kind: 'DECK' })).toBe(true);
    expect(isDeckSlide({ kind: 'FILE' })).toBe(false);
    expect(() => assertDeckSlide({}, 'Saving')).not.toThrow();
  });

  it('refuses the mismatch with a 409 a route can map', () => {
    try {
      assertDeckSlide({ kind: 'LINK' }, 'Saving deck content');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SlideKindError);
      expect((error as SlideKindError).status).toBe(409);
      expect((error as SlideKindError).code).toBe('SLIDE_KIND_MISMATCH');
    }
    expect(() => assertFileSlide({ kind: 'DECK' }, 'Replacing')).toThrow(SlideKindError);
  });
});
