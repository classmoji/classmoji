/**
 * Where the slides.com import's assets go (`importVideoMedia.ts`) — the
 * repository, media storage, or left out with a warning — how little of the ZIP
 * is held in memory while they are placed, and the importer's wiring.
 *
 * The rules are pure with the write injected, so they run here with media
 * storage mocked: which entries the router sends to media, what a stored video
 * becomes in the deck (`media://{id}`), and what one that media storage refuses
 * becomes (left out, with a named warning through the same gate as the size
 * skips — never a failed import). The importer itself needs a database and
 * GitHub, so its use of those rules is pinned from its source, as
 * zip-repo-entries.spec does; so is the retirement of the Cloudinary choice
 * from the import flow.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import JSZip from 'jszip';

import {
  IMPORT_ENTRY_MAX_BYTES,
  IMPORT_INFLATE_BUDGET_BYTES,
  IMPORT_REPO_HELD_BYTES,
  IMPORT_VIDEO_OPTIONS,
  INDEX_HTML_INVALID_MESSAGE,
  INDEX_HTML_MAX_BYTES,
  INDEX_HTML_MISSING_MESSAGE,
  ImportLimits,
  importAssetType,
  importEntryGoesToMedia,
  importMediaOptions,
  importMediaSkippedWarning,
  placeImportEntry,
  readImportIndexHtml,
  type ImportZipEntry,
  type PutImportMedia,
} from '../../app/utils/importVideoMedia.ts';
import { MEDIA_QUOTA_FULL_MESSAGE, type UploadCapability } from '../../app/utils/mediaUpload.ts';
import {
  EntrySizeError,
  RepoEntryGate,
  inflateAtMost,
  resolveMediaRef,
} from '../../app/utils/zipRepoEntries.ts';

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const source = (relative: string) => readFileSync(path(relative), 'utf8');

const MB = 1024 * 1024;
const GB = 1024 * MB;

const PRO: UploadCapability = {
  repoMaxBytes: 35 * MB,
  repoFileTypes: 'any',
  isPro: true,
  // The per-file ceiling as the services set it: 2,000,000,000 bytes (a decimal 2 GB).
  media: { perFileMaxBytes: 2_000_000_000, remainingBytes: 10 * GB },
};
const FREE: UploadCapability = { ...PRO, isPro: false, media: null };
const PRO_NO_MEDIA: UploadCapability = { ...PRO, media: null };

const ID_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ID_C = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';

test.describe('which ZIP entries go to media', () => {
  test('on a classroom with media, every video — whatever its size', () => {
    expect(importEntryGoesToMedia(PRO, 'intro.mp4', 2 * MB)).toBe(true);
    expect(importEntryGoesToMedia(PRO, 'lecture.mov', 120 * MB)).toBe(true);
    expect(importEntryGoesToMedia(PRO, 'clip.webm', 0)).toBe(true);
  });

  test('audio that fits stays in the repository; over the cap it goes to media', () => {
    expect(importEntryGoesToMedia(PRO, 'theme.mp3', 4 * MB)).toBe(false);
    expect(importEntryGoesToMedia(PRO, 'podcast.mp3', 40 * MB)).toBe(true);
  });

  test('never on a classroom without media — Free, or Pro whose media is unavailable', () => {
    expect(importEntryGoesToMedia(FREE, 'intro.mp4', 2 * MB)).toBe(false);
    expect(importEntryGoesToMedia(FREE, 'lecture.mp4', 80 * MB)).toBe(false);
    expect(importEntryGoesToMedia(PRO_NO_MEDIA, 'lecture.mp4', 80 * MB)).toBe(false);
    expect(importEntryGoesToMedia(null, 'intro.mp4', 2 * MB)).toBe(false);
  });

  test('stored with the uploader’s defaults: optimise, keep the original, no download', () => {
    expect(IMPORT_VIDEO_OPTIONS).toEqual({
      optimise: true,
      keepOriginal: true,
      allowDownload: false,
    });
  });
});

/**
 * A fake ZIP entry: records when it is inflated, and hands back `actual` bytes
 * (a lying header is `declared` ≠ `actual`) — or stops past the limit it is
 * given, as `inflateAtMost` does, without producing them.
 */
