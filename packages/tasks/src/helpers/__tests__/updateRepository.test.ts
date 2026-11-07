/**
 * Pulling a template's latest into a student repository's `updates` branch,
 * against real git, on Github and on Gitlab.
 *
 * Every repository is a bare one in a temp directory; `updateRepository`
 * reaches them through git's `url.<base>.insteadOf`, so the code under test
 * still builds its real Github and Gitlab URLs. `@classmoji/services` (the
 * provider APIs) and `@trigger.dev/sdk` are mocked.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { simpleGit, type SimpleGit } from 'simple-git';
import fs from 'fs';
import os from 'os';
import path from 'path';

const octokit = vi.hoisted(() => ({
  rest: {
    repos: { get: vi.fn() },
    pulls: { list: vi.fn(), create: vi.fn(), update: vi.fn() },
  },
}));

const provider = vi.hoisted(() => ({
  getOctokit: vi.fn(),
  getAccessToken: vi.fn(),
  // Gitlab
  getDefaultBranch: vi.fn(),
  findOpenMergeRequest: vi.fn(),
  createPullRequest: vi.fn(),
  updateMergeRequest: vi.fn(),
}));

vi.mock('@trigger.dev/sdk', () => ({
  AbortTaskRunError: class AbortTaskRunError extends Error {},
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  metadata: { set: vi.fn(), flush: vi.fn() },
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    gitlabInstance: {
      defaultHost: () => 'https://gitlab.test',
      assertPublicGitlabHost: vi.fn(),
    },
  },
  getGitProvider: () => provider,
}));

const { branchRef, updateRepository } = await import('../updateRepository.ts');

const TOKEN = 'ghs_test';
/** Several clones, pulls and pushes per test, on a busy machine. */
const TIMEOUT = { timeout: 30_000 };
const ORG = 'uniglos';
const TEMPLATE_OWNER = 'instructor';

type Host = 'github' | 'gitlab';

let root: string;
let originalCwd: () => string;
const savedEnv: Record<string, string | undefined> = {};

const run = (dir: string): SimpleGit => simpleGit(dir);

const commitFile = async (git: SimpleGit, dir: string, name: string, body: string) => {
  fs.writeFileSync(path.join(dir, name), body);
  await git.add('.');
  await git.commit(`add ${name}`);
};

/**
 * A template published as `<host>/<owner>/<repo>` whose default branch is
 * `branch`, and a student repository `<host>/<org>/<repo>` cloned from its
 * first commit, holding one commit of the student's own on `main`. The
 * template then gains `new.txt`, which an update should bring across.
 *
 * `updatesFile`: the student's `main` also holds a top-level file named
 * `updates`, and an earlier update left an `updates` branch on the remote.
 * `updatesBranch`: an earlier update left an `updates` branch on the remote.
 * `updatesTag`: the student's repository also holds a tag named `updates`.
 */
const setUp = async (
  repo: string,
  branch: string,
  {
    host = 'github',
    updatesFile = false,
    updatesBranch = false,
    updatesTag = false,
  }: { host?: Host; updatesFile?: boolean; updatesBranch?: boolean; updatesTag?: boolean } = {}
) => {
  const work = path.join(root, 'work', repo);
  fs.mkdirSync(work, { recursive: true });
  const git = run(work);
  await git.init(['-b', 'main']);
  await git.addConfig('user.name', 'Instructor');
  await git.addConfig('user.email', 'instructor@example.com');
  await commitFile(git, work, 'README.md', 'start\n');

  const studentBare = path.join(root, host, ORG, `${repo}.git`);
  await run(root).clone(work, studentBare, ['--bare']);
  // Gitlab pushes carry `-o ci.skip`.
  await run(studentBare).addConfig('receive.advertisePushOptions', 'true');
  const studentWork = path.join(root, 'work', `${repo}-student`);
  await run(root).clone(studentBare, studentWork);
  const student = run(studentWork);
  await student.addConfig('user.name', 'Student');
  await student.addConfig('user.email', 'student@example.com');
  await commitFile(student, studentWork, 'mine.txt', 'student work\n');
  if (updatesFile) await commitFile(student, studentWork, 'updates', 'notes\n');
  await student.push('origin', 'main');
  if (updatesFile || updatesBranch) await student.push('origin', 'main:refs/heads/updates');
  if (updatesTag) {
    await student.raw(['tag', 'updates']);
    await student.push('origin', 'refs/tags/updates');
  }

  await commitFile(git, work, 'new.txt', 'from the template\n');
  const templateBare = path.join(root, host, TEMPLATE_OWNER, `${repo}.git`);
  fs.mkdirSync(templateBare, { recursive: true });
  await run(templateBare).init(true);
  await git.push(templateBare, `main:${branchRef(branch)}`);
  await run(templateBare).raw(['symbolic-ref', 'HEAD', branchRef(branch)]);

  return { studentBare };
};

