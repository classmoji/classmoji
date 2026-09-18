import { describe, expect, it } from 'vitest';

import { toBase64Url, utf8 } from '../canonical.ts';
import {
  MAX_DOWNLOAD_FILENAME_BYTES,
  MAX_ENCODED_DOWNLOAD_FILENAME,
  contentDispositionFor,
  decodeDownloadFilename,
  encodeDownloadFilename,
  normalizeDownloadFilename,
} from '../downloads.ts';

/** base64url of an arbitrary string — what a forger would put in `dl`. */
const rawEncode = (value: string) => toBase64Url(utf8(value));

const byteLength = (value: string) => utf8(value).byteLength;

describe('normalizeDownloadFilename', () => {
  it('passes an ordinary filename through untouched', () => {
    for (const name of [
      'deck.pdf',
      'Week 3 — Recursion.pptx',
      'lecture_01.key',
      'a.pdf',
      'Übung 1.pdf',
      '课程安排.pdf',
      'notes (final).ppt',
      "prof's slides.pdf",
    ]) {
      expect(normalizeDownloadFilename(name)).toBe(name);
    }
  });

  it('keeps only the basename, on either separator', () => {
    expect(normalizeDownloadFilename('talks/week3/deck.pdf')).toBe('deck.pdf');
    expect(normalizeDownloadFilename('C:\\Users\\ada\\deck.pdf')).toBe('deck.pdf');
    // A browser that sends a directory and nothing else has named no file.
    expect(normalizeDownloadFilename('talks/')).toBeNull();
    expect(normalizeDownloadFilename('/')).toBeNull();
  });

  it('normalizes to NFC, so one visible name is one set of bytes', () => {
    // macOS hands over NFD: 'U' + combining diaeresis. Without this the decoder's
    // round-trip check would refuse a name we ourselves accepted at upload.
    const decomposed = 'U\u0308bung.pdf';
    const composed = '\u00dcbung.pdf';
    expect(decomposed).not.toBe(composed);
    expect(normalizeDownloadFilename(decomposed)).toBe(composed);
  });

  it('refuses control characters — a newline would be a second HTTP header', () => {
    for (const name of [
      'deck\n.pdf',
      'deck\r\n.pdf',
      'deck\u0000.pdf',
      'deck\u001f.pdf',
      'deck\u007f.pdf',
      'a\nContent-Disposition: attachment; filename="evil.exe"',
    ]) {
      expect(normalizeDownloadFilename(name)).toBeNull();
    }
  });

  it('refuses bidi controls that make an extension read backwards', () => {
    // U+202E turns 'harmless\u202Efdp.exe' into 'harmlessexe.pdf' on screen.
    for (const name of ['harmless\u202efdp.exe', 'a\u202adeck.pdf', 'a\u2066b\u2069.pdf']) {
      expect(normalizeDownloadFilename(name)).toBeNull();
    }
  });

  it('refuses the other invisible format characters', () => {
    // General category Cf, plus the two separators that are line breaks under
    // another name. All of them let two different names render identically:
    // `deck\u200b.pdf` is indistinguishable from `deck.pdf` in a save dialog.
    for (const name of [
      'deck\u200b.pdf', // zero width space
      'deck\u200c.pdf', // zero width non-joiner
      'deck\u200e.pdf', // left-to-right mark
      'deck\u200f.pdf', // right-to-left mark
      'deck\u061c.pdf', // arabic letter mark
      'deck\ufeff.pdf', // BOM / zero width no-break space
      'deck\u00ad.pdf', // soft hyphen
      'deck\u180e.pdf', // mongolian vowel separator
      'deck\u2060.pdf', // word joiner
      'deck\u2064.pdf', // invisible plus
      'deck\u2028.pdf', // line separator
      'deck\u2029.pdf', // paragraph separator
    ]) {
      expect(normalizeDownloadFilename(name)).toBeNull();
    }
  });

  it('allows ZWJ, because it is what holds an emoji together', () => {
    // U+200D is Cf like the rest, and is exempt on purpose: refusing it would
    // reject `👩‍🏫 syllabus.pdf`, a name an instructor legitimately typed. It
    // joins adjacent glyphs rather than reordering or hiding them. Variation
    // selectors are Mn rather than Cf, so they were never in question.
    for (const name of [
      '\u{1F469}\u200D\u{1F3EB} syllabus.pdf',
      '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}.png',
      '❤️ deck.pdf',
    ]) {
      expect(normalizeDownloadFilename(name)).toBe(name);
      // Idempotent, which is what the decoder's round-trip check rests on.
      expect(decodeDownloadFilename(encodeDownloadFilename(name))).toBe(name);
    }
  });

  it('refuses edge whitespace and dots rather than trimming them', () => {
    for (const name of [
      ' deck.pdf',
      'deck.pdf ',
      '\tdeck.pdf',
      '.bashrc',
      '.',
      '..',
      'deck.',
      '...pdf.',
      '',
    ]) {
      expect(normalizeDownloadFilename(name)).toBeNull();
    }
  });

  it('is not fooled by a non-string', () => {
    for (const value of [undefined, null, 42, {}, ['deck.pdf']]) {
      // @ts-expect-error - exercising the runtime guard
      expect(normalizeDownloadFilename(value)).toBeNull();
    }
  });

  it('truncates the base and never the extension', () => {
    const long = `${'a'.repeat(400)}.pdf`;
    const result = normalizeDownloadFilename(long);
    expect(result).not.toBeNull();
    expect(byteLength(result as string)).toBe(MAX_DOWNLOAD_FILENAME_BYTES);
    // The suffix is what tells the browser how to open the file: it survives whole.
    expect(result?.endsWith('.pdf')).toBe(true);
    expect(result).toBe(`${'a'.repeat(196)}.pdf`);
  });

  it('counts bytes, not characters, and cuts on a code point boundary', () => {
    // 3 bytes each: 65 of them plus '.pdf' is 199, and a 66th would be 202.
    const cjk = normalizeDownloadFilename(`${'课'.repeat(200)}.pdf`);
    expect(cjk).toBe(`${'课'.repeat(65)}.pdf`);
    expect(byteLength(cjk as string)).toBeLessThanOrEqual(MAX_DOWNLOAD_FILENAME_BYTES);

    // 4 bytes each, so a naive byte slice would cut a surrogate pair in half and
    // leave a string that cannot survive a UTF-8 round trip.
    const emoji = normalizeDownloadFilename(`${'🎓'.repeat(100)}.pdf`);
    expect(emoji).toBe(`${'🎓'.repeat(49)}.pdf`);
    expect(emoji).toBe(emoji?.normalize('NFC'));
  });

  it('truncates a name that has no extension at all', () => {
    const result = normalizeDownloadFilename('b'.repeat(400));
    expect(result).toBe('b'.repeat(MAX_DOWNLOAD_FILENAME_BYTES));
  });

  it('refuses a name whose "extension" would eat the whole budget', () => {
    expect(normalizeDownloadFilename(`a.${'b'.repeat(400)}`)).toBeNull();
  });

  it('tidies a cut that lands on a space or a dot', () => {
    // The space was interior in the input and ends up on the edge after the
    // cut, which is the one thing the edge check refuses. It is trimmed rather
    // than costing the whole name.
    expect(normalizeDownloadFilename(`${'a'.repeat(199)} ${'b'.repeat(50)}`)).toBe('a'.repeat(199));
    expect(normalizeDownloadFilename(`${'a'.repeat(199)}..${'b'.repeat(50)}.pptx`)).toBe(
      `${'a'.repeat(195)}.pptx`
    );
  });

  it('never returns a name over the byte cap, whatever the input', () => {
    for (const name of [
      `${'a'.repeat(400)}.pdf`,
      `${'课'.repeat(400)}.pptx`,
      `${'🎓'.repeat(400)}.key`,
      'z'.repeat(400),
      `${'a'.repeat(199)} ${'b'.repeat(50)}`,
    ]) {
      const result = normalizeDownloadFilename(name);
      expect(result).not.toBeNull();
      expect(byteLength(result as string)).toBeLessThanOrEqual(MAX_DOWNLOAD_FILENAME_BYTES);
      // Idempotent, which is what makes the decoder's round-trip check stable.
      expect(normalizeDownloadFilename(result as string)).toBe(result);
    }
  });
});

