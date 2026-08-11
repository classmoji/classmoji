/**
 * contentImport.service URL-rewrite helpers: isTextContentPath,
 * rewriteContentUrls, rewriteStagedFiles. Pure functions only — no DB/GitHub.
 * The runtime-heavy imports the service pulls in at module load are stubbed so
 * importing it is cheap.
 *
 * What these guard: imported content must point at ITS OWN copied assets. If a
 * rewrite is missed, the copy keeps referencing the SOURCE repo and every image
 * 404s the moment the source classroom is deleted with GitHub cleanup.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@classmoji/database', () => ({ default: () => ({}) }));
vi.mock('../../content/ContentService.ts', () => ({ ContentService: {} }));
vi.mock('../../git/index.ts', () => ({ getGitProvider: vi.fn() }));
vi.mock('../page.service.ts', () => ({ ensureContentRepo: vi.fn() }));
vi.mock('../contentManifest.service.ts', () => ({ saveManifest: vi.fn() }));

const { isTextContentPath, rewriteContentUrls, rewriteStagedFiles } =
  await import('../contentImport.service.ts');

/** Source and target deliberately live in DIFFERENT orgs — the org segment of
 *  every URL must be swapped too, not just the repo name. */
const ctx = {
  sourceLogin: 'dartmouth-cs52',
  sourceRepo: 'content-dartmouth-cs52-cs52-25s',
  sourcePath: 'pages/lab-1',
  targetLogin: 'brown-cs32',
  targetRepo: 'content-brown-cs32-cs32-26f',
  targetPath: 'pages/lab-1',
};

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const fromB64 = (s: string) => Buffer.from(s, 'base64').toString('utf8');

describe('isTextContentPath', () => {
  it('accepts the text formats content is authored in', () => {
    expect(isTextContentPath('pages/lab-1/content.json')).toBe(true);
    expect(isTextContentPath('slides/deck/index.html')).toBe(true);
    expect(isTextContentPath('pages/lab-1/assets/diagram.svg')).toBe(true);
  });

  it('rejects binaries — decoding them as utf8 would corrupt the bytes', () => {
    expect(isTextContentPath('pages/lab-1/assets/screenshot.png')).toBe(false);
    expect(isTextContentPath('slides/deck/assets/demo.mp4')).toBe(false);
  });
});

describe('rewriteContentUrls', () => {
  it('rewrites this item’s own asset URLs onto its dedupe-suffixed target path', () => {
    const suffixed = { ...ctx, targetPath: 'pages/lab-1-2' };
    const text = `![d](https://raw.githubusercontent.com/dartmouth-cs52/content-dartmouth-cs52-cs52-25s/main/pages/lab-1/assets/d.png)`;
    expect(rewriteContentUrls(text, suffixed)).toBe(
      `![d](https://raw.githubusercontent.com/brown-cs32/content-brown-cs32-cs32-26f/main/pages/lab-1-2/assets/d.png)`
    );
  });

  it('rewrites cross-item references repo-generally, keeping their own folder path', () => {
    const suffixed = { ...ctx, targetPath: 'pages/lab-1-2' };
    const text =
      'https://raw.githubusercontent.com/dartmouth-cs52/content-dartmouth-cs52-cs52-25s/main/pages/lab-9/assets/other.png';
    // lab-9 is a DIFFERENT item: it keeps its folder, only org/repo change.
    expect(rewriteContentUrls(text, suffixed)).toBe(
      'https://raw.githubusercontent.com/brown-cs32/content-brown-cs32-cs32-26f/main/pages/lab-9/assets/other.png'
    );
  });

  it('rewrites the {login}.github.io Pages-CDN shape, item-specific and general', () => {
    const suffixed = { ...ctx, targetPath: 'pages/lab-1-2' };
    const own =
      'https://dartmouth-cs52.github.io/content-dartmouth-cs52-cs52-25s/pages/lab-1/a.svg';
    const other =
      'https://dartmouth-cs52.github.io/content-dartmouth-cs52-cs52-25s/pages/lab-9/b.svg';
    expect(rewriteContentUrls(own, suffixed)).toBe(
      'https://brown-cs32.github.io/content-brown-cs32-cs32-26f/pages/lab-1-2/a.svg'
    );
    expect(rewriteContentUrls(other, suffixed)).toBe(
      'https://brown-cs32.github.io/content-brown-cs32-cs32-26f/pages/lab-9/b.svg'
    );
  });

  it('rewrites every occurrence, not just the first', () => {
    const url =
      'https://raw.githubusercontent.com/dartmouth-cs52/content-dartmouth-cs52-cs52-25s/main/pages/lab-1/a.png';
    const out = rewriteContentUrls(`${url} and ${url}`, ctx);
    expect(out).not.toContain('dartmouth-cs52');
    expect(
      out.match(
        /https:\/\/raw\.githubusercontent\.com\/brown-cs32\/content-brown-cs32-cs32-26f\/main\/pages\/lab-1\/a\.png/g
      )
    ).toHaveLength(2);
  });

  it('returns text with no source URLs unchanged', () => {
    const text = '{"type":"paragraph","text":"See https://example.com/logo.png for details"}';
    expect(rewriteContentUrls(text, ctx)).toBe(text);
  });

  it('leaves an unrelated org’s GitHub URLs alone', () => {
    const text = 'https://raw.githubusercontent.com/someone-else/other-repo/main/pages/lab-1/x.png';
    expect(rewriteContentUrls(text, ctx)).toBe(text);
  });
});