const filesOn = async (bare: string, branch: string) =>
  (await run(bare).raw(['ls-tree', '--name-only', '-r', branchRef(branch)]))
    .split('\n')
    .filter(Boolean)
    .sort();

const tagCommit = async (bare: string, tag: string) =>
  (await run(bare).raw(['rev-parse', `refs/tags/${tag}`])).trim();

const lastSubject = async (bare: string, branch: string) =>
  (await run(bare).raw(['log', '-1', '--format=%s', branchRef(branch)])).trim();

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'update-repo-')));
  // Route the token URLs updateRepository builds to the local bare repos,
  // through the global git config of a temporary HOME. Not GIT_CONFIG_* env
  // vars: simple-git (4+) removes every ambient GIT_* variable from the git
  // processes it starts, but leaves HOME and XDG_CONFIG_HOME alone.
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(
    path.join(home, '.gitconfig'),
    `[url "file://${root}/github/"]\n\tinsteadOf = https://x-access-token:${TOKEN}@github.com/\n` +
      `[url "file://${root}/gitlab/"]\n\tinsteadOf = https://oauth2:${TOKEN}@gitlab.test/\n`
  );
  for (const key of ['HOME', 'XDG_CONFIG_HOME']) {
    savedEnv[key] = process.env[key];
  }
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, '.config');
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
  provider.getAccessToken.mockResolvedValue(TOKEN);
  provider.getOctokit.mockResolvedValue(octokit);
  octokit.rest.repos.get.mockResolvedValue({ data: { default_branch: 'main' } });
  octokit.rest.pulls.list.mockResolvedValue({ data: [] });
  octokit.rest.pulls.create.mockResolvedValue({ data: { html_url: 'https://pr' } });
  provider.getDefaultBranch.mockResolvedValue('main');
  provider.findOpenMergeRequest.mockResolvedValue(null);
  provider.createPullRequest.mockResolvedValue({ url: 'https://mr' });
});

const update = (repo: string, host: Host = 'github') =>
  updateRepository({
    gitOrganization: {
      login: ORG,
      provider: host === 'gitlab' ? 'GITLAB' : 'GITHUB',
      base_url: host === 'gitlab' ? 'https://gitlab.test' : null,
    } as never,
    repoName: repo,
    prTitle: 'Template update',
    prDescription: '',
    templateOwner: TEMPLATE_OWNER,
    templateRepo: repo,
  });

describe('branchRef', () => {
  it('qualifies a branch name', () => {
    expect(branchRef('main')).toBe('refs/heads/main');
    expect(branchRef('--release')).toBe('refs/heads/--release');
  });
});

