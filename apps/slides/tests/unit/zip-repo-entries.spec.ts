/**
 * The slides.com import leaves out a ZIP entry the course repository cannot
 * take, with a warning naming it, instead of letting GitHub refuse the whole
 * single-commit import.
 *
 * Runs in the Playwright runner without a browser or the dev stack: the gate is
 * JSZip plus the shared limit, and the importer's use of it is checked from its
 * source, the way slide-gates.spec checks the routes.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import JSZip from 'jszip';

import {
  EntrySizeError,
  RepoEntryGate,
  declaredUncompressedSize,
  inflateAtMost,
  resolveMediaRef,
  slideNumberLabel,
} from '../../app/utils/zipRepoEntries.ts';

const CAP = 35 * 1024 * 1024;
const here = dirname(fileURLToPath(import.meta.url));

async function zipWith(entries: Record<string, Uint8Array>) {
  const zip = new JSZip();
  for (const [name, bytes] of Object.entries(entries)) zip.file(name, bytes);
  // STORE, not DEFLATE: a zero-filled 36 MB entry compresses to almost nothing,
  // which would hide nothing here but makes the round trip needlessly slow.
  const built = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
  return JSZip.loadAsync(built);
}

test.describe('RepoEntryGate', () => {
  test('keeps an entry at the cap and leaves out one over it, by name', () => {
    const gate = new RepoEntryGate();

    expect(gate.admit('at-cap.png', CAP, 'images/at-cap.png')).toBe(true);
    expect(gate.admit('lecture.mp4', CAP + 5 * 1024 * 1024, 'videos/lecture.mp4')).toBe(false);

    expect(gate.warnings()).toEqual([
      'Skipped lecture.mp4 (40 MB) — larger than the 35 MB your course repository accepts',
    ]);
    expect(gate.skippedPaths()).toEqual(new Set(['videos/lecture.mp4']));
  });

  test('reads the size an entry declares from the ZIP’s directory, without inflating it', async () => {
    const zip = await zipWith({ 'videos/lecture.mp4': new Uint8Array(CAP + 1) });
    expect(declaredUncompressedSize(zip.file('videos/lecture.mp4')!)).toBe(CAP + 1);
  });

  test('declares nothing for an entry with no directory record behind it', () => {
    // An entry added in memory.
    const zip = new JSZip();
    zip.file('images/a.png', new Uint8Array(10));
    expect(declaredUncompressedSize(zip.file('images/a.png')!)).toBeNull();
  });

  test('has no reader of its own: every entry is inflated through inflateAtMost', () => {
    // Code only: the doc comment on inflateAtMost names what it replaces.
    const module = readFileSync(join(here, '../../app/utils/zipRepoEntries.ts'), 'utf8')
      .split('\n')
      .filter(line => !/^\s*(\*|\/\/|\/\*\*)/.test(line))
      .join('\n');
    expect(module).toContain("entry.nodeStream('nodebuffer')");
    expect(module).not.toMatch(/\basync read\(/);
    expect(module).not.toMatch(/\.async\('(nodebuffer|string|uint8array|base64)'\)/);
  });

  test('admits by size alone for bytes already in hand', () => {
    const gate = new RepoEntryGate();
    expect(gate.admit('a.mp4', CAP)).toBe(true);
    expect(gate.admit('b.mp4', CAP + 1, 'videos/b.mp4')).toBe(false);
    expect(gate.skipped).toEqual([{ path: 'videos/b.mp4', name: 'b.mp4', bytes: CAP + 1 }]);
  });

  test('an entry skipped for a reason of the caller’s own warns with that sentence', () => {
    const gate = new RepoEntryGate();
    gate.admit('big.mp4', CAP + 1, 'videos/big.mp4');
    gate.skip('talk.mp4', 3 * 1024 * 1024, 'videos/talk.mp4', 'Skipped talk.mp4 — no room');
    // Both are left out: the deck's references to either are removed.
    expect(gate.skippedPaths()).toEqual(new Set(['videos/big.mp4', 'videos/talk.mp4']));
    expect(gate.warnings(new Map([['videos/talk.mp4', ['2']]]))).toEqual([
      'Skipped big.mp4 (35 MB) — larger than the 35 MB your course repository accepts',
      'Slide 2: Skipped talk.mp4 — no room',
    ]);
  });

  test('names the slides that used a skipped file in its warning', () => {
    const gate = new RepoEntryGate();
    gate.admit('a.mp4', CAP + 1, 'videos/a.mp4');
    gate.admit('b.mp4', CAP + 1, 'videos/b.mp4');
    gate.admit('c.mp4', CAP + 1, 'videos/c.mp4');
    const warnings = gate.warnings(
      new Map([
        ['videos/a.mp4', ['3']],
        ['videos/b.mp4', ['2', '4.1']],
      ])
    );
    expect(warnings[0]).toMatch(/^Slide 3: Skipped a\.mp4 \(35 MB\)/);
    expect(warnings[1]).toMatch(/^Slides 2, 4\.1: Skipped b\.mp4/);
    // Never referenced: no slide to name.
    expect(warnings[2]).toMatch(/^Skipped c\.mp4/);
  });
});

test.describe('resolveMediaRef', () => {
  // The importer's map: every kept file under its zip path AND its filename.
  const kept = new Map([
    ['media/a/intro.mp4', '/content/o/r/slides/x/videos/intro.mp4'],
    ['intro.mp4', '/content/o/r/slides/x/videos/intro.mp4'],
    ['images/logo.png', '/content/o/r/slides/x/images/logo.png'],
    ['logo.png', '/content/o/r/slides/x/images/logo.png'],
  ]);
  const skipped = new Set(['media/b/intro.mp4', 'videos/lecture.mp4']);

  test('rewrites a kept file', () => {
    expect(resolveMediaRef('images/logo.png', kept, skipped)).toEqual({
      kind: 'kept',
      url: '/content/o/r/slides/x/images/logo.png',
    });
    expect(resolveMediaRef('./images/logo.png?v=2', kept, skipped)?.kind).toBe('kept');
  });

  test('a skipped file named exactly is removed, not swapped for a kept namesake', () => {
    expect(resolveMediaRef('media/b/intro.mp4', kept, skipped)).toEqual({
      kind: 'skipped',
      path: 'media/b/intro.mp4',
    });
    expect(resolveMediaRef('../media/b/intro.mp4', kept, skipped)).toEqual({
      kind: 'skipped',
      path: 'media/b/intro.mp4',
    });
    // Its kept namesake still resolves to itself.
    expect(resolveMediaRef('media/a/intro.mp4', kept, skipped)?.kind).toBe('kept');
  });

  test('a skipped file named by its filename alone is removed', () => {
    expect(resolveMediaRef('lecture.mp4', kept, skipped)).toEqual({
      kind: 'skipped',
      path: 'videos/lecture.mp4',
    });
  });

  test('a reference to neither is left alone', () => {
    expect(resolveMediaRef('https://example.com/other.png', kept, skipped)).toBeNull();
  });
});

test.describe('slideNumberLabel', () => {
  test('numbers a slide as Reveal does', () => {
    expect(slideNumberLabel([2])).toBe('3');
    // Innermost first: the second slide of the fourth stack.
    expect(slideNumberLabel([1, 3])).toBe('4.2');
    expect(slideNumberLabel([])).toBeNull();
  });
});

test.describe('inflateAtMost', () => {
  const MB = 1024 * 1024;

  /** A DEFLATE zip whose entry's header claims `declared` bytes. */
  async function forged(bytes: number, declared: number) {
    const zip = new JSZip();
    zip.file('media/big.mp4', new Uint8Array(bytes));
    const built = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const loaded = await JSZip.loadAsync(built);
    const entry = loaded.file('media/big.mp4')!;
    // What an uploader who wrote their own header would hand us.
    (entry as unknown as { _data: { uncompressedSize: number } })._data.uncompressedSize = declared;
    return entry;
  }

  test('hands back the bytes of an honest entry', async () => {
    const entry = await forged(3 * MB, 3 * MB);
    expect((await inflateAtMost(entry, 3 * MB)).length).toBe(3 * MB);
  });

  test('a header that claims less stops at the limit, long before the end', async () => {
    const entry = await forged(64 * MB, 1024);
    const error = await inflateAtMost(entry, 1024).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EntrySizeError);
    const { inflatedBytes, limitBytes } = error as EntrySizeError;
    expect(limitBytes).toBe(1024);
    expect(inflatedBytes).toBeGreaterThan(1024);
    // One chunk past the limit, not the 64 MB behind it.
    expect(inflatedBytes).toBeLessThan(4 * MB);
  });

  test('a header that claims more is a size error too, not a failed import', async () => {
    const entry = await forged(1 * MB, 2 * MB);
    const error = await inflateAtMost(entry, 2 * MB).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EntrySizeError);
    expect((error as EntrySizeError).limitBytes).toBeNull();
  });
});

