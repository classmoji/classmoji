import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  GitCommandError,
  bareRepo,
  commitFilesToRemote,
  isNonFastForward,
  isRepoNotFound,
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

// ─── Smart HTTP: where `--no-thin` is silently dropped ───────────────────────

/**
 * A minimal smart-HTTP git server: node in front of `git http-backend` (CGI),
 * serving every bare repo under `projectRoot`. Enough for clone, fetch
 * (filters + lazy fetches) and push. In its OWN process: the tests drive git
 * synchronously, which would block a server living on this event loop.
 */
const GIT_HTTP_SERVER = `
const { spawn } = require('node:child_process');
const http = require('node:http');
const [backend, projectRoot, requiredAuth] = process.argv.slice(1);
const server = http.createServer((req, res) => {
  if (requiredAuth && req.headers.authorization !== requiredAuth) {
    res.statusCode = 401;
    res.setHeader('WWW-Authenticate', 'Basic realm="git"');
    res.end('auth required');
    return;
  }
  const url = new URL(req.url || '/', 'http://localhost');
  const child = spawn(backend, [], { env: { ...process.env,
    GIT_PROJECT_ROOT: projectRoot, GIT_HTTP_EXPORT_ALL: '1',
    REQUEST_METHOD: req.method || 'GET', PATH_INFO: decodeURIComponent(url.pathname),
    QUERY_STRING: url.search.slice(1), CONTENT_TYPE: req.headers['content-type'] || '',
    HTTP_CONTENT_ENCODING: String(req.headers['content-encoding'] || ''),
    GIT_PROTOCOL: String(req.headers['git-protocol'] || ''), REMOTE_ADDR: '127.0.0.1' } });
  req.pipe(child.stdin);
  let head = Buffer.alloc(0); let done = false;
  child.stdout.on('data', chunk => {
    if (done) { res.write(chunk); return; }
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf('\\r\\n\\r\\n');
    if (end < 0) return;
    done = true;
    for (const line of head.subarray(0, end).toString().split('\\r\\n')) {
      const i = line.indexOf(':'); const name = line.slice(0, i).trim(); const value = line.slice(i + 1).trim();
      if (name.toLowerCase() === 'status') res.statusCode = Number(value.split(' ')[0]);
      else res.setHeader(name, value);
    }
    res.write(head.subarray(end + 4));
  });
  child.stdout.on('end', () => res.end());
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
`;

function startGitHttp(
  projectRoot: string,
  requiredAuth = ''
): Promise<{ child: ChildProcess; base: string }> {
  const backend = path.join(sh(['--exec-path']), 'git-http-backend');
  const child = spawn(
    process.execPath,
    ['-e', GIT_HTTP_SERVER, backend, projectRoot, requiredAuth],
    {
      env: ENV,
      stdio: ['ignore', 'pipe', 'inherit'],
    }
  );
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout?.once('data', (d: Buffer) =>
      resolve({ child, base: `http://127.0.0.1:${d.toString().trim()}` })
    );
  });
}

const AUTH = { username: 'x-access-token', password: 'ghs_TestToken123' };