describe('rewriteStagedFiles', () => {
  it('round-trips a text file through base64: decode, rewrite, re-encode', () => {
    const original =
      '{"src":"https://raw.githubusercontent.com/dartmouth-cs52/content-dartmouth-cs52-cs52-25s/main/pages/lab-1/hero.png"}';
    const out = rewriteStagedFiles(
      [{ path: 'pages/lab-1/content.json', content: b64(original), encoding: 'base64' as const }],
      ctx
    );
    expect(fromB64(out[0]!.content)).toBe(
      '{"src":"https://raw.githubusercontent.com/brown-cs32/content-brown-cs32-cs32-26f/main/pages/lab-1/hero.png"}'
    );
    expect(out[0]!.path).toBe('pages/lab-1/content.json');
    expect(out[0]!.encoding).toBe('base64');
  });

  it('never touches a binary — its base64 survives byte-for-byte', () => {
    // Bytes that are NOT valid utf8: a utf8 decode/encode round-trip would
    // replace them with U+FFFD and silently corrupt the asset.
    const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01]).toString('base64');
    const out = rewriteStagedFiles(
      [{ path: 'pages/lab-1/assets/hero.png', content: raw, encoding: 'base64' as const }],
      ctx
    );
    expect(out[0]!.content).toBe(raw);
  });

  it('keeps the identical content string for text with no matches', () => {
    const untouched = b64('{"type":"paragraph","text":"no urls here"}');
    const out = rewriteStagedFiles(
      [{ path: 'pages/lab-1/content.json', content: untouched, encoding: 'base64' as const }],
      ctx
    );
    expect(out[0]!.content).toBe(untouched);
  });

  it('rewrites the text entries of a mixed batch and passes the rest through', () => {
    const text = b64(
      'https://dartmouth-cs52.github.io/content-dartmouth-cs52-cs52-25s/pages/lab-1/a.svg'
    );
    const binary = Buffer.from([0x00, 0xff, 0x10]).toString('base64');
    const out = rewriteStagedFiles(
      [
        { path: 'pages/lab-1/content.json', content: text, encoding: 'base64' as const },
        { path: 'pages/lab-1/assets/a.png', content: binary, encoding: 'base64' as const },
      ],
      ctx
    );
    expect(fromB64(out[0]!.content)).toBe(
      'https://brown-cs32.github.io/content-brown-cs32-cs32-26f/pages/lab-1/a.svg'
    );
    expect(out[1]!.content).toBe(binary);
    expect(out).toHaveLength(2);
  });
});
