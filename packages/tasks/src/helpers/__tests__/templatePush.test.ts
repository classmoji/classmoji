/**
 * Copying a template into a student repository, against real git.
 *
 * Production runs for very large templates (Unreal projects) failed with
 * "RPC failed; curl 55" because the whole history went up as one push past
 * Github's 2 GB limit. A big template is now pushed along its history in parts
 * under a byte budget, and a run stopped between parts is resumed instead of
 * being mistaken for a repository with student work in it.
 *
 * Every repository here is a local one in a temp directory; `createRepository`
 * reaches them through git's `url.<base>.insteadOf`, so the code under test
 * still builds its real Github URLs. `@classmoji/services` (the Github API) and
 * `@trigger.dev/sdk` are mocked.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { simpleGit, type SimpleGit } from 'simple-git';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const provider = vi.hoisted(() => ({
  createRepository: vi.fn(),
  getRepository: vi.fn(),
  createPullRequest: vi.fn(),
  protectBranch: vi.fn(),
}));

vi.mock('@trigger.dev/sdk', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@classmoji/services', () => ({
  CLASSMOJI_BOT_EMAIL: 'bot@classmoji.test',
  getGitProvider: () => provider,
  redactAccessTokens: (text: string) => text,
}));

const { createRepository } = await import('../createRepository.ts');
const { isAncestor, parseRemoteHeads, pushBranchInChunks, usesLfs } =
  await import('../templatePush.ts');

const TOKEN = 'ghs_test';
const ORG = 'uniglos';

let root: string;
let originalCwd: () => string;
const savedEnv: Record<string, string | undefined> = {};

const run = (dir: string): SimpleGit => simpleGit(dir);

/** A non-bare repo with one commit per entry, each adding `bytes` of noise. */
const makeTemplate = async (name: string, commitSizes: number[], extra?: (dir: string) => void) => {
  const dir = path.join(root, 'work', name);
  fs.mkdirSync(path.join(dir, 'Content'), { recursive: true });
  const git = run(dir);
  await git.init(['-b', 'master']);
  await git.addConfig('user.name', 'Instructor');
  await git.addConfig('user.email', 'instructor@example.com');
  extra?.(dir);
  for (const [i, bytes] of commitSizes.entries()) {
    // Random bytes do not compress, so each commit's size on disk is ~bytes.
    fs.writeFileSync(path.join(dir, 'Content', `asset${i}.uasset`), crypto.randomBytes(bytes));
    await git.add('.');
    await git.commit(`asset ${i}`);
  }
  // Packed, as a clone from Github would be.
  await git.raw(['gc', '-q']);
  return { dir, git };
};

/** Publish a template as `github.com/<owner>/<repo>` (a bare repo). */
const publish = async (dir: string, owner: string, repo: string) => {
  const bare = path.join(root, 'github', owner, `${repo}.git`);
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  await run(root).clone(dir, bare, ['--bare']);
  return bare;
};

/** An empty `github.com/<org>/<repo>`, as `POST /orgs/{org}/repos` leaves it. */
const emptyStudentRepo = async (repo: string) => {
  const bare = path.join(root, 'github', ORG, `${repo}.git`);
  fs.mkdirSync(bare, { recursive: true });
  await run(bare).init(true);
  return bare;
};

const remoteHeads = async (bare: string) =>
  parseRemoteHeads(await run(root).listRemote(['--heads', bare]));

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'template-push-')));
  // Route the token URLs createRepository builds to the local bare repos.
  for (const key of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) {
    savedEnv[key] = process.env[key];
  }
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = `url.file://${root}/github/.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = `https://x-access-token:${TOKEN}@github.com/`;
  originalCwd = process.cwd;
  process.cwd = () => root;
});

afterAll(() => {
  process.cwd = originalCwd;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  provider.createRepository.mockResolvedValue({ id: '42' });
  provider.getRepository.mockResolvedValue({ id: '42' });
  provider.createPullRequest.mockResolvedValue({ id: 1, number: 1, url: '' });
});