describe('commitFilesToRemote over smart HTTP', () => {
  let server: ChildProcess;
  let httpUrl: string;

  beforeEach(async () => {
    // Anonymous pushes over HTTP need receive-pack switched on.
    sh(['--git-dir', remote, 'config', 'http.receivepack', 'true']);
    const started = await startGitHttp(
      root,
      `Basic ${Buffer.from('x-access-token:ghs_TestToken123').toString('base64')}`
    );
    server = started.child;
    httpUrl = `${started.base}/remote.git`;
  });

  afterEach(() => {
    // Only the server this test started, by its own handle.
    server.kill();
  });

  it('positive control: a plain `push --no-thin` over HTTP DOES fetch the old blobs', async () => {
    const gitDir = path.join(root, 'probe.git');
    const authEnv = {
      ...ENV,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from('x-access-token:ghs_TestToken123').toString('base64')}`,
    };
    execFileSync(
      'git',
      ['clone', '--depth', '1', '--filter=blob:none', '--bare', httpUrl, gitDir],
      {
        env: authEnv,
        stdio: 'pipe',
      }
    );
    const repo = bareRepo(gitDir, authEnv);
    const blob = await repo.gitStr(['hash-object', '-w', '--stdin'], bigText('intro') + '\nedit');
    const tree = await repo.applyChanges(
      await repo.gitStr(['rev-parse', 'HEAD^{tree}']),
      new Map([['pages', new Map([['intro', new Map([['content.json', blob]])]])]])
    );
    const commit = await repo.gitStr(['commit-tree', tree, '-p', 'HEAD'], 'probe\n');
    const before = await repo.packCount();
    await repo.git(['push', '--no-thin', 'origin', `${commit}:refs/heads/main`]);
    // The helper dropped --no-thin, so pack-objects faulted the base blob in.
    expect(await repo.packCount()).toBeGreaterThan(before);
  });

  it('pushes edits to existing files without fetching any old content', async () => {
    const result = await commitFilesToRemote({
      remoteUrl: httpUrl,
      auth: AUTH,
      files: [
        { path: 'pages/intro/content.json', content: bigText('intro') + '\nedited' },
        { path: 'slides/week-1/index.html', content: bigText('html') + '\nedited' },
      ],
      message: 'over http\n',
      author: ID,
    });
    expect(result.pushed).toBe(true);
    expect(result.lazyFetches).toBe(0);
    expect(remoteFile('pages/intro/content.json')).toBe(bigText('intro') + '\nedited');
    expect(remoteFile('pages/lab-1/content.json')).toBe(bigText('lab'));
  });

  it('rebuilds after a rejection over HTTP (promisor config restored for the fetch)', async () => {
    const result = await commitFilesToRemote({
      remoteUrl: httpUrl,
      auth: AUTH,
      files: [{ path: 'pages/intro/content.json', content: bigText('intro') + '\nours' }],
      message: 'ours\n',
      author: ID,
      beforePush: async ({ attempt }) => {
        if (attempt === 1) pushOutside('pages/lab-1/assets/b.txt', 'uploaded');
      },
    });
    expect(result.attempts).toBe(2);
    expect(result.lazyFetches).toBe(0);
    expect(remoteFile('pages/lab-1/assets/b.txt')).toBe('uploaded');
    expect(remoteFile('pages/intro/content.json')).toBe(bigText('intro') + '\nours');
  });
});

describe('commitFilesToRemote auth', () => {
  let server: ChildProcess;
  let httpUrl: string;
  const token = 'ghs_TestToken123';

  beforeEach(async () => {
    sh(['--git-dir', remote, 'config', 'http.receivepack', 'true']);
    const started = await startGitHttp(
      root,
      `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
    );
    server = started.child;
    httpUrl = `${started.base}/remote.git`;
  });

  afterEach(() => {
    server.kill();
  });

  it('authenticates through the env header, never the URL or the clone config', async () => {
    const seenConfigs: string[] = [];
    const result = await commitFilesToRemote({
      remoteUrl: httpUrl,
      auth: { username: 'x-access-token', password: token },
      files: [{ path: 'pages/intro/content.json', content: 'authed' }],
      message: 'm\n',
      author: ID,
      tmpRoot: root,
      beforePush: async () => {
        const dir = readdirSync(root).find(d => d.startsWith('classmoji-checkpoint-'));
        if (dir) {
          seenConfigs.push(
            execFileSync('cat', [path.join(root, dir, 'repo.git', 'config')]).toString()
          );
        }
      },
    });
    expect(result.pushed).toBe(true);
    expect(remoteFile('pages/intro/content.json')).toBe('authed');
    expect(seenConfigs).toHaveLength(1);
    expect(seenConfigs[0]).not.toContain(token);
    expect(seenConfigs[0]).not.toContain(Buffer.from(`x-access-token:${token}`).toString('base64'));
  });

  it('fails without the credential (the server really checks it)', async () => {
    await expect(
      commitFilesToRemote({
        remoteUrl: httpUrl,
        files: [{ path: 'a.txt', content: 'x' }],
        message: 'm',
        author: ID,
      })
    ).rejects.toThrow(GitCommandError);
  });
});

