/**
 * gitCheckpoint.ts — commit N files to a remote branch with plain git, without
 * downloading a single existing file.
 *
 * Used by the live-editing checkpoint worker (`content-checkpoint`), which
 * writes every changed page/deck of a classroom in ONE commit. Ported from the
 * collab git spike (verified against GitHub):
 *
 * - Blob-less shallow BARE clone (`--depth 1 --filter=blob:none --bare`): the
 *   commit and its trees, no file contents.
 * - New blobs with `hash-object -w`; trees rebuilt with `ls-tree -z` +
 *   `mktree -z --missing` along the CHANGED paths only. Never the index and
 *   never `read-tree`: in a blob-less clone both fault in every blob.
 * - `commit-tree -p <head>`, then a push that sends the new blobs whole. A
 *   thin pack makes pack-objects use the parent's blobs at the same paths as
 *   delta bases, and in a partial clone it lazily fetches each one first.
 *   `--no-thin` stops that over ssh:// and file://, but NOT over https: git's
 *   remote helper drops the option (`thin` is in transport-helper's
 *   unsupported list) and runs `send-pack --stateless-rpc --thin` regardless —
 *   verified against GitHub, where the spike's ssh push had hidden it. So the
 *   push also runs with the clone's promisor config detached
 *   (`withoutPromisor`): with no promisor remote, pack-objects marks a missing
 *   preferred base as not found and skips it ("we don't have to include it
 *   anyway") instead of fetching it. The config is restored after the push —
 *   the rejection path's `fetch --filter` needs it.
 * - Never a force push. A non-fast-forward rejection fetches the new head
 *   (trees only) and rebuilds on it, up to `maxAttempts`.
 * - Files come in GROUPS (one per live document). A group may carry the blob
 *   sha its document descends from (`expectBase`); at the clone head and at
 *   every rebuild base, a group whose file no longer has that sha was changed
 *   outside the live document, and is dropped from the commit rather than
 *   written over the outside change. On a rebuild, a group without
 *   `expectBase` is dropped when its own paths changed between the old and
 *   the new base. Dropped groups are reported; the rest still commit.
 * - The credential never touches the command line or the disk: the remote URL
 *   carries none, and the Authorization header reaches git through
 *   GIT_CONFIG_COUNT / GIT_CONFIG_KEY_0 / GIT_CONFIG_VALUE_0 in its environment.
 *
 * Self-contained (node + the git binary) so it can be unit-tested against a
 * local bare repository, over file:// and over smart HTTP (`git http-backend`).
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface GitIdentity {
  name: string;
  email: string;
}

export interface GitFileWrite {
  /** Repo-relative path, `/`-separated (e.g. `pages/intro/content.json`). */
  path: string;
  content: string | Buffer;
}

/** One document's files, written together or not at all. */
export interface CommitGroup {
  id: string;
  files: GitFileWrite[];
  /**
   * Write this group only while the base's blob at the first of `paths` that
   * exists equals `sha` (the blob the live document descends from). No file
   * at any of the paths counts as a change. Omit for a document with no
   * recorded source (a new one).
   */
  expectBase?: { paths: string[]; sha: string };
}

export interface CommitFilesInput {
  /** Clone/push URL WITHOUT credentials (`https://github.com/org/repo.git`). */
  remoteUrl: string;
  /** HTTP basic credentials, sent as an `Authorization` header via the env. */
  auth?: { username: string; password: string };
  /** The documents' files. */
  groups?: CommitGroup[];
  /** Shorthand for one unchecked group (`id: 'files'`). */
  files?: GitFileWrite[];
  /** Full commit message, trailers included. */
  message: string;
  author: GitIdentity;
  /** Defaults to `author`. */
  committer?: GitIdentity;
  /** Branch to update. Default: the remote's default branch (its HEAD). */
  branch?: string;
  /** Push attempts, counting the first. Default 3. */
  maxAttempts?: number;
  /** Parent directory for the per-run clone. Default: the OS temp dir. */
  tmpRoot?: string;
  /** Test seam: runs after each commit is built, before its push. */
  beforePush?: (info: { attempt: number; commit: string; parent: string }) => Promise<void>;
}