describe('parseRemoteHeads', () => {
  it('reads branch names and commits from ls-remote output', () => {
    const heads = parseRemoteHeads(
      'aaa\trefs/heads/main\nbbb\trefs/heads/feedback\nccc\trefs/tags/v1\n'
    );
    expect([...heads]).toEqual([
      ['main', 'aaa'],
      ['feedback', 'bbb'],
    ]);
    expect(parseRemoteHeads('').size).toBe(0);
  });
});

describe('pushBranchInChunks', () => {
  it('pushes a template under the budget in one push', async () => {
    const { git } = await makeTemplate('small', [1000, 1000]);
    const bare = await emptyStudentRepo('small-target');
    await git.branch(['-M', 'main']);

    const pushes = await pushBranchInChunks(git, { remote: bare, branch: 'main' });

    expect(pushes).toBe(1);
    expect((await remoteHeads(bare)).get('main')).toBe((await git.revparse(['main'])).trim());
  });

  it('pushes a template over the budget in parts, each under it', async () => {
    const { git } = await makeTemplate('big', [40_000, 40_000, 40_000, 40_000, 40_000]);
    const bare = await emptyStudentRepo('big-target');
    await git.branch(['-M', 'main']);
    const pushSpy = vi.spyOn(git, 'push');

    // Two 40 KB commits fit in 100 KB, three do not.
    const pushes = await pushBranchInChunks(git, {
      remote: bare,
      branch: 'main',
      budgetBytes: 100_000,
    });

    expect(pushes).toBe(3);
    const commits = (await git.raw(['rev-list', '--reverse', 'main'])).trim().split('\n');
    expect(pushSpy.mock.calls.map(call => (call as unknown[])[1])).toEqual([
      `+${commits[1]}:refs/heads/main`,
      `+${commits[3]}:refs/heads/main`,
      'main',
    ]);
    expect((await remoteHeads(bare)).get('main')).toBe(commits[4]);
  });

  it('pushes a single commit bigger than the budget on its own', async () => {
    const { git } = await makeTemplate('one-huge', [10_000, 300_000, 10_000]);
    const bare = await emptyStudentRepo('one-huge-target');
    await git.branch(['-M', 'main']);

    const pushes = await pushBranchInChunks(git, {
      remote: bare,
      branch: 'main',
      budgetBytes: 100_000,
    });

    expect(pushes).toBe(3);
    expect((await remoteHeads(bare)).get('main')).toBe((await git.revparse(['main'])).trim());
  });

  it('continues from the part a stopped run already pushed', async () => {
    const { git } = await makeTemplate('resume', [40_000, 40_000, 40_000, 40_000]);
    const bare = await emptyStudentRepo('resume-target');
    await git.branch(['-M', 'main']);
    const commits = (await git.raw(['rev-list', '--reverse', 'main'])).trim().split('\n');
    await git.push(bare, `+${commits[1]}:refs/heads/main`);

    const pushes = await pushBranchInChunks(git, {
      remote: bare,
      branch: 'main',
      budgetBytes: 100_000,
      alreadyPushed: commits[1],
    });

    expect(pushes).toBe(1);
    expect((await remoteHeads(bare)).get('main')).toBe(commits[3]);
  });
});

describe('isAncestor', () => {
  it('is true for the branch and its history, false otherwise', async () => {
    const { git } = await makeTemplate('ancestry', [10, 10]);
    const [first, second] = (await git.raw(['rev-list', '--reverse', 'master'])).trim().split('\n');

    expect(await isAncestor(git, first, 'master')).toBe(true);
    expect(await isAncestor(git, second, 'master')).toBe(true);
    await git.checkout(['-b', 'other', first]);
    await git.commit('student work', undefined, { '--allow-empty': null });
    const other = (await git.revparse(['other'])).trim();
    expect(await isAncestor(git, other, 'master')).toBe(false);
    expect(await isAncestor(git, 'f'.repeat(40), 'master')).toBe(false);
  });
});