test.describe('slides.com importer', () => {
  const source = readFileSync(join(here, '../../app/utils/slidesComImporter.server.ts'), 'utf8');

  test('reads every repository-bound ZIP entry through the gate', () => {
    // Images, videos and the theme's lib/ files are all placed by
    // `placeImportEntry`, which admits through the gate and the import's
    // limits (pinned in import-video-media.spec). Nothing reaches `files`
    // straight from JSZip.
    expect(source.match(/gate: repoGate,/g)).toHaveLength(2);
    expect(source.match(/^\s+limits,$/gm)).toHaveLength(2);
    expect(source.match(/inflateAtMost\(file, limit\)/g)).toHaveLength(2);
    expect(source).not.toMatch(/file\.async\('nodebuffer'\)/);
    expect(source).not.toMatch(/file\.async\('base64'\)/);
  });

  test('resolves every media reference against both the kept and the skipped files', () => {
    expect(source.match(/resolveMediaRef\(val, imageMap, skippedImages\)/g)).toHaveLength(2);
    expect(source.match(/resolveMediaRef\(val, videoMap, skippedVideos\)/g)).toHaveLength(2);
    expect(source).toContain('resolveMediaRef(srcVal, videoMap, skippedVideos)');
    // A skipped <source> goes; its reference would point into the ZIP.
    expect(source).toContain('$source.remove();');
    // The old per-entry loops that let a filename match win are gone.
    expect(source).not.toContain('for (const [oldPath, newPath] of imageMap)');
    expect(source).not.toContain('for (const [oldPath, newPath] of videoMap)');
  });

  test('reports what it left out on the done event and in its result', () => {
    expect(source).toContain(
      "type: 'done', slideId: slide.id, ...(warnings.length ? { warnings } : {})"
    );
    expect(source).toMatch(/\n\s+warnings, \/\/ Entries left out/);
    // Built after the last reference pass, so it can name the slides.
    expect(source.indexOf('warnings = repoGate.warnings(skippedOnSlides);')).toBeGreaterThan(
      source.indexOf("$slides.find('section[data-background-video]')")
    );
  });
});