export interface ExcludedGroup {
  id: string;
  reason: 'outside-edit';
  /** The commit whose content showed the change. */
  headCommit: string;
  /** Path that was compared, and its blob there (null: absent). */
  path: string;
  headSha: string | null;
}

export interface CommitFilesResult {
  /** The pushed commit, or `parent` when nothing changed (`pushed: false`). */
  commit: string;
  /** The commit it was built on (the head the push fast-forwarded). */
  parent: string;
  branch: string;
  /** False when nothing was committed (no change, or every group excluded). */
  pushed: boolean;
  /** Push attempts made (0 when nothing was pushed). */
  attempts: number;
  /** Ids of the groups in `commit` (or already identical at `parent`). */
  included: string[];
  /** Groups left out because their file changed outside the live document. */
  excluded: ExcludedGroup[];
  /** Git blob sha per written path (equal to the Contents API's file sha). */
  blobShas: Record<string, string>;
  /**
   * Packs that appeared while building and pushing — each one a lazy
   * (promisor) fetch of an object we did not ask for. Expected 0; explicit
   * re-fetches after a rejection are not counted.
   */
  lazyFetches: number;
}

/** Strip credentials from anything that might quote a remote URL. */
export function redactGitSecrets(text: string): string {
  return text
    .replace(/(\/\/)[^/@\s:]+:[^/@\s]+@/g, '$1***@')
    .replace(/\b(gh[opsu]_|ghs_|github_pat_)[A-Za-z0-9_]+/g, '$1***');
}

export class GitCommandError extends Error {
  readonly args: string[];
  readonly code: number | null;
  readonly stderr: string;

  constructor(args: string[], code: number | null, stderr: string) {
    const safeArgs = args.map(redactGitSecrets);
    const safeErr = redactGitSecrets(stderr);
    super(`git ${safeArgs.join(' ')} exited ${code}: ${safeErr.slice(0, 2000)}`);
    this.name = 'GitCommandError';
    this.args = safeArgs;
    this.code = code;
    this.stderr = safeErr;
  }
}

/** A push refused because the branch moved (rebuild on the new head and retry). */
export function isNonFastForward(error: unknown): boolean {
  const msg = error instanceof GitCommandError ? error.stderr : String(error);
  return /non-fast-forward|fetch first|\[rejected\]|updates were rejected|cannot lock ref|incorrect old value/i.test(
    msg
  );
}

/**
 * The clone failed because the repository does not exist: GitHub's
 * "Repository not found", GitLab's "could not be found". Never an auth
 * failure (401/403, "Authentication failed", "denied") — creating a repo is
 * not the answer to a bad token. GitHub also answers "not found" for a repo
 * the token cannot see; the caller's create path asks the API, which tells a
 * 404 from a 403, before it creates anything.
 */
export function isRepoNotFound(error: unknown): boolean {
  const msg = error instanceof GitCommandError ? error.stderr : String(error);
  if (
    /authentication failed|permission denied|access denied|\b40[13]\b|not granted|denied to/i.test(
      msg
    )
  ) {
    return false;
  }
  return /repository not found|could not be found|does not appear to be a git repository/i.test(
    msg
  );
}

function authHeaderKey(remoteUrl?: string): string {
  try {
    const url = new URL(remoteUrl ?? '');
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      return `http.${url.protocol}//${url.host}/.extraHeader`;
    }
  } catch {
    // Not a URL: fall through to the unscoped key.
  }
  return 'http.extraHeader';
}

