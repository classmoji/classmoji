/**
 * contentImport.service pure helpers: routeSlug, dedupe (slug/title suffixing),
 * remapFilePath, formatWarning. No DB/GitHub — the orchestrator's IO paths are
 * out of scope here (repo pure-only test convention). The runtime-heavy imports
 * the service pulls in at module load are stubbed so importing it is cheap.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@classmoji/database', () => ({ default: () => ({}) }));
vi.mock('../../content/ContentService.ts', () => ({ ContentService: {} }));
vi.mock('../../git/index.ts', () => ({ getGitProvider: vi.fn() }));
vi.mock('../page.service.ts', () => ({ ensureContentRepo: vi.fn() }));
vi.mock('../contentManifest.service.ts', () => ({ saveManifest: vi.fn() }));

const { routeSlug, dedupe, slugSuffix, titleSuffix, remapFilePath, formatWarning } = await import(
  '../contentImport.service.ts'
);

describe('routeSlug', () => {
  it('matches the page/slide content-path slug computation', () => {
    expect(routeSlug('Hello World!')).toBe('hello-world');
    expect(routeSlug('  Lab 3: Pointers & Arrays ')).toBe('lab-3-pointers-arrays');
    expect(routeSlug('Intro---to___CS')).toBe('intro-to-cs');
  });

  it('collapses runs of non-alphanumerics and trims edge dashes', () => {
    expect(routeSlug('___abc___')).toBe('abc');
    expect(routeSlug('a  b\tc')).toBe('a-b-c');
  });

  it('returns empty for a title with no slug-able characters', () => {
    expect(routeSlug('')).toBe('');
    expect(routeSlug('!!!')).toBe('');
    expect(routeSlug('日本語')).toBe('');
  });
});

describe('dedupe with slugSuffix', () => {
  it('returns the base untouched when it is free', () => {
    expect(dedupe('lab-1', new Set<string>(), slugSuffix)).toBe('lab-1');
    expect(dedupe('lab-1', new Set(['other']), slugSuffix)).toBe('lab-1');
  });

  it('suffixes -2, then -3, on collisions', () => {
    expect(dedupe('lab-1', new Set(['lab-1']), slugSuffix)).toBe('lab-1-2');
    expect(dedupe('lab-1', new Set(['lab-1', 'lab-1-2']), slugSuffix)).toBe('lab-1-3');
  });

  it('skips already-taken suffixes to the next free one', () => {
    expect(dedupe('lab-1', new Set(['lab-1', 'lab-1-2', 'lab-1-3']), slugSuffix)).toBe('lab-1-4');
  });

  it('does not mutate the taken set', () => {
    const taken = new Set(['lab-1']);
    dedupe('lab-1', taken, slugSuffix);
    expect(taken.has('lab-1-2')).toBe(false);
    expect(taken.size).toBe(1);
  });

  it('deterministically walks a run of imported collisions when the caller accumulates', () => {
    const taken = new Set(['lab-1']);
    const a = dedupe('lab-1', taken, slugSuffix);
    taken.add(a);
    const b = dedupe('lab-1', taken, slugSuffix);
    taken.add(b);
    expect([a, b]).toEqual(['lab-1-2', 'lab-1-3']);
  });
});

describe('dedupe with titleSuffix', () => {
  it('leaves a free title unchanged', () => {
    expect(dedupe('Lab 1', new Set<string>(), titleSuffix)).toBe('Lab 1');
  });

  it('appends " (N)" on collisions', () => {
    expect(dedupe('Lab 1', new Set(['Lab 1']), titleSuffix)).toBe('Lab 1 (2)');
    expect(dedupe('Lab 1', new Set(['Lab 1', 'Lab 1 (2)']), titleSuffix)).toBe('Lab 1 (3)');
  });
});

describe('remapFilePath', () => {
  it('maps a top-level file into the target folder', () => {
    expect(remapFilePath('pages/lab-1/index.html', 'pages/lab-1', 'pages/lab-1-2')).toBe(
      'pages/lab-1-2/index.html'
    );
  });

  it('preserves nested sub-paths (assets, images)', () => {
    expect(
      remapFilePath('pages/lab-1/assets/diagram.png', 'pages/lab-1', 'pages/intro')
    ).toBe('pages/intro/assets/diagram.png');
    expect(remapFilePath('slides/deck/deck.json', 'slides/deck', 'slides/deck-2')).toBe(
      'slides/deck-2/deck.json'
    );
  });

  it('maps the folder path itself to the target folder', () => {
    expect(remapFilePath('pages/lab-1', 'pages/lab-1', 'pages/lab-1-2')).toBe('pages/lab-1-2');
  });

  it('defensively keeps only the basename for a path outside the source prefix', () => {
    expect(remapFilePath('other/thing.txt', 'pages/lab-1', 'pages/lab-1-2')).toBe(
      'pages/lab-1-2/thing.txt'
    );
  });
});

describe('formatWarning', () => {
  it('prefixes the scope and passes short detail through', () => {
    expect(formatWarning('pages', 'no files at pages/lab-1')).toBe(
      'pages: no files at pages/lab-1'
    );
  });

  it('truncates over-long detail with an ellipsis', () => {
    const detail = 'x'.repeat(500);
    const out = formatWarning('slides', detail);
    expect(out.startsWith('slides: ')).toBe(true);
    // scope + ': ' + 200 chars of detail + '…'
    expect(out).toBe(`slides: ${'x'.repeat(200)}…`);
    expect(out.length).toBe('slides: '.length + 201);
  });

  it('leaves detail exactly at the limit untouched', () => {
    const detail = 'y'.repeat(200);
    expect(formatWarning('manifest', detail)).toBe(`manifest: ${detail}`);
  });
});