function fakeEntry(
  log: string[],
  filePath: string,
  declared: number | null,
  actual: number = declared ?? 0
): ImportZipEntry {
  const filename = filePath.split('/').pop() ?? filePath;
  return {
    filePath,
    filename,
    declared,
    inflate: async limitBytes => {
      log.push(`inflate ${filename}`);
      if (actual > limitBytes) {
        log.push(`stopped ${filename} at ${limitBytes}`);
        throw new EntrySizeError(limitBytes + 1, limitBytes);
      }
      return Buffer.alloc(actual);
    },
  };
}

/**
 * Stores everything but `lecture.mp4`, which the quota refuses, and
 * `broken.mp4`, whose write fails for another reason.
 */
function mockPut(log: string[]) {
  const put =
    (filename: string): PutImportMedia =>
    async bytes => {
      log.push(`put ${filename} ${bytes.length}`);
      if (filename === 'lecture.mp4') {
        throw Object.assign(new Error(MEDIA_QUOTA_FULL_MESSAGE), {
          name: 'MediaError',
          code: 'QUOTA_EXCEEDED',
        });
      }
      if (filename === 'broken.mp4') throw new Error('socket hang up');
      const mediaId = filename === 'intro.mp4' ? ID_A : ID_C;
      return { mediaId, ref: `media://${mediaId}` };
    };
  return put;
}

