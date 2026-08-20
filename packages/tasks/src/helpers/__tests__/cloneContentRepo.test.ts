/**
 * Unit tests for cloneContentRepo's classification of a failed source clone.
 *
 * Focus: "the source repo is not there" must NOT fail the import. A classroom
 * carries a content repo NAME from the moment it is created (the column is NOT
 * NULL) while the repo itself is only created on the first content write, so a
 * source that never had a page or deck clones a repo that does not exist. That
 * used to throw and fail the whole content phase, leaving an import the user
 * could only retry into the same error (prod run 06g1u10i, 2026-08-20).
 *
 * The classification is a regex over git's stderr, so it is pinned in both
 * directions: not-found is absorbed, everything else still throws — and still
 * throws with the installation token stripped out.
 *
 * `simple-git`, `@trigger.dev/sdk` and `@classmoji/services` are mocked — no
 * network, no git, no filesystem (every case here returns before the working
 * directory is touched).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clone: vi.fn(),
}));

vi.mock('simple-git', () => ({
  simpleGit: () => ({ clone: (...a: unknown[]) => mocks.clone(...a) }),
}));

vi.mock('@trigger.dev/sdk', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: { contentImport: { rewriteContentUrls: vi.fn(), isTextContentPath: vi.fn() } },
  // The real one strips `x-access-token:<token>@`; that behavior is covered in
  // services. Here it only has to prove gitFailure routes the text through it.
  redactAccessTokens: (text: string) =>
    text.replace(/x-access-token:[^@]+@/g, 'x-access-token:***@'),
}));

const { cloneContentRepo } = await import('../cloneContentRepo.ts');

const SOURCE = { orgLogin: 'uniglos', repo: 'content-game-technologies-2025-26', token: 'ghs_src' };
const TARGET = { orgLogin: 'uniglos', repo: 'content-games-technologies-26-27', token: 'ghs_tgt' };

const clone = () =>
  cloneContentRepo({
    source: SOURCE,
    target: TARGET,
    keepPages: true,
    keepSlides: true,
    commitMessage: 'Import content from content-game-technologies-2025-26',
  });

/** git prints both lines for one missing repo; either alone must still match. */
const SERVER_LINE = 'remote: Repository not found.';
const CLIENT_LINE = `fatal: repository 'https://x-access-token:ghs_src@github.com/${SOURCE.orgLogin}/${SOURCE.repo}.git/' not found`;

describe('cloneContentRepo — source repo that is not there', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('absorbs a missing source repo instead of failing the import', async () => {
    mocks.clone.mockRejectedValue(
      new Error(`Cloning into '/app/repos/x'...\n${SERVER_LINE}\n${CLIENT_LINE}\n`)
    );

    await expect(clone()).resolves.toEqual({
      pushed: false,
      rewritten: 0,
      files: 0,
      skipped: 'missing',
    });
  });

  it.each([
    ['the server line alone', SERVER_LINE],
    ['the client line alone', CLIENT_LINE],
  ])('recognizes %s', async (_label, message) => {
    mocks.clone.mockRejectedValue(new Error(message));

    await expect(clone()).resolves.toMatchObject({ pushed: false, skipped: 'missing' });
  });

  it.each([
    ['auth failure', 'fatal: Authentication failed for https://github.com/uniglos/x.git/'],
    ['network failure', 'fatal: unable to access: Could not resolve host: github.com'],
    ['a bare not-found that is not about a repository', 'fatal: pathspec main not found'],
  ])('still throws on %s', async (_label, message) => {
    mocks.clone.mockRejectedValue(new Error(message));

    await expect(clone()).rejects.toThrow(/cloning uniglos\//);
  });

  it('strips the installation token out of a thrown clone failure', async () => {
    mocks.clone.mockRejectedValue(
      new Error(
        "fatal: Authentication failed for 'https://x-access-token:ghs_src@github.com/o/r.git/'"
      )
    );

    await expect(clone()).rejects.toThrow(/x-access-token:\*\*\*@/);
    await expect(clone()).rejects.not.toThrow(/ghs_src/);
  });
});