function gitEnv(
  author: GitIdentity,
  committer: GitIdentity,
  auth?: { username: string; password: string },
  remoteUrl?: string
): NodeJS.ProcessEnv {
  const basic = auth ? Buffer.from(`${auth.username}:${auth.password}`).toString('base64') : null;
  return {
    ...process.env,
    // The credential as config from the environment (git >= 2.31): never on
    // a command line (visible in `ps`) and never in the clone's config file.
    ...(basic
      ? {
          GIT_CONFIG_COUNT: '1',
          // Scoped to the remote's origin, so no other host ever sees it.
          GIT_CONFIG_KEY_0: authHeaderKey(remoteUrl),
          GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
        }
      : {}),
    // Isolated from the machine's git config: a global `url.<ssh>.insteadOf`
    // or credential helper would otherwise rewrite or override the token URL.
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: committer.name,
    GIT_COMMITTER_EMAIL: committer.email,
  };
}

function run(args: string[], env: NodeJS.ProcessEnv, input?: Buffer | string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', e => reject(new GitCommandError(args, null, String(e))));
    child.on('close', code => {
      if (code === 0) resolve(Buffer.concat(out));
      // stdout too: some commands (`push --porcelain`) report refusals there.
      else
        reject(
          new GitCommandError(
            args,
            code,
            `${Buffer.concat(err).toString()}${Buffer.concat(out).toString()}`
          )
        );
    });
    // A git that exits before reading its stdin (a failed clone, a refused
    // push) makes the write fail with EPIPE; the exit code is the real answer.
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

type TreeEntry = { mode: string; type: string; sha: string };

/** Nested map of pending writes: a blob sha at a leaf, a subtree otherwise. */
type ChangeTree = Map<string, string | ChangeTree>;

/** A safe repo-relative path (no `..`, `.git`, empty or absolute parts). */
export function isSafeRepoPath(p: string): boolean {
  const parts = p.split('/');
  return !(
    !p ||
    p.startsWith('/') ||
    parts.some(s => !s || s === '.' || s === '..' || s === '.git')
  );
}

function validatePath(p: string): string[] {
  const parts = p.split('/');
  if (!p || p.startsWith('/') || parts.some(s => !s || s === '.' || s === '..' || s === '.git')) {
    throw new Error(`Invalid repo path: ${JSON.stringify(p)}`);
  }
  return parts;
}

function buildChangeTree(entries: Array<{ parts: string[]; sha: string }>): ChangeTree {
  const root: ChangeTree = new Map();
  for (const { parts, sha } of entries) {
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const existing = node.get(parts[i]);
      if (typeof existing === 'string') {
        throw new Error(`Path conflict at ${parts.slice(0, i + 1).join('/')}`);
      }
      const next = existing ?? new Map();
      node.set(parts[i], next);
      node = next;
    }
    const leaf = parts[parts.length - 1];
    if (node.get(leaf) instanceof Map) {
      throw new Error(`Path conflict at ${parts.join('/')}`);
    }
    node.set(leaf, sha);
  }
  return root;
}

/**
 * The repository operations, bound to one bare clone. Exported for tests;
 * production callers use `commitFilesToRemote`.
 */