describe('updateRepository', TIMEOUT, () => {
  it("merges the template's default branch into updates", async () => {
    const { studentBare } = await setUp('lab1', 'master');

    const result = await update('lab1');

    expect(result).toMatchObject({ hasChanges: true, prUrl: 'https://pr' });
    expect(await filesOn(studentBare, 'updates')).toEqual(['README.md', 'mine.txt', 'new.txt']);
    expect(await filesOn(studentBare, 'main')).toEqual(['README.md', 'mine.txt']);
    expect(await lastSubject(studentBare, 'updates')).toMatch(/^Merge branch 'master' of /);
  });

  it('merges a default branch whose name begins with --', async () => {
    const { studentBare } = await setUp('lab2', '--release');

    await update('lab2');

    expect(await filesOn(studentBare, 'updates')).toEqual(['README.md', 'mine.txt', 'new.txt']);
    expect(await lastSubject(studentBare, 'updates')).toMatch(/^Merge branch '--release' of /);
  });

  it('checks out an existing updates branch when a top-level file is also named updates', async () => {
    const { studentBare } = await setUp('lab3', 'main', { updatesFile: true });

    await update('lab3');

    expect(await filesOn(studentBare, 'updates')).toEqual([
      'README.md',
      'mine.txt',
      'new.txt',
      'updates',
    ]);
    expect(await lastSubject(studentBare, 'updates')).toMatch(/^Merge branch 'main' of /);
  });
});

describe('updateRepository with a tag named updates', TIMEOUT, () => {
  it('updates the existing updates branch, not the tag', async () => {
    const { studentBare } = await setUp('lab6', 'main', { updatesBranch: true, updatesTag: true });
    const tagBefore = await tagCommit(studentBare, 'updates');

    const result = await update('lab6');

    expect(result).toMatchObject({ hasChanges: true, prUrl: 'https://pr' });
    expect(await filesOn(studentBare, 'updates')).toEqual(['README.md', 'mine.txt', 'new.txt']);
    expect(await lastSubject(studentBare, 'updates')).toMatch(/^Merge branch 'main' of /);
    expect(await tagCommit(studentBare, 'updates')).toBe(tagBefore);
  });

  it('creates the updates branch on a first update', async () => {
    const { studentBare } = await setUp('lab7', 'main', { updatesTag: true });
    const tagBefore = await tagCommit(studentBare, 'updates');

    await update('lab7');

    expect(await filesOn(studentBare, 'updates')).toEqual(['README.md', 'mine.txt', 'new.txt']);
    expect(await tagCommit(studentBare, 'updates')).toBe(tagBefore);
  });

  it('updates the existing updates branch on Gitlab, not the tag', async () => {
    const { studentBare } = await setUp('lab8', 'main', {
      host: 'gitlab',
      updatesBranch: true,
      updatesTag: true,
    });
    const tagBefore = await tagCommit(studentBare, 'updates');

    const result = await update('lab8', 'gitlab');

    expect(result).toMatchObject({ hasChanges: true, prUrl: 'https://mr' });
    expect(await filesOn(studentBare, 'updates')).toEqual(['README.md', 'mine.txt', 'new.txt']);
    expect(await tagCommit(studentBare, 'updates')).toBe(tagBefore);
  });
});

describe('updateRepository on Gitlab', TIMEOUT, () => {
  it('merges a default branch whose name begins with --', async () => {
    const { studentBare } = await setUp('lab4', '--release', { host: 'gitlab' });

    const result = await update('lab4', 'gitlab');

    expect(result).toMatchObject({ hasChanges: true, prUrl: 'https://mr' });
    expect(await filesOn(studentBare, 'updates')).toEqual(['README.md', 'mine.txt', 'new.txt']);
    expect(await lastSubject(studentBare, 'updates')).toMatch(/^Merge branch '--release' of /);
  });

  it('checks out an existing updates branch when a top-level file is also named updates', async () => {
    const { studentBare } = await setUp('lab5', 'main', { host: 'gitlab', updatesFile: true });

    await update('lab5', 'gitlab');

    expect(await filesOn(studentBare, 'updates')).toEqual([
      'README.md',
      'mine.txt',
      'new.txt',
      'updates',
    ]);
  });
});