describe('commitFilesToRemote outside-edit backstop', () => {
  const sha = (p: string) => sh(['--git-dir', remote, 'rev-parse', `main:${p}`]);

  it('drops a group whose file no longer has the expected sha, commits the rest', async () => {
    const result = await commitFilesToRemote({
      remoteUrl,
      groups: [
        {
          id: 'intro',
          files: [{ path: 'pages/intro/content.json', content: 'ours' }],
          expectBase: { paths: ['pages/intro/content.json'], sha: 'f'.repeat(40) },
        },
        {
          id: 'lab',
          files: [{ path: 'pages/lab-1/content.json', content: 'lab ours' }],
          expectBase: { paths: ['pages/lab-1/content.json'], sha: sha('pages/lab-1/content.json') },
        },
      ],
      message: 'm\n',
      author: ID,
    });
    expect(result.included).toEqual(['lab']);
    expect(result.excluded).toEqual([
      {
        id: 'intro',
        reason: 'outside-edit',
        headCommit: result.parent,
        path: 'pages/intro/content.json',
        headSha: sha('pages/intro/content.json'),
      },
    ]);
    expect(remoteFile('pages/intro/content.json')).toBe(bigText('intro'));
    expect(remoteFile('pages/lab-1/content.json')).toBe('lab ours');
  });

  it('a legacy deck compares index.html when deck.json does not exist yet', async () => {
    const result = await commitFilesToRemote({
      remoteUrl,
      groups: [
        {
          id: 'deck',
          files: [
            { path: 'slides/week-2/deck.json', content: '{}' },
            { path: 'slides/week-1/index.html', content: 'new html' },
          ],
          expectBase: {
            paths: ['slides/week-2/deck.json', 'slides/week-1/index.html'],
            sha: sha('slides/week-1/index.html'),
          },
        },
      ],
      message: 'm\n',
      author: ID,
    });
    expect(result.excluded).toEqual([]);
    expect(remoteFile('slides/week-1/index.html')).toBe('new html');
  });

  it('nothing to write when every group is excluded', async () => {
    const before = remoteHead();
    const result = await commitFilesToRemote({
      remoteUrl,
      groups: [
        {
          id: 'x',
          files: [{ path: 'pages/intro/content.json', content: 'ours' }],
          expectBase: { paths: ['pages/intro/content.json'], sha: 'f'.repeat(40) },
        },
      ],
      message: 'm\n',
      author: ID,
    });
    expect(result).toMatchObject({ pushed: false, included: [], commit: before });
    expect(remoteHead()).toBe(before);
  });

  it('an outside write to OUR file during the race drops that group on the rebuild', async () => {
    const result = await commitFilesToRemote({
      remoteUrl,
      groups: [
        {
          id: 'intro',
          files: [{ path: 'pages/intro/content.json', content: 'ours' }],
          expectBase: { paths: ['pages/intro/content.json'], sha: sha('pages/intro/content.json') },
        },
        // No recorded source: compared old base vs new base.
        { id: 'new', files: [{ path: 'pages/new/content.json', content: 'new ours' }] },
        { id: 'lab', files: [{ path: 'pages/lab-1/content.json', content: 'lab ours' }] },
      ],
      message: 'm\n',
      author: ID,
      beforePush: async ({ attempt }) => {
        if (attempt === 1) {
          pushOutside('pages/intro/content.json', 'github web edit');
          pushOutside('pages/new/content.json', 'someone else');
        }
      },
    });
    expect(result.attempts).toBe(2);
    expect(result.included).toEqual(['lab']);
    expect(result.excluded.map(e => e.id).sort()).toEqual(['intro', 'new']);
    expect(remoteFile('pages/intro/content.json')).toBe('github web edit');
    expect(remoteFile('pages/new/content.json')).toBe('someone else');
    expect(remoteFile('pages/lab-1/content.json')).toBe('lab ours');
  });
});

describe('isRepoNotFound', () => {
  const err = (stderr: string) => new GitCommandError(['clone'], 128, stderr);
  it('matches GitHub and GitLab missing-repo messages', () => {
    expect(
      isRepoNotFound(err("remote: Repository not found.\nfatal: repository 'x' not found"))
    ).toBe(true);
    expect(
      isRepoNotFound(
        err(
          "remote: The project you were looking for could not be found or you don't have permission to view it."
        )
      )
    ).toBe(true);
  });
  it('never matches an auth failure', () => {
    expect(
      isRepoNotFound(err("fatal: Authentication failed for 'https://github.com/o/r.git/'"))
    ).toBe(false);
    expect(
      isRepoNotFound(
        err(
          'remote: Write access to repository not granted.\nfatal: unable to access: The requested URL returned error: 403'
        )
      )
    ).toBe(false);
    expect(isRepoNotFound(err('fatal: some other not found thing'))).toBe(false);
  });
});