describe('encodeDownloadFilename / decodeDownloadFilename', () => {
  it('round-trips every name the normalizer accepts', () => {
    for (const name of [
      'deck.pdf',
      'Übung 1.pdf',
      '课程安排.pdf',
      'Week 3 — Recursion.pptx',
      '🎓 graduation.key',
      'a\'b"c.pdf',
    ]) {
      const encoded = encodeDownloadFilename(name);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(encoded.length).toBeLessThanOrEqual(MAX_ENCODED_DOWNLOAD_FILENAME);
      expect(decodeDownloadFilename(encoded)).toBe(name);
    }
  });

  it('refuses to encode anything the normalizer would have changed', () => {
    // Otherwise a URL could be signed carrying a name the verifier then refuses
    // to hand back — a signature that verifies and a download that 403s.
    for (const name of ['talks/deck.pdf', ' deck.pdf', '.bashrc', 'deck\n.pdf', '']) {
      expect(() => encodeDownloadFilename(name)).toThrow(TypeError);
    }
  });

  it('refuses a decoded name that is not exactly what normalize returns', () => {
    // The round-trip check is the real guard: these all carry a *valid*
    // signature in the tamper tests, and are still refused.
    for (const forged of [
      'talks/deck.pdf',
      '../../etc/passwd',
      ' deck.pdf',
      'deck.pdf ',
      '.bashrc',
      'deck\n.pdf',
      'harmless\u202efdp.exe',
      'deck\u200b.pdf',
      'deck\ufeff.pdf',
      'U\u0308bung.pdf',
      `${'a'.repeat(400)}.pdf`,
    ]) {
      expect(decodeDownloadFilename(rawEncode(forged))).toBeNull();
    }
  });

  it('refuses malformed base64url, invalid UTF-8, and anything unbounded', () => {
    expect(decodeDownloadFilename('')).toBeNull();
    expect(decodeDownloadFilename('not base64!')).toBeNull();
    expect(decodeDownloadFilename('a'.repeat(MAX_ENCODED_DOWNLOAD_FILENAME + 1))).toBeNull();
    // A lone 0xFF is not UTF-8; `fatal: true` is what makes it an error rather
    // than a run of U+FFFD that would then fail the round-trip check anyway.
    expect(decodeDownloadFilename(toBase64Url(new Uint8Array([0xff, 0xfe])))).toBeNull();
    // A truncated multi-byte sequence: the first two bytes of a three-byte char.
    expect(decodeDownloadFilename(toBase64Url(new Uint8Array([0xe8, 0xaf])))).toBeNull();
    // @ts-expect-error - exercising the runtime guard
    expect(decodeDownloadFilename(undefined)).toBeNull();
  });

  it('stays inside the encoded ceiling for the longest name there is', () => {
    const longest = normalizeDownloadFilename(`${'课'.repeat(200)}.pdf`) as string;
    expect(encodeDownloadFilename(longest).length).toBeLessThanOrEqual(
      MAX_ENCODED_DOWNLOAD_FILENAME
    );
  });
});

