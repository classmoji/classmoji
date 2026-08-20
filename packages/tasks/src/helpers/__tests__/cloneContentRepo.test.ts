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
import fs from 'fs';

const mocks = vi.hoisted(() => ({
  clone: vi.fn(),
  raw: vi.fn(),
}));

vi.mock('simple-git', () => ({
  simpleGit: () => ({
    clone: (...a: unknown[]) => mocks.clone(...a),
    raw: (...a: unknown[]) => mocks.raw(...a),
  }),
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

  /**
   * Pins WHAT is cloned, not just how failure is classified. Without this the
   * suite stays green if the SOURCE url is swapped for the target's — and that
   * mutation is quietly catastrophic rather than loud: the target was just
   * auto-init'd with a README, so cloning it succeeds, pushes the README back,
   * and returns pushed:true. Every page and slide row is then created against
   * content paths that do not exist, and the instructor is told it worked.
   * Also pins --depth 1: a full-history clone of an 800MB content repo is the
   * difference between a minute and a timeout.
   */
  it('clones the SOURCE repo, shallow', async () => {
    mocks.clone.mockRejectedValue(new Error(SERVER_LINE));

    await clone();

    expect(mocks.clone).toHaveBeenCalledWith(
      `https://x-access-token:${SOURCE.token}@github.com/${SOURCE.orgLogin}/${SOURCE.repo}.git`,
      expect.any(String),
      ['--depth', '1']
    );
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

/**
 * The other two ways a copy ends up empty. Each reason reaches the caller and
 * becomes a different sentence in the instructor's banner, so a return path
 * that dropped or mislabeled its reason would state something confidently
 * false — 'pruned' silently reported as 'empty' tells the user to go look at
 * the source classroom when the cause was their own pages/slides selection.
 *
 * These drive the real filesystem branch, so `clone` creates its directory the
 * way a real clone does; the helper's `finally` removes it.
 */
describe('cloneContentRepo — the other empty outcomes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clone.mockImplementation(async (_url: string, dir: string) => {
      fs.mkdirSync(dir, { recursive: true });
    });
  });

  it('reports a source repo with no commits as empty', async () => {
    // `rev-parse --verify HEAD` is what fails on a repo with no commits.
    mocks.raw.mockRejectedValue(new Error("fatal: Needed a single revision'"));

    await expect(clone()).resolves.toEqual({
      pushed: false,
      rewritten: 0,
      files: 0,
      skipped: 'empty',
    });
  });

  it('reports an all-pruned tree as pruned, not empty', async () => {
    mocks.raw.mockResolvedValue('abc123'); // HEAD exists — the repo has commits.

    // The cloned tree holds nothing the selection keeps, so pruning empties it.
    await expect(clone()).resolves.toEqual({
      pushed: false,
      rewritten: 0,
      files: 0,
      skipped: 'pruned',
    });
  });

  it('leaves no working directory behind', async () => {
    mocks.raw.mockResolvedValue('abc123');

    await clone();

    const dir = mocks.clone.mock.calls[0][1] as string;
    expect(fs.existsSync(dir)).toBe(false);
  });
});