export function bareRepo(gitDir: string, env: NodeJS.ProcessEnv) {
  const git = (args: string[], input?: Buffer | string) =>
    run(['--git-dir', gitDir, ...args], env, input);
  const gitStr = async (args: string[], input?: Buffer | string) =>
    (await git(args, input)).toString('utf8').trim();

  async function readTree(sha: string): Promise<Map<string, TreeEntry>> {
    const entries = new Map<string, TreeEntry>();
    const out = await git(['ls-tree', '-z', sha]);
    for (const line of out.toString('utf8').split('\0')) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      const [mode, type, obj] = line.slice(0, tab).split(' ');
      entries.set(line.slice(tab + 1), { mode, type, sha: obj });
    }
    return entries;
  }

  async function writeTree(entries: Map<string, TreeEntry>): Promise<string> {
    // mktree sorts the entries itself; --missing lets a tree name blobs this
    // clone never fetched (every unchanged file).
    const body = [...entries.entries()]
      .map(([name, e]) => `${e.mode} ${e.type} ${e.sha}\t${name}\0`)
      .join('');
    return gitStr(['mktree', '-z', '--missing'], body);
  }

  /** Rebuild `treeSha` with `changes` applied; touches only changed subtrees. */
  async function applyChanges(treeSha: string | null, changes: ChangeTree): Promise<string> {
    const entries = treeSha ? await readTree(treeSha) : new Map<string, TreeEntry>();
    for (const [name, change] of changes) {
      const current = entries.get(name);
      if (typeof change === 'string') {
        if (current?.type === 'tree')
          throw new Error(`Cannot replace directory ${name} with a file`);
        // Keep an existing executable bit; new files are plain.
        const mode = current?.type === 'blob' && current.mode === '100755' ? '100755' : '100644';
        entries.set(name, { mode, type: 'blob', sha: change });
      } else {
        if (current && current.type !== 'tree') {
          throw new Error(`Cannot replace file ${name} with a directory`);
        }
        const sub = await applyChanges(current?.sha ?? null, change);
        entries.set(name, { mode: '040000', type: 'tree', sha: sub });
      }
    }
    return writeTree(entries);
  }

  async function packCount(): Promise<number> {
    try {
      const files = await readdir(path.join(gitDir, 'objects', 'pack'));
      return files.filter(f => f.endsWith('.pack')).length;
    } catch {
      return 0;
    }
  }

  /**
   * Run `fn` with the clone's promisor-remote config removed, then put it back.
   * Git treats a remote as a promisor when it has `promisor = true` OR a
   * `partialclonefilter`, and git < 2.44-ish also records
   * `extensions.partialClone`; all three have to go for pack-objects to stop
   * lazy-fetching.
   */
  async function withoutPromisor<T>(fn: () => Promise<T>): Promise<T> {
    let saved: Array<[string, string]> = [];
    try {
      const out = await gitStr([
        'config',
        '--local',
        '--get-regexp',
        '^(extensions\\.partialclone|remote\\.origin\\.(promisor|partialclonefilter))$',
      ]);
      saved = out
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const space = line.indexOf(' ');
          return [line.slice(0, space), line.slice(space + 1)] as [string, string];
        });
    } catch {
      // Exit 1: none set (not a partial clone) — nothing to detach.
    }
    for (const [key] of saved) await git(['config', '--local', '--unset-all', key]);
    try {
      return await fn();
    } finally {
      for (const [key, value] of saved) await git(['config', '--local', key, value]);
    }
  }

  /** The blob sha at `path` in `commit` (trees only — no blob is read), or null. */
  async function blobAt(commit: string, filePath: string): Promise<string | null> {
    try {
      const sha = await gitStr(['rev-parse', '--verify', '--quiet', `${commit}:${filePath}`]);
      return sha || null;
    } catch {
      return null;
    }
  }

  return { git, gitStr, readTree, writeTree, applyChanges, packCount, withoutPromisor, blobAt };
}

/**
 * Commit the groups' files on top of the remote branch and push (fast-forward
 * only). Clones into a fresh temp dir and always removes it.
 *
 * @throws {GitCommandError} clone/push failures (credentials redacted); a push
 *   still rejected after `maxAttempts` rebuilds rethrows the last rejection.
 */
