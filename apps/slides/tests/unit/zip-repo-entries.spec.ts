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

import { RepoEntryGate } from '../../app/utils/zipRepoEntries.ts';

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
  test('keeps an entry at the cap and leaves out one over it, by name', async () => {
    const zip = await zipWith({
      'images/at-cap.png': new Uint8Array(CAP),
      'videos/lecture.mp4': new Uint8Array(CAP + 5 * 1024 * 1024),
    });
    const gate = new RepoEntryGate();

    const kept = await gate.read(zip.file('images/at-cap.png')!, 'at-cap.png');
    const skipped = await gate.read(zip.file('videos/lecture.mp4')!, 'lecture.mp4');

    expect(kept?.length).toBe(CAP);
    expect(skipped).toBeNull();
    expect(gate.warnings).toEqual([
      'Skipped lecture.mp4 (40 MB) — larger than the 35 MB your course repository accepts',
    ]);
  });

  test('admits by size alone for bytes already in hand', () => {
    const gate = new RepoEntryGate();
    expect(gate.admit('a.mp4', CAP)).toBe(true);
    expect(gate.admit('b.mp4', CAP + 1)).toBe(false);
    expect(gate.warnings).toHaveLength(1);
  });
});

test.describe('slides.com importer', () => {
  const source = readFileSync(join(here, '../../app/utils/slidesComImporter.server.ts'), 'utf8');

  test('reads every repository-bound ZIP entry through the gate', () => {
    // Images, videos and the theme's lib/ files — nothing reaches `files`
    // straight from JSZip any more.
    expect(source.match(/await repoGate\.read\(/g)).toHaveLength(3);
    expect(source).not.toMatch(/file\.async\('base64'\)/);
    // The Cloudinary fallback already holds the bytes, so it asks by size.
    expect(source).toContain('repoGate.admit(filename, buffer.length)');
  });

  test('reports what it left out on the done event and in its result', () => {
    expect(source).toContain(
      "type: 'done', slideId: slide.id, ...(warnings.length ? { warnings } : {})"
    );
    expect(source).toMatch(/\n\s+warnings, \/\/ Entries left out/);
  });
});
