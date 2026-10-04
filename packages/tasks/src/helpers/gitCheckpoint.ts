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
 * - `commit-tree -p <head>`, then `push --no-thin`. A thin pack makes
 *   pack-objects use the parent's blobs at the same paths as delta bases, which
 *   lazily fetches each one; `--no-thin` sends the new blobs whole.
 * - Never a force push. A non-fast-forward rejection fetches the new head
 *   (trees only) and rebuilds the same file set on it, up to `maxAttempts`.
 *
 * Self-contained (node + the git binary) so it can be unit-tested against a
 * local bare repository over file://.
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

export interface CommitFilesInput {
  /**
   * Clone/push URL. Carries the credential for HTTPS
   * (`https://x-access-token:<token>@github.com/org/repo.git`); never logged —
   * every error message passes through `redactGitSecrets`.
   */
  remoteUrl: string;
  files: GitFileWrite[];
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

export interface CommitFilesResult {
  /** The pushed commit, or `parent` when nothing changed (`pushed: false`). */
  commit: string;
  /** The commit it was built on (the head the push fast-forwarded). */
  parent: string;
  branch: string;
  /** False when every file already had these exact bytes: no commit, no push. */
  pushed: boolean;
  /** Push attempts made (0 when nothing was pushed). */
  attempts: number;
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
  return /non-fast-forward|fetch first|\[rejected\]|updates were rejected|cannot lock ref|incorrect old value/i.test(msg);
}

/** The clone failed because the repository does not exist (or is invisible to the token). */
export function isRepoNotFound(error: unknown): boolean {
  const msg = error instanceof GitCommandError ? error.stderr : String(error);
  return /repository .* not found|not found|does not appear to be a git repository/i.test(msg);
}

function gitEnv(author: GitIdentity, committer: GitIdentity): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Isolated from the machine's git config: a global `url.<ssh>.insteadOf`
    // or credential helper would otherwise rewrite or override the token URL.
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: committer.name,
    GIT_COMMITTER_EMAIL: committer.email,
  };
}

function run(
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: Buffer | string
): Promise<Buffer> {
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
    child.stdin.end(input ?? '');
  });
}

type TreeEntry = { mode: string; type: string; sha: string };

/** Nested map of pending writes: a blob sha at a leaf, a subtree otherwise. */
type ChangeTree = Map<string, string | ChangeTree>;

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
        if (current?.type === 'tree') throw new Error(`Cannot replace directory ${name} with a file`);
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

  return { git, gitStr, readTree, writeTree, applyChanges, packCount };
}

/**
 * Commit `files` on top of the remote branch and push it (fast-forward only).
 * Clones into a fresh temp dir and always removes it.
 *
 * @throws {GitCommandError} clone/push failures (credentials redacted); a push
 *   still rejected after `maxAttempts` rebuilds rethrows the last rejection.
 */
export async function commitFilesToRemote(input: CommitFilesInput): Promise<CommitFilesResult> {
  const maxAttempts = input.maxAttempts ?? 3;
  if (input.files.length === 0) throw new Error('commitFilesToRemote: no files');
  const seen = new Set<string>();
  const parsed = input.files.map(f => {
    if (seen.has(f.path)) throw new Error(`Duplicate path: ${f.path}`);
    seen.add(f.path);
    return { file: f, parts: validatePath(f.path) };
  });

  const env = gitEnv(input.author, input.committer ?? input.author);
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
    const branch =
      input.branch ?? (await repo.gitStr(['symbolic-ref', '--short', 'HEAD']));
    let parent = await repo.gitStr(['rev-parse', 'HEAD']);

    const packsAtStart = await repo.packCount();
    let explicitPacks = 0;

    // Blobs once: their shas do not depend on the parent.
    const blobShas: Record<string, string> = {};
    const changes: Array<{ parts: string[]; sha: string }> = [];
    for (const { file, parts } of parsed) {
      const sha = await repo.gitStr(['hash-object', '-w', '--stdin'], file.content);
      blobShas[file.path] = sha;
      changes.push({ parts, sha });
    }
    const changeTree = buildChangeTree(changes);

    const build = async (base: string) => {
      const baseTree = await repo.gitStr(['rev-parse', `${base}^{tree}`]);
      const tree = await repo.applyChanges(baseTree, changeTree);
      if (tree === baseTree) return null;
      return repo.gitStr(['commit-tree', '--no-gpg-sign', tree, '-p', base], input.message);
    };

    let commit = await build(parent);
    let attempts = 0;
    while (commit !== null) {
      attempts++;
      await input.beforePush?.({ attempt: attempts, commit, parent });
      try {
        await repo.git(['push', '--no-thin', 'origin', `${commit}:refs/heads/${branch}`]);
        break;
      } catch (error) {
        if (attempts >= maxAttempts || !isNonFastForward(error)) throw error;
        const before = await repo.packCount();
        await repo.git(['fetch', '--depth', '1', '--filter=blob:none', '--no-tags', 'origin', branch]);
        explicitPacks += (await repo.packCount()) - before;
        parent = await repo.gitStr(['rev-parse', 'FETCH_HEAD']);
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
      blobShas,
      lazyFetches,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