test.describe('placing ZIP entries (media storage mocked)', () => {
  test('a stored video is media://{id}; a refused one is left out, named; one at a time', async () => {
    const log: string[] = [];
    const put = mockPut(log);
    const gate = new RepoEntryGate();
    const limits = new ImportLimits();
    const errors: string[] = [];
    const entries = [
      fakeEntry(log, 'media/a/intro.mp4', 3 * MB),
      fakeEntry(log, 'media/b/broken.mp4', 5 * MB),
      fakeEntry(log, 'media/c/outro.mp4', 1 * MB),
    ];

    const placed = [];
    for (const entry of entries) {
      placed.push(
        await placeImportEntry({
          entry,
          capability: PRO,
          gate,
          limits,
          put: put(entry.filename),
          onError: filename => errors.push(filename),
        })
      );
    }

    // Each entry is inflated and stored before the next is read — its bytes
    // are never held alongside the next one's — and one failure does not stop
    // the ones after it.
    expect(log).toEqual([
      'inflate intro.mp4',
      `put intro.mp4 ${3 * MB}`,
      'inflate broken.mp4',
      `put broken.mp4 ${5 * MB}`,
      'inflate outro.mp4',
      `put outro.mp4 ${1 * MB}`,
    ]);
    // A media placement carries the reference, never the bytes.
    expect(placed).toEqual([
      { kind: 'media', mediaId: ID_A, ref: `media://${ID_A}` },
      { kind: 'skipped' },
      { kind: 'media', mediaId: ID_C, ref: `media://${ID_C}` },
    ]);

    // Refused: through the gate, so the deck drops its references and the
    // warning names the slides that used it — never the upstream message.
    expect(errors).toEqual(['broken.mp4']);
    expect(gate.skippedPaths()).toEqual(new Set(['media/b/broken.mp4']));
    expect(gate.warnings(new Map([['media/b/broken.mp4', ['4']]]))).toEqual([
      'Slide 4: Skipped broken.mp4 (5 MB) — media storage could not take it (the upload failed)',
    ]);
    expect(resolveMediaRef('media/b/broken.mp4', new Map(), gate.skippedPaths())).toEqual({
      kind: 'skipped',
      path: 'media/b/broken.mp4',
    });
  });

  test('a full media store: every later media-bound entry is left out uninflated, in one warning', async () => {
    const log: string[] = [];
    const put = mockPut(log);
    const gate = new RepoEntryGate();
    const limits = new ImportLimits();
    const entries = [
      fakeEntry(log, 'media/a/lecture.mp4', 5 * MB),
      fakeEntry(log, 'media/b/outro.mp4', 1 * MB),
      // Not bound for media: the repository still takes it.
      fakeEntry(log, 'img/logo.png', 1 * MB),
      fakeEntry(log, 'media/c/intro.mp4', 2 * MB),
    ];

    const placed = [];
    for (const entry of entries) {
      placed.push(
        await placeImportEntry({ entry, capability: PRO, gate, limits, put: put(entry.filename) })
      );
    }

    expect(placed.map(p => p.kind)).toEqual(['skipped', 'skipped', 'repo', 'skipped']);
    expect(log).toEqual(['inflate lecture.mp4', `put lecture.mp4 ${5 * MB}`, 'inflate logo.png']);
    expect(gate.skippedPaths()).toEqual(
      new Set(['media/a/lecture.mp4', 'media/b/outro.mp4', 'media/c/intro.mp4'])
    );
    // One warning, saying what the server says: who to contact.
    const warnings = gate.warnings(
      new Map([
        ['media/a/lecture.mp4', ['4']],
        ['media/c/intro.mp4', ['1', '4']],
      ])
    );
    expect(warnings).toEqual([
      'Slides 4, 1: Skipped lecture.mp4 (5 MB), outro.mp4 (1 MB), intro.mp4 (2 MB) — ' +
        "This class's media storage is full. Contact hello@classmoji.io to upgrade.",
    ]);
    expect(warnings[0]).not.toContain('QUOTA_EXCEEDED');
  });

  test('an entry declared over the per-file media cap is never inflated', async () => {
    const log: string[] = [];
    const gate = new RepoEntryGate();
    const capped: UploadCapability = {
      ...PRO,
      // The capability's own ceiling — whatever the services slice sets it to.
      media: { perFileMaxBytes: 2_000_000_000, remainingBytes: 10 * GB },
    };
    const placed = await placeImportEntry({
      entry: fakeEntry(log, 'media/huge.mp4', 2_000_000_001),
      capability: capped,
      gate,
      limits: new ImportLimits(),
      put: mockPut(log)('huge.mp4'),
    });
    expect(placed).toEqual({ kind: 'skipped' });
    expect(log).toEqual([]);
    expect(gate.warnings()[0]).toContain('it is over the limit for one file');
  });

  test('an entry declared over the repository cap, with no media, is never inflated', async () => {
    const log: string[] = [];
    const gate = new RepoEntryGate();
    const placed = await placeImportEntry({
      entry: fakeEntry(log, 'media/lecture.mp4', 80 * MB),
      capability: FREE,
      gate,
      limits: new ImportLimits(),
      put: mockPut(log)('lecture.mp4'),
    });
    expect(placed).toEqual({ kind: 'skipped' });
    expect(log).toEqual([]);
    expect(gate.warnings()[0]).toContain('course repository');
  });

  test('the import budget: an entry past it is left out, named, and never inflated', async () => {
    const log: string[] = [];
    const gate = new RepoEntryGate();
    const limits = new ImportLimits({ inflateBytes: 100 * MB });
    const put = mockPut(log);
    const first = await placeImportEntry({
      entry: fakeEntry(log, 'media/intro.mp4', 80 * MB),
      capability: PRO,
      gate,
      limits,
      put: put('intro.mp4'),
    });
    const second = await placeImportEntry({
      entry: fakeEntry(log, 'media/outro.mp4', 30 * MB),
      capability: PRO,
      gate,
      limits,
      put: put('outro.mp4'),
    });
    expect(first.kind).toBe('media');
    expect(second).toEqual({ kind: 'skipped' });
    expect(log).toEqual(['inflate intro.mp4', `put intro.mp4 ${80 * MB}`]);
    expect(limits.inflated.usedBytes).toBe(80 * MB);
    expect(gate.warnings()).toEqual([
      'Skipped outro.mp4 (30 MB) — this import is over its 100 MB limit for all files together',
    ]);
    // Well under the slides machine's 2 GB.
    expect(IMPORT_INFLATE_BUDGET_BYTES).toBe(512 * MB);
  });

  test('repository files are held until the commit: past their limit, left out, never inflated', async () => {
    const log: string[] = [];
    const gate = new RepoEntryGate();
    const limits = new ImportLimits({ repoHeldBytes: 50 * MB });
    const put = mockPut(log);
    const place = (filePath: string, bytes: number, capability: UploadCapability) =>
      placeImportEntry({
        entry: fakeEntry(log, filePath, bytes),
        capability,
        gate,
        limits,
        put: put(filePath.split('/').pop()!),
      });

    expect((await place('img/a.png', 30 * MB, PRO)).kind).toBe('repo');
    // Media is not held — a video on Pro is stored and dropped, whatever the total.
    expect((await place('media/intro.mp4', 30 * MB, PRO)).kind).toBe('media');
    expect(await place('img/b.png', 30 * MB, PRO)).toEqual({ kind: 'skipped' });
    // The theme's files count too: the same limits, with no capability at all.
    expect((await place('lib/fonts/a.woff', 20 * MB, FREE)).kind).toBe('repo');
    expect(await place('lib/fonts/b.woff', 1 * MB, FREE)).toEqual({ kind: 'skipped' });

    expect(log).not.toContain('inflate b.png');
    expect(log).not.toContain('inflate b.woff');
    expect(limits.repoHeld.usedBytes).toBe(50 * MB);
    expect(gate.warnings()).toEqual([
      'Skipped b.png (30 MB) — this import is over its 50 MB limit for files kept in the course repository',
      'Skipped b.woff (1 MB) — this import is over its 50 MB limit for files kept in the course repository',
    ]);
    expect(IMPORT_REPO_HELD_BYTES).toBe(256 * MB);
  });

  test('a lying header costs its own size: inflating stops there, and the entry is left out', async () => {
    const log: string[] = [];
    const gate = new RepoEntryGate();
    const limits = new ImportLimits();
    // Declared 1 KB — passes every check — and holds 1.5 GB.
    const placed = await placeImportEntry({
      entry: fakeEntry(log, 'media/forged.mp4', 1024, 1500 * MB),
      capability: PRO,
      gate,
      limits,
      put: mockPut(log)('forged.mp4'),
    });
    expect(placed).toEqual({ kind: 'skipped' });
    expect(log).toEqual(['inflate forged.mp4', 'stopped forged.mp4 at 1024']);
    expect(gate.skippedPaths()).toEqual(new Set(['media/forged.mp4']));
    expect(gate.warnings()).toEqual([
      'Skipped forged.mp4 — its size does not match what the ZIP says',
    ]);
    // What it inflated before it was stopped is charged, though it was left out.
    expect(limits.inflated.usedBytes).toBe(1025);
  });

  test('entries left out after inflating are charged, so a run of them trips the budget', async () => {
    const log: string[] = [];
    const gate = new RepoEntryGate();
    const limits = new ImportLimits({ inflateBytes: 10 * MB });
    // Each declares 1 MB — within every limit on its own — and holds 2 MB.
    for (let i = 0; i < 20; i++) {
      const placed = await placeImportEntry({
        entry: fakeEntry(log, `img/forged-${i}.png`, 1 * MB, 2 * MB),
        capability: FREE,
        gate,
        limits,
        put: mockPut(log)(`forged-${i}.png`),
      });
      expect(placed).toEqual({ kind: 'skipped' });
    }
    // Nine are inflated (and stopped at their declared size); from the tenth on,
    // the budget is spent and every later entry is left out on its declared
    // size, never inflated.
    const inflated = log.filter(line => line.startsWith('inflate '));
    expect(inflated).toHaveLength(9);
    expect(log).not.toContain('inflate forged-9.png');
    expect(log).not.toContain('inflate forged-19.png');
    expect(limits.inflated.usedBytes).toBe(9 * (MB + 1));
    expect(limits.inflated.usedBytes).toBeLessThanOrEqual(10 * MB);
    expect(gate.warnings()[9]).toBe(
      'Skipped forged-9.png (1 MB) — this import is over its 10 MB limit for all files together'
    );
  });

  test('an entry left out on the bytes it inflated is charged for them', async () => {
    const log: string[] = [];
    const gate = new RepoEntryGate();
    const limits = new ImportLimits();
    // No declared size: inflated whole, then too large for the repository.
    const placed = await placeImportEntry({
      entry: fakeEntry(log, 'img/huge.png', null, 40 * MB),
      capability: FREE,
      gate,
      limits,
      put: mockPut(log)('huge.png'),
    });
    expect(placed).toEqual({ kind: 'skipped' });
    expect(gate.warnings()[0]).toContain('course repository');
    expect(limits.inflated.usedBytes).toBe(40 * MB);
    // Never held for the commit.
    expect(limits.repoHeld.usedBytes).toBe(0);
  });

  test('with no declared size, inflating stops at one entry’s limit or the budget left', async () => {
    const log: string[] = [];
    const gate = new RepoEntryGate();
    const limits = new ImportLimits({ inflateBytes: 100 * MB });
    const put = mockPut(log);
    await placeImportEntry({
      entry: fakeEntry(log, 'media/intro.mp4', 80 * MB),
      capability: PRO,
      gate,
      limits,
      put: put('intro.mp4'),
    });
    const placed = await placeImportEntry({
      entry: fakeEntry(log, 'media/outro.mp4', null, 30 * MB),
      capability: PRO,
      gate,
      limits,
      put: put('outro.mp4'),
    });
    expect(placed).toEqual({ kind: 'skipped' });
    expect(log).toContain(`stopped outro.mp4 at ${20 * MB}`);
    expect(gate.warnings()).toEqual([
      'Skipped outro.mp4 (20 MB) — this import is over its 100 MB limit for all files together',
    ]);
  });

  test('a media-bound entry too large to hold in memory is left out, never inflated', async () => {
    const log: string[] = [];
    const gate = new RepoEntryGate();
    const placed = await placeImportEntry({
      entry: fakeEntry(log, 'media/lecture.mp4', IMPORT_ENTRY_MAX_BYTES + 1),
      capability: PRO,
      gate,
      limits: new ImportLimits(),
      put: mockPut(log)('lecture.mp4'),
    });
    expect(placed).toEqual({ kind: 'skipped' });
    expect(log).toEqual([]);
    expect(gate.warnings()).toEqual([
      "Skipped lecture.mp4 (256 MB) — it is over this import's 256 MB limit for one file",
    ]);
    // Far below media's own 2 GB per-file ceiling, which is not what one
    // entry of an import may cost.
    expect(IMPORT_ENTRY_MAX_BYTES).toBe(256 * MB);
  });

  test('an image over the repository cap goes to media on Pro, and stays out on Free', async () => {
    const log: string[] = [];
    const pro = await placeImportEntry({
      entry: fakeEntry(log, 'img/poster.png', 40 * MB),
      capability: PRO,
      gate: new RepoEntryGate(),
      limits: new ImportLimits(),
      put: mockPut(log)('poster.png'),
    });
    expect(pro).toEqual({ kind: 'media', mediaId: ID_C, ref: `media://${ID_C}` });

    const free = await placeImportEntry({
      entry: fakeEntry(log, 'img/poster.png', 40 * MB),
      capability: FREE,
      gate: new RepoEntryGate(),
      limits: new ImportLimits(),
      put: mockPut(log)('poster.png'),
    });
    expect(free).toEqual({ kind: 'skipped' });
  });

  test('a small image, and a Free video that fits, go to the repository with their bytes', async () => {
    const log: string[] = [];
    const image = await placeImportEntry({
      entry: fakeEntry(log, 'img/a.png', 2 * MB),
      capability: PRO,
      gate: new RepoEntryGate(),
      limits: new ImportLimits(),
      put: mockPut(log)('a.png'),
    });
    expect(image.kind).toBe('repo');
    if (image.kind === 'repo') expect(image.buffer.length).toBe(2 * MB);

    const video = await placeImportEntry({
      entry: fakeEntry(log, 'media/clip.mkv', 20 * MB),
      capability: FREE,
      gate: new RepoEntryGate(),
      limits: new ImportLimits(),
      put: mockPut(log)('clip.mkv'),
    });
    expect(video.kind).toBe('repo');
    expect(log.some(line => line.startsWith('put'))).toBe(false);
  });

  test('a full quota without a sentence falls back to the shared one', () => {
    expect(importMediaSkippedWarning('a.mp4', MB, { code: 'QUOTA_EXCEEDED' })).toBe(
      `Skipped a.mp4 (1 MB) — ${MEDIA_QUOTA_FULL_MESSAGE}`
    );
  });

  test('a warning never carries a code or an upstream message', () => {
    for (const code of ['NOT_CONFIGURED', 'PRO_REQUIRED', 'FILE_TOO_LARGE', 'SOMETHING_NEW']) {
      const warning = importMediaSkippedWarning('a.mp4', MB, { code, message: 'R2 said 503' });
      expect(warning).toMatch(/^Skipped a\.mp4 \(1 MB\) — media storage could not take it \(/);
      expect(warning).not.toContain(code);
      expect(warning).not.toContain('R2 said');
    }
    expect(importMediaSkippedWarning('a.mp4', MB, new Error('socket hang up'))).toContain(
      '(the upload failed)'
    );
  });
});

test.describe('which ZIP entries are assets, by the store’s kind table', () => {
  test('.mkv and .avi are videos; audio plays from the video path', () => {
    expect(importAssetType('media/a/clip.mkv')).toBe('video');
    expect(importAssetType('media/a/clip.avi')).toBe('video');
    expect(importAssetType('media/a/intro.mp4')).toBe('video');
    expect(importAssetType('media/a/theme.mp3')).toBe('video');
  });

  test('Ogg, AAC and FLAC are placed with the videos, so a background using one is rewritten', () => {
    for (const file of ['bg.ogv', 'bg.ogg', 'bg.oga', 'bg.aac', 'bg.flac']) {
      expect(importAssetType(`media/a/${file}`), file).toBe('video');
    }
    // `data-background-video` is resolved against the videos' map — every
    // VIDEO and AUDIO entry the import placed, media or repository.
    const importer = source('../../app/utils/slidesComImporter.server.ts');
    const background = importer.slice(
      importer.indexOf("$slides.find('section[data-background-video]')")
    );
    expect(background).toContain('resolveMediaRef(val, videoMap, skippedVideos)');
    expect(importer).toContain("const videoFiles = mediaFiles.filter(f => f.type === 'video');");
  });

  test('images, SVG, and anything else in an asset folder but css/js are images', () => {
    expect(importAssetType('img/photo.webp')).toBe('image');
    expect(importAssetType('logo.svg')).toBe('image');
    expect(importAssetType('assets/font.woff2')).toBe('image');
    expect(importAssetType('assets/app.js')).toBeNull();
    expect(importAssetType('assets/app.css')).toBeNull();
    expect(importAssetType('readme.txt')).toBeNull();
  });

  test('a video is stored with the video choices; anything else with none', () => {
    expect(importMediaOptions('clip.mkv')).toEqual({ ...IMPORT_VIDEO_OPTIONS });
    expect(importMediaOptions('poster.png')).toEqual({});
  });
});

test.describe('the deck’s index.html', () => {
  /** A DEFLATE zip holding `index.html`, its header optionally rewritten to `declared`. */
  async function indexEntry(html: string, declared?: number) {
    const zip = new JSZip();
    zip.file('index.html', html);
    const built = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const entry = (await JSZip.loadAsync(built)).file('index.html')!;
    if (declared !== undefined) {
      (entry as unknown as { _data: { uncompressedSize: number } })._data.uncompressedSize =
        declared;
    }
    return entry;
  }

  test('an export’s index.html is read and charged to the import’s budget', async () => {
    const html = '<html><body><div class="reveal"><div class="slides"></div></div></body></html>';
    const entry = await indexEntry(html);
    const limits = new ImportLimits();
    const read = await readImportIndexHtml(limit => inflateAtMost(entry, limit), limits);
    expect(read).toBe(html);
    expect(limits.inflated.usedBytes).toBe(Buffer.byteLength(html));
  });

  test('one past the ceiling stops there and fails as an export that is not one', async () => {
    // Spaces DEFLATE to almost nothing: a small ZIP whose index.html inflates
    // past 32 MB, whatever its header says.
    const entry = await indexEntry(' '.repeat(INDEX_HTML_MAX_BYTES + 4 * MB), 1024);
    const limits = new ImportLimits();
    const error = await readImportIndexHtml(limit => inflateAtMost(entry, limit), limits).catch(
      (e: unknown) => e
    );
    expect((error as Error).message).toBe(INDEX_HTML_INVALID_MESSAGE);
    // Stopped a chunk past the ceiling, not at the end; and charged.
    expect(limits.inflated.usedBytes).toBeGreaterThan(INDEX_HTML_MAX_BYTES);
    expect(limits.inflated.usedBytes).toBeLessThan(INDEX_HTML_MAX_BYTES + 4 * MB);
  });

  test('one that is not the size its header says fails the same way', async () => {
    const entry = await indexEntry('<html></html>', 2 * MB);
    const error = await readImportIndexHtml(
      limit => inflateAtMost(entry, limit),
      new ImportLimits()
    ).catch((e: unknown) => e);
    expect((error as Error).message).toBe(INDEX_HTML_INVALID_MESSAGE);
  });

  test('a ZIP without one, or with an empty one, is not an export', async () => {
    await expect(readImportIndexHtml(null, new ImportLimits())).rejects.toThrow(
      INDEX_HTML_MISSING_MESSAGE
    );
    const empty = await indexEntry('');
    await expect(
      readImportIndexHtml(limit => inflateAtMost(empty, limit), new ImportLimits())
    ).rejects.toThrow(INDEX_HTML_MISSING_MESSAGE);
  });

  test('well under the ceiling for a real export', () => {
    // The test export's index.html is 74 KB.
    expect(INDEX_HTML_MAX_BYTES).toBe(32 * MB);
  });
});

test.describe('the importer’s wiring', () => {
  const IMPORTER = source('../../app/utils/slidesComImporter.server.ts');
  const START = source('../../app/routes/api.slides.import.start/route.ts');
  const PAGE = source('../../app/routes/import/route.tsx');
  const PROGRESS = source('../../app/components/ImportProgressModal.tsx');
  const RULES = source('../../app/utils/importVideoMedia.ts');

  test('routes every asset with the classroom’s own capability, by the store’s kinds', () => {
    // Through the degrading lookup: a failed capability read is the repository
    // path, not a failed import.
    expect(IMPORTER).toContain("await loadUploadCapability(classroom, 'slides.com import')");
    expect(IMPORTER).not.toContain('media.uploadCapabilityFor(');
    expect(IMPORTER).toContain('const type = importAssetType(filePath);');
    // No extension list of its own any more.
    expect(IMPORTER).not.toMatch(/const (image|video)Extensions = \[/);
    // Every entry — images and videos alike — through the one placement, with
    // its declared size and a lazy inflate.
    expect(IMPORTER).toContain('await placeImportEntry({');
    expect(IMPORTER).toContain('declared: declaredUncompressedSize(file),');
    expect(IMPORTER).toContain('inflate: limit => inflateAtMost(file, limit),');
    expect(IMPORTER).toContain('capability: uploadCapability,');
    expect(IMPORTER).toContain('limits,');
    // One set of limits per import, shared by the assets and the theme's files.
    expect(IMPORTER.match(/new ImportLimits\(/g)).toHaveLength(1);
    expect(IMPORTER.match(/^\s+limits,$/gm)).toHaveLength(2);
    // Nothing is inflated anywhere else in the asset pass.
    const assets = IMPORTER.slice(
      IMPORTER.indexOf('// 7b.'),
      IMPORTER.indexOf('// 8. Handle theme')
    );
    expect(assets.match(/inflateAtMost\(/g)).toHaveLength(1);
    expect(IMPORTER).not.toMatch(/\.async\('nodebuffer'\)/);
  });

  test('reads index.html under its ceiling, charged to the same limits', () => {
    expect(IMPORTER).not.toMatch(/\.async\('string'\)/);
    expect(IMPORTER).toContain('indexEntry ? limit => inflateAtMost(indexEntry, limit) : null,');
    // The limits exist before index.html is read, so it is charged to them.
    expect(IMPORTER.indexOf('const limits = new ImportLimits();')).toBeLessThan(
      IMPORTER.indexOf('await readImportIndexHtml(')
    );
  });

  test('writes with putMediaObject and each file’s own options', () => {
    expect(IMPORTER).toContain('ClassmojiService.media.putMediaObject({');
    expect(IMPORTER).toContain('options: importMediaOptions(filename),');
    // Through the gate the size skips use, so a refusal is a named warning.
    expect(IMPORTER).toContain('gate: repoGate,');
  });

  test('a failed import deletes the media it wrote', () => {
    const cleanup = IMPORTER.slice(IMPORTER.indexOf('const cleanupFailedImport'));
    expect(
      cleanup.indexOf('ClassmojiService.media.deleteMedia({ classroom, mediaId })')
    ).toBeGreaterThan(-1);
    // The media writes happen after the slide row exists, inside the block
    // whose catch runs that cleanup — so it covers every one of them.
    const created = IMPORTER.indexOf('getPrisma().slide.create(');
    const guard = IMPORTER.indexOf('try {', created);
    expect(guard).toBeGreaterThan(created);
    expect(IMPORTER.indexOf('await placeImportEntry({')).toBeGreaterThan(guard);
    const catchAll = IMPORTER.indexOf('} catch (importError: unknown) {');
    expect(catchAll).toBeGreaterThan(IMPORTER.indexOf('ContentService.uploadBatch('));
    expect(IMPORTER.slice(catchAll, catchAll + 400)).toContain('await cleanupFailedImport();');
  });

  test('the media goes first, and a failing slide delete cannot strand it', () => {
    const start = IMPORTER.indexOf('const cleanupFailedImport');
    const cleanup = IMPORTER.slice(start, IMPORTER.indexOf('\n  };', start));
    const media = cleanup.indexOf('ClassmojiService.media.deleteMedia(');
    const slide = cleanup.indexOf('getPrisma().slide.delete(');
    expect(media).toBeGreaterThan(-1);
    expect(slide).toBeGreaterThan(media);
    // The slide delete is guarded on its own, so its failure is logged rather
    // than replacing the import's error.
    expect(cleanup.lastIndexOf('try {', slide)).toBeGreaterThan(media);
    expect(cleanup.slice(slide)).toContain('catch (cleanupErr: unknown)');
  });

  test('Cloudinary is gone from the import flow', () => {
    for (const text of [IMPORTER, START, PAGE, PROGRESS]) {
      expect(text).not.toMatch(/cloudinary/i);
    }
    expect(existsSync(path('../../app/components/VideoSelectionModal.tsx'))).toBe(false);
    expect(existsSync(path('../../app/utils/zipAnalyzer.ts'))).toBe(false);
    // Media writes happen inside the processing steps, one entry at a time,
    // so there is no separate step to show.
    expect(PROGRESS).not.toContain('uploading_media');
  });

  test('the rules module stays off the services barrel', () => {
    // The router subpath only — the barrel would pull Prisma and the S3 client.
    expect(RULES).toContain("from '@classmoji/services/media/router'");
    expect(RULES).not.toMatch(/from '@classmoji\/services'/);
  });
});