export async function commitFilesToRemote(input: CommitFilesInput): Promise<CommitFilesResult> {
  const maxAttempts = input.maxAttempts ?? 3;
  const groups: CommitGroup[] = [
    ...(input.groups ?? []),
    ...(input.files?.length ? [{ id: 'files', files: input.files }] : []),
  ];
  if (groups.length === 0 || groups.every(g => g.files.length === 0)) {
    throw new Error('commitFilesToRemote: no files');
  }
  const seen = new Set<string>();
  const parsedGroups = groups.map(group => ({
    group,
    files: group.files.map(f => {
      if (seen.has(f.path)) throw new Error(`Duplicate path: ${f.path}`);
      seen.add(f.path);
      return { file: f, parts: validatePath(f.path) };
    }),
  }));

  const env = gitEnv(input.author, input.committer ?? input.author, input.auth, input.remoteUrl);
  const workDir = await mkdtemp(path.join(input.tmpRoot ?? tmpdir(), 'classmoji-checkpoint-'));
  const gitDir = path.join(workDir, 'repo.git');

  try {
    await run(
      [
        'clone',
        '--depth',
        '1',
        '--filter=blob:none',
        '--bare',
        '--no-tags',
        '--single-branch',
        ...(input.branch ? ['--branch', input.branch] : []),
        input.remoteUrl,
        gitDir,
      ],
      env
    );
    const repo = bareRepo(gitDir, env);
    const branch = input.branch ?? (await repo.gitStr(['symbolic-ref', '--short', 'HEAD']));
    let parent = await repo.gitStr(['rev-parse', 'HEAD']);

    const packsAtStart = await repo.packCount();
    let explicitPacks = 0;

    // Blobs once: their shas do not depend on the parent.
    const blobShas: Record<string, string> = {};
    for (const { file } of parsedGroups.flatMap(g => g.files)) {
      blobShas[file.path] = await repo.gitStr(['hash-object', '-w', '--stdin'], file.content);
    }

    const excluded: ExcludedGroup[] = [];
    const isExcluded = (id: string) => excluded.some(e => e.id === id);

    /** Drop every group whose file changed outside its document, as seen at `base`. */
    const screen = async (base: string, previousBase: string | null) => {
      for (const { group } of parsedGroups) {
        if (isExcluded(group.id)) continue;
        if (group.expectBase) {
          let comparedPath = group.expectBase.paths[0];
          let headSha: string | null = null;
          for (const candidate of group.expectBase.paths) {
            const sha = await repo.blobAt(base, candidate);
            if (sha) {
              comparedPath = candidate;
              headSha = sha;
              break;
            }
          }
          if (headSha !== group.expectBase.sha) {
            excluded.push({
              id: group.id,
              reason: 'outside-edit',
              headCommit: base,
              path: comparedPath,
              headSha,
            });
          }
        } else if (previousBase) {
          for (const f of group.files) {
            const before = await repo.blobAt(previousBase, f.path);
            const after = await repo.blobAt(base, f.path);
            if (before !== after) {
              excluded.push({
                id: group.id,
                reason: 'outside-edit',
                headCommit: base,
                path: f.path,
                headSha: after,
              });
              break;
            }
          }
        }
      }
    };

    const build = async (base: string) => {
      const live = parsedGroups.filter(g => !isExcluded(g.group.id));
      if (live.length === 0) return null;
      const changeTree = buildChangeTree(
        live.flatMap(g => g.files.map(({ file, parts }) => ({ parts, sha: blobShas[file.path] })))
      );
      const baseTree = await repo.gitStr(['rev-parse', `${base}^{tree}`]);
      const tree = await repo.applyChanges(baseTree, changeTree);
      if (tree === baseTree) return null;
      return repo.gitStr(['commit-tree', '--no-gpg-sign', tree, '-p', base], input.message);
    };

    await screen(parent, null);
    let commit = await build(parent);
    let attempts = 0;
    while (commit !== null) {
      attempts++;
      await input.beforePush?.({ attempt: attempts, commit, parent });
      try {
        const ref = `${commit}:refs/heads/${branch}`;
        await repo.withoutPromisor(() => repo.git(['push', '--no-thin', 'origin', ref]));
        break;
      } catch (error) {
        if (attempts >= maxAttempts || !isNonFastForward(error)) throw error;
        const before = await repo.packCount();
        await repo.git([
          'fetch',
          '--depth',
          '1',
          '--filter=blob:none',
          '--no-tags',
          'origin',
          branch,
        ]);
        explicitPacks += (await repo.packCount()) - before;
        const previous = parent;
        parent = await repo.gitStr(['rev-parse', 'FETCH_HEAD']);
        await screen(parent, previous);
        commit = await build(parent);
      }
    }

    const lazyFetches = (await repo.packCount()) - packsAtStart - explicitPacks;
    return {
      commit: commit ?? parent,
      parent,
      branch,
      pushed: commit !== null,
      attempts,
      included: parsedGroups.map(g => g.group.id).filter(id => !isExcluded(id)),
      excluded,
      blobShas,
      lazyFetches,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