describe('usesLfs', () => {
  it('reads the root .gitattributes', async () => {
    const lfs = await makeTemplate('lfs', [10], dir =>
      fs.writeFileSync(
        path.join(dir, '.gitattributes'),
        '*.uasset filter=lfs diff=lfs merge=lfs -text\n'
      )
    );
    const plain = await makeTemplate('plain', [10]);

    expect(await usesLfs(lfs.git)).toBe(true);
    expect(await usesLfs(plain.git)).toBe(false);
  });
});

describe('createRepository', () => {
  const create = (repoName: string, templateRepo: string) =>
    createRepository({
      classroom: { git_organization: { login: ORG, provider: 'GITHUB' } as never },
      repoName,
      templateOwner: 'instructor',
      templateRepo,
      token: TOKEN,
      organizationGithubPlan: 'team',
    });

  it('copies the template and sets up main, feedback and updates', async () => {
    const { dir, git } = await makeTemplate('lab', [1000, 1000]);
    await publish(dir, 'instructor', 'lab');
    const target = await emptyStudentRepo('lab-ada');

    await expect(create('lab-ada', 'lab')).resolves.toBe('42');

    const heads = await remoteHeads(target);
    expect([...heads.keys()].sort()).toEqual(['feedback', 'main', 'updates']);
    const templateTip = (await git.revparse(['master'])).trim();
    expect(heads.get('feedback')).toBe(templateTip);
    const remote = run(target);
    expect((await remote.raw(['rev-parse', 'main^'])).trim()).toBe(templateTip);
    // The whole tree, not just the top-level files the sparse clone checked out.
    expect(await remote.raw(['ls-tree', '-r', '--name-only', 'main'])).toContain(
      'Content/asset1.uasset'
    );
    expect(provider.createPullRequest).toHaveBeenCalledWith(
      ORG,
      'lab-ada',
      'feedback',
      'main',
      'Feedback',
      expect.any(String)
    );
    expect(provider.protectBranch).toHaveBeenCalledWith(ORG, 'lab-ada', 'updates');
    expect(fs.existsSync(path.join(root, 'repos', 'lab-ada'))).toBe(false);
  });

  it('finishes a copy that stopped partway through the template history', async () => {
    const { dir, git } = await makeTemplate('lyra', [1000, 1000, 1000]);
    await publish(dir, 'instructor', 'lyra');
    const target = await emptyStudentRepo('lyra-kaz');
    const first = (await git.raw(['rev-list', '--reverse', 'master'])).trim().split('\n')[0];
    await git.push(target, `+${first}:refs/heads/main`);

    await create('lyra-kaz', 'lyra');

    const heads = await remoteHeads(target);
    expect([...heads.keys()].sort()).toEqual(['feedback', 'main', 'updates']);
    expect(heads.get('feedback')).toBe((await git.revparse(['master'])).trim());
  });

  it('leaves a main branch that is not the template alone', async () => {
    const { dir } = await makeTemplate('essay', [1000]);
    await publish(dir, 'instructor', 'essay');
    const target = await emptyStudentRepo('essay-bo');
    const other = await makeTemplate('student-work', [500]);
    await other.git.push(target, '+master:refs/heads/main');
    const before = await remoteHeads(target);

    await create('essay-bo', 'essay');

    expect(await remoteHeads(target)).toEqual(before);
    expect(provider.createPullRequest).not.toHaveBeenCalled();
  });

  it('leaves a repository with more than a main branch alone', async () => {
    const { dir, git } = await makeTemplate('quiz', [1000]);
    await publish(dir, 'instructor', 'quiz');
    const target = await emptyStudentRepo('quiz-cy');
    await git.push(target, '+master:refs/heads/main');
    await git.push(target, '+master:refs/heads/feedback');
    const before = await remoteHeads(target);

    await create('quiz-cy', 'quiz');

    expect(await remoteHeads(target)).toEqual(before);
    expect(provider.createPullRequest).not.toHaveBeenCalled();
  });
});
