/**
 * Template files are read through the Git Blobs API by the sha the listing
 * carries — so a file over 1 MB is copied, not skipped — and a file too large
 * for the duplicate's single commit is skipped with a named warning instead of
 * failing the whole template.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listFolder: vi.fn(),
  getBlobContent: vi.fn(),
  getContent: vi.fn(),
  getMeta: vi.fn(),
}));

vi.mock('@classmoji/database', () => ({ default: () => ({}) }));
vi.mock('../../content/ContentService.ts', () => ({
  ContentService: {
    listFolder: (...a: unknown[]) => mocks.listFolder(...a),
    getBlobContent: (...a: unknown[]) => mocks.getBlobContent(...a),
    getContent: (...a: unknown[]) => mocks.getContent(...a),
    getMeta: (...a: unknown[]) => mocks.getMeta(...a),
  },
}));
vi.mock('../../git/index.ts', () => ({ getGitProvider: vi.fn() }));

const { collectTemplateFiles, listRepoFiles, readRepoFiles } =
  await import('../templateImport.service.ts');

const ORG = { provider: 'GITHUB', login: 'org', github_installation_id: '1' };
const MB = 1024 * 1024;

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
});

describe('template file reads', () => {
  it('lists every file with the sha and size the listing reports', async () => {
    mocks.listFolder.mockImplementation(async ({ path }: { path: string }) =>
      path === ''
        ? [
            { name: 'README.md', path: 'README.md', type: 'file', sha: 'a', size: 10 },
            { name: 'data', path: 'data', type: 'dir', sha: 'd' },
          ]
        : [{ name: 'big.csv', path: 'data/big.csv', type: 'file', sha: 'b', size: 4 * MB }]
    );

    const { files, exceededCap } = await listRepoFiles(ORG as never, 'tpl', 200);

    expect(exceededCap).toBe(false);
    expect(files).toEqual([
      { path: 'README.md', sha: 'a', size: 10 },
      { path: 'data/big.csv', sha: 'b', size: 4 * MB },
    ]);
  });

  it('reads a file over 1 MB through the Blobs API, by sha, as base64', async () => {
    mocks.getBlobContent.mockResolvedValue({ content: 'QUJD', sha: 'b' });
    const warn = vi.fn();

    const files = await readRepoFiles({
      gitOrganization: ORG as never,
      repo: 'tpl',
      files: [{ path: 'data/big.csv', sha: 'b', size: 4 * MB }],
      scope: 'org/tpl',
      warn,
    });

    expect(mocks.getBlobContent).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'tpl', sha: 'b', raw: true })
    );
    expect(mocks.getContent).not.toHaveBeenCalled();
    expect(files).toEqual([{ path: 'data/big.csv', content: 'QUJD', encoding: 'base64' }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips a file over the repository cap with a warning naming it, and reads the rest', async () => {
    mocks.getBlobContent.mockResolvedValue({ content: 'eA==', sha: 's' });
    const warn = vi.fn();

    const files = await readRepoFiles({
      gitOrganization: ORG as never,
      repo: 'tpl',
      files: [
        { path: 'video.mp4', sha: 'v', size: 60 * MB },
        { path: 'small.txt', sha: 's', size: 1 },
      ],
      scope: 'org/tpl',
      warn,
    });

    expect(files.map(f => f.path)).toEqual(['small.txt']);
    expect(mocks.getBlobContent).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'org/tpl',
      'Skipped video.mp4 (60 MB) — larger than the 35 MB your course repository accepts'
    );
  });

  it('warns and moves on when a blob cannot be read', async () => {
    mocks.getBlobContent.mockResolvedValue(null);
    const warn = vi.fn();

    const files = await readRepoFiles({
      gitOrganization: ORG as never,
      repo: 'tpl',
      files: [{ path: 'gone.txt', sha: 'x' }],
      scope: 'org/tpl',
      warn,
    });

    expect(files).toEqual([]);
    expect(warn).toHaveBeenCalledWith('org/tpl', 'could not read gone.txt');
  });
});

describe('template total budget', () => {
  const listing = (sizes: number[]) =>
    sizes.map((size, i) => ({
      name: `f${i}.bin`,
      path: `f${i}.bin`,
      type: 'file',
      sha: `s${i}`,
      size,
    }));

  it('skips a template over 200 MB in total with ONE warning, before reading any bytes', async () => {
    // Every file is under the per-file cap; only the sum is too much.
    mocks.listFolder.mockResolvedValue(
      listing([30 * MB, 30 * MB, 30 * MB, 30 * MB, 30 * MB, 30 * MB, 30 * MB])
    );
    const warn = vi.fn();

    const files = await collectTemplateFiles({
      gitOrganization: ORG as never,
      repo: 'tpl',
      scope: 'org/tpl',
      warn,
    });

    expect(files).toBeNull();
    expect(mocks.getBlobContent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'org/tpl',
      'skipped — 210 MB in total, over the 200 MB a template may be'
    );
  });

  it('reads a template exactly at the budget, file by file', async () => {
    // 5 × 35 MB + 25 MB = 200 MB: the cap itself is allowed.
    mocks.listFolder.mockResolvedValue(listing([35, 35, 35, 35, 35, 25].map(n => n * MB)));
    mocks.getBlobContent.mockResolvedValue({ content: 'eA==', sha: 's' });
    const warn = vi.fn();

    const files = await collectTemplateFiles({
      gitOrganization: ORG as never,
      repo: 'tpl',
      scope: 'org/tpl',
      warn,
    });

    expect(files).toHaveLength(6);
    expect(mocks.getBlobContent).toHaveBeenCalledTimes(6);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the file-count cap', async () => {
    mocks.listFolder.mockResolvedValue(listing(new Array(201).fill(1)));
    const warn = vi.fn();

    expect(
      await collectTemplateFiles({ gitOrganization: ORG as never, repo: 'tpl', scope: 's', warn })
    ).toBeNull();
    expect(warn).toHaveBeenCalledWith('s', 'skipped — more than 200 files');
    expect(mocks.getBlobContent).not.toHaveBeenCalled();
  });

  it('returns the read files for a template inside every limit', async () => {
    mocks.listFolder.mockResolvedValue(listing([10, 20]));
    mocks.getBlobContent.mockResolvedValue({ content: 'eA==', sha: 's' });
    const warn = vi.fn();

    const files = await collectTemplateFiles({
      gitOrganization: ORG as never,
      repo: 'tpl',
      scope: 's',
      warn,
    });

    expect(files?.map(f => f.path)).toEqual(['f0.bin', 'f1.bin']);
    expect(warn).not.toHaveBeenCalled();
  });
});
