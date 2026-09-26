/**
 * The class-to-class import reads each folder file through the Git Blobs API,
 * by the sha its listing carries — so a file over 1 MB is copied rather than
 * skipped — and skips a file over the repository cap, by the listing's size,
 * with a warning naming it instead of reading it.
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
vi.mock('../page.service.ts', () => ({ ensureContentRepo: vi.fn() }));
vi.mock('../contentManifest.service.ts', () => ({ saveManifest: vi.fn() }));

const { collectFolderFiles } = await import('../contentImport.service.ts');

const MB = 1024 * 1024;
const SOURCE = {
  classroomId: 'src',
  gitOrganization: { id: 'o', provider: 'GITHUB', login: 'src-org' },
  login: 'src-org',
  repo: 'content-src',
};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.listFolder.mockImplementation(async ({ path }: { path: string }) =>
    path === 'pages/lab-1'
      ? [
          { name: 'index.html', path: 'pages/lab-1/index.html', type: 'file', sha: 'h', size: 10 },
          { name: 'assets', path: 'pages/lab-1/assets', type: 'dir', sha: 'd' },
        ]
      : [
          {
            name: 'demo.mp4',
            path: 'pages/lab-1/assets/demo.mp4',
            type: 'file',
            sha: 'v',
            size: 5 * MB,
          },
          {
            name: 'raw.mov',
            path: 'pages/lab-1/assets/raw.mov',
            type: 'file',
            sha: 'r',
            size: 40 * MB,
          },
        ]
  );
  mocks.getBlobContent.mockImplementation(async ({ sha }: { sha: string }) => ({
    content: `b64-${sha}`,
    sha,
  }));
});

describe('collectFolderFiles', () => {
  it('reads a file over 1 MB by its sha, and skips one over the cap by name', async () => {
    const warn = vi.fn();

    const files = await collectFolderFiles({
      source: SOURCE as never,
      sourcePath: 'pages/lab-1',
      targetPath: 'pages/lab-1-2',
      scope: 'pages',
      warn,
    });

    expect(files).toEqual([
      { path: 'pages/lab-1-2/index.html', content: 'b64-h', encoding: 'base64' },
      { path: 'pages/lab-1-2/assets/demo.mp4', content: 'b64-v', encoding: 'base64' },
    ]);
    expect(mocks.getBlobContent.mock.calls.map(([args]) => args.sha)).toEqual(['h', 'v']);
    expect(mocks.getBlobContent).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'content-src', sha: 'v', raw: true })
    );
    // No per-file metadata or Contents reads.
    expect(mocks.getMeta).not.toHaveBeenCalled();
    expect(mocks.getContent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'pages',
      'Skipped pages/lab-1/assets/raw.mov (40 MB) — larger than the 35 MB your course repository accepts'
    );
  });

  it('warns and moves on when a blob cannot be read', async () => {
    mocks.getBlobContent.mockImplementation(async ({ sha }: { sha: string }) =>
      sha === 'h' ? null : { content: `b64-${sha}`, sha }
    );
    const warn = vi.fn();

    const files = await collectFolderFiles({
      source: SOURCE as never,
      sourcePath: 'pages/lab-1',
      targetPath: 'pages/lab-1-2',
      scope: 'pages',
      warn,
    });

    expect(files.map(f => f.path)).toEqual(['pages/lab-1-2/assets/demo.mp4']);
    expect(warn).toHaveBeenCalledWith('pages', 'could not read pages/lab-1/index.html');
  });
});
