import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  GitCommandError,
  bareRepo,
  commitFilesToRemote,
  isNonFastForward,
  redactGitSecrets,
} from '../gitCheckpoint.ts';

const ID = { name: 'Classmoji Test', email: 'test@example.invalid' };
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: ID.name,
  GIT_AUTHOR_EMAIL: ID.email,
  GIT_COMMITTER_NAME: ID.name,
  GIT_COMMITTER_EMAIL: ID.email,
};

const sh = (args: string[], cwd?: string) =>
  execFileSync('git', args, { cwd, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();

/** ~40 KB of text per seeded file, so a thin pack would have real delta bases. */
const bigText = (label: string) =>
  Array.from({ length: 800 }, (_, i) => `${label} line ${i} lorem ipsum dolor sit amet`).join('\n');

let root: string;
let remote: string;
let remoteUrl: string;
let work: string;

function seed() {
  remote = path.join(root, 'remote.git');
  sh(['init', '--bare', '-b', 'main', remote]);
  // file:// partial clones need the server to allow filters, and lazy fetches
  // (the positive control) need it to serve any sha asked for.
  sh(['--git-dir', remote, 'config', 'uploadpack.allowFilter', 'true']);
  sh(['--git-dir', remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true']);
  remoteUrl = `file://${remote}`;

  work = path.join(root, 'work');
  sh(['clone', remoteUrl, work]);
  sh(['checkout', '-b', 'main'], work);
  mkdirSync(path.join(work, 'pages', 'intro'), { recursive: true });
  mkdirSync(path.join(work, 'pages', 'lab-1', 'assets'), { recursive: true });
  mkdirSync(path.join(work, 'slides', 'week-1'), { recursive: true });
  writeFileSync(path.join(work, 'README.md'), '# content\n');
  writeFileSync(path.join(work, 'pages', 'intro', 'content.json'), bigText('intro'));
  writeFileSync(path.join(work, 'pages', 'lab-1', 'content.json'), bigText('lab'));
  writeFileSync(path.join(work, 'pages', 'lab-1', 'assets', 'a.txt'), bigText('asset'));
  writeFileSync(path.join(work, 'slides', 'week-1', 'deck.json'), bigText('deck'));
  writeFileSync(path.join(work, 'slides', 'week-1', 'index.html'), bigText('html'));
  writeFileSync(path.join(work, 'run.sh'), '#!/bin/sh\necho hi\n');
  chmodSync(path.join(work, 'run.sh'), 0o755);
  sh(['add', '-A'], work);
  sh(['commit', '-m', 'seed'], work);
  sh(['push', 'origin', 'main'], work);
}

/** Push an unrelated commit to the remote from the working clone. */
function pushOutside(file: string, content: string) {
  sh(['pull', '--ff-only', 'origin', 'main'], work);
  const full = path.join(work, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  sh(['add', '-A'], work);
  sh(['commit', '-m', `outside ${file}`], work);
  sh(['push', 'origin', 'main'], work);
}

const remoteHead = () => sh(['--git-dir', remote, 'rev-parse', 'refs/heads/main']);
const remoteFile = (p: string, ref = 'main') => sh(['--git-dir', remote, 'show', `${ref}:${p}`]);
const remoteMode = (p: string) => sh(['--git-dir', remote, 'ls-tree', 'main', p]).split(' ')[0];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'gitcheckpoint-test-'));
  seed();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('commitFilesToRemote', () => {
  it('writes several files across paths in one commit, keeping every other file', async () => {
    const before = remoteHead();
    const result = await commitFilesToRemote({
      remoteUrl,
      files: [
        { path: 'pages/intro/content.json', content: '{"blocks":[]}' },
        { path: 'slides/week-1/deck.json', content: '{"version":1}\n' },
        { path: 'slides/week-1/index.html', content: '<html></html>' },
        { path: 'pages/new-page/content.json', content: '{"blocks":[1]}' },
      ],
      message: 'Update Intro, Week 1 (live editing)\n\nClassmoji-Collab: run_1\n',
      author: ID,
    });

    expect(result.pushed).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.branch).toBe('main');
    expect(result.parent).toBe(before);
    expect(remoteHead()).toBe(result.commit);
    expect(sh(['--git-dir', remote, 'rev-parse', `${result.commit}^`])).toBe(before);
    // One commit, its message intact.
    expect(sh(['--git-dir', remote, 'log', '-1', '--format=%B', 'main'])).toBe(
      'Update Intro, Week 1 (live editing)\n\nClassmoji-Collab: run_1'
    );

    expect(remoteFile('pages/intro/content.json')).toBe('{"blocks":[]}');
    expect(remoteFile('pages/new-page/content.json')).toBe('{"blocks":[1]}');
    expect(remoteFile('slides/week-1/index.html')).toBe('<html></html>');
    // Untouched files survive byte-for-byte.
    expect(remoteFile('pages/lab-1/content.json')).toBe(bigText('lab'));
    expect(remoteFile('pages/lab-1/assets/a.txt')).toBe(bigText('asset'));
    expect(remoteFile('README.md')).toBe('# content');
    expect(remoteMode('run.sh')).toBe('100755');

    // Blob shas are git's (== the Contents API file sha).
    expect(result.blobShas['pages/intro/content.json']).toBe(
      sh(['--git-dir', remote, 'rev-parse', 'main:pages/intro/content.json'])
    );
    expect(Object.keys(result.blobShas)).toHaveLength(4);
  });

  it('downloads no existing file contents while building and pushing', async () => {
    const result = await commitFilesToRemote({
      remoteUrl,
      files: [
        { path: 'pages/intro/content.json', content: bigText('intro') + '\nedited' },
        { path: 'slides/week-1/deck.json', content: bigText('deck') + '\nedited' },
      ],
      message: 'm\n',
      author: ID,
    });
    expect(result.pushed).toBe(true);
    expect(result.lazyFetches).toBe(0);
  });

  it('positive control: reading a blob in such a clone DOES add a promisor pack', async () => {
    const gitDir = path.join(root, 'probe.git');
    sh(['clone', '--depth', '1', '--filter=blob:none', '--bare', remoteUrl, gitDir]);
    const repo = bareRepo(gitDir, ENV);
    const before = await repo.packCount();
    const blob = await repo.gitStr(['rev-parse', 'HEAD:pages/intro/content.json']);
    await repo.git(['cat-file', '-p', blob]);
    expect(await repo.packCount()).toBeGreaterThan(before);
    // And the clone itself held no blobs: the tree lists them, the pack lacks them.
    const packs = readdirSync(path.join(gitDir, 'objects', 'pack')).filter(f =>
      f.endsWith('.pack')
    );
    expect(packs.length).toBeGreaterThan(1);
  });

  it('rebuilds on the new head when the push is rejected, without losing the outside commit', async () => {
    const result = await commitFilesToRemote({
      remoteUrl,
      files: [{ path: 'pages/intro/content.json', content: 'ours' }],
      message: 'ours\n',
      author: ID,
      beforePush: async ({ attempt }) => {
        // A teacher's asset upload lands between our build and our push.
        if (attempt === 1) pushOutside('pages/lab-1/assets/b.txt', 'uploaded');
      },
    });

    expect(result.pushed).toBe(true);
    expect(result.attempts).toBe(2);
    expect(remoteHead()).toBe(result.commit);
    expect(remoteFile('pages/intro/content.json')).toBe('ours');
    expect(remoteFile('pages/lab-1/assets/b.txt')).toBe('uploaded');
    // Built on the outside commit, never forced over it.
    expect(sh(['--git-dir', remote, 'log', '-1', '--format=%s', `${result.commit}^`])).toBe(
      'outside pages/lab-1/assets/b.txt'
    );
    expect(result.lazyFetches).toBe(0);
  });

  it('gives up after maxAttempts rejections and leaves the remote as the others left it', async () => {
    let n = 0;
    const attempt = commitFilesToRemote({
      remoteUrl,
      files: [{ path: 'pages/intro/content.json', content: 'ours' }],
      message: 'ours\n',
      author: ID,
      beforePush: async () => {
        pushOutside(`noise/${n++}.txt`, 'x');
      },
    });
    await expect(attempt).rejects.toSatisfy(isNonFastForward);
    expect(n).toBe(3);
    expect(remoteFile('pages/intro/content.json')).toBe(bigText('intro'));
    expect(remoteFile('noise/2.txt')).toBe('x');
  });

  it('pushes nothing when every file already has these bytes', async () => {
    const before = remoteHead();
    const result = await commitFilesToRemote({
      remoteUrl,
      files: [{ path: 'pages/intro/content.json', content: bigText('intro') }],
      message: 'noop\n',
      author: ID,
    });
    expect(result.pushed).toBe(false);
    expect(result.attempts).toBe(0);
    expect(result.commit).toBe(before);
    expect(remoteHead()).toBe(before);
    expect(result.blobShas['pages/intro/content.json']).toBe(
      sh(['--git-dir', remote, 'rev-parse', 'main:pages/intro/content.json'])
    );
  });

  it('refuses unsafe or conflicting paths before touching git', async () => {
    for (const bad of ['/abs', '../x', 'a//b', '.git/config', 'a/./b', '']) {
      await expect(
        commitFilesToRemote({
          remoteUrl,
          files: [{ path: bad, content: 'x' }],
          message: 'm',
          author: ID,
        })
      ).rejects.toThrow(/Invalid repo path/);
    }
    await expect(
      commitFilesToRemote({
        remoteUrl,
        files: [
          { path: 'a/b', content: 'x' },
          { path: 'a/b/c', content: 'y' },
        ],
        message: 'm',
        author: ID,
      })
    ).rejects.toThrow(/Path conflict/);
    await expect(
      commitFilesToRemote({
        remoteUrl,
        files: [{ path: 'pages/intro', content: 'x' }],
        message: 'm',
        author: ID,
      })
    ).rejects.toThrow(/Cannot replace directory/);
  });

  it('never leaks the token in a clone error', async () => {
    const error = await commitFilesToRemote({
      remoteUrl: 'https://x-access-token:ghs_SuperSecret123@127.0.0.1:9/org/repo.git',
      files: [{ path: 'a.txt', content: 'x' }],
      message: 'm',
      author: ID,
    }).catch(e => e);
    expect(error).toBeInstanceOf(GitCommandError);
    expect(String(error.message)).not.toContain('SuperSecret');
    expect(JSON.stringify(error.args)).not.toContain('SuperSecret');
    expect(error.stderr).not.toContain('SuperSecret');
  });
});

describe('redactGitSecrets', () => {
  it('masks userinfo and bare GitHub tokens', () => {
    expect(redactGitSecrets('https://x-access-token:abc@github.com/o/r.git')).toBe(
      'https://***@github.com/o/r.git'
    );
    expect(redactGitSecrets('token ghs_abcDEF123 here')).toBe('token ghs_*** here');
  });
});