describe('contentDispositionFor', () => {
  it('emits both forms, ASCII first', () => {
    expect(contentDispositionFor('deck.pdf')).toBe(
      `attachment; filename="deck.pdf"; filename*=UTF-8''deck.pdf`
    );
  });

  it('percent-encodes the UTF-8 form and degrades the ASCII one', () => {
    // Every client reads the quoted fallback; every client that understands
    // RFC 8187 prefers `filename*`, which is what delivers the real name.
    expect(contentDispositionFor('Übung 1.pdf')).toBe(
      `attachment; filename="_bung 1.pdf"; filename*=UTF-8''%C3%9Cbung%201.pdf`
    );
  });

  it('percent-encodes everything outside the attr-char set', () => {
    // `encodeURIComponent` would leave `'` alone — and `'` is the delimiter of
    // the `UTF-8''value` form itself.
    const header = contentDispositionFor("a'b(c)d*e.pdf");
    expect(header).toContain(`filename*=UTF-8''a%27b%28c%29d%2Ae.pdf`);
  });

  it('keeps the attr-chars RFC 8187 allows unescaped', () => {
    expect(contentDispositionFor('a!#$&+-.^_`|~z.pdf')).toContain(
      `filename*=UTF-8''a!#$&+-.^_\`|~z.pdf`
    );
  });

  it('collapses a literal percent in the quoted fallback', () => {
    // RFC 6266 App. D: some clients percent-decode the quoted form, so a
    // literal `a%2Fb.pdf` left intact there would be saved as the path
    // `a/b.pdf`. `filename*` still carries the real name, `%` and all.
    expect(contentDispositionFor('a%2Fb.pdf')).toBe(
      `attachment; filename="a_2Fb.pdf"; filename*=UTF-8''a%252Fb.pdf`
    );
    expect(contentDispositionFor('100%.pdf')).toBe(
      `attachment; filename="100_.pdf"; filename*=UTF-8''100%25.pdf`
    );
    // And the name is perfectly legal — it is only the fallback that loses it.
    expect(normalizeDownloadFilename('a%2Fb.pdf')).toBe('a%2Fb.pdf');
  });

  it('escapes a quote or a backslash so the quoted string cannot be ended early', () => {
    const header = contentDispositionFor('a"b\\c.pdf');
    expect(header).toContain('filename="a\\"b\\\\c.pdf"');
    expect(header).toContain(`filename*=UTF-8''a%22b%5Cc.pdf`);
  });

  it('cannot be made to carry a line break', () => {
    // Belt and braces: the normalizer has already refused every control
    // character, so a header built from a verified name has none to escape.
    for (const name of ['deck.pdf', 'Übung 1.pdf', '🎓.key']) {
      const header = contentDispositionFor(name);
      expect(header).not.toContain('\r');
      expect(header).not.toContain('\n');
      expect(header.startsWith('attachment; ')).toBe(true);
    }
  });
});
