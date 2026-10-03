import type { SimpleGit } from 'simple-git';
import { logger } from '@trigger.dev/sdk';
import { redactAccessTokens } from '@classmoji/services';

const errorText = (error: unknown): string =>
  redactAccessTokens(error instanceof Error ? error.message : String(error));

/**
 * Git settings for copying a template on a small worker.
 *
 * `gh-create_git_repo` runs on a 1 GB machine, and git's defaults assume
 * plenty of memory: index-pack (clone) holds every blob under 512 MB whole in
 * memory, and pack-objects (push) tries to delta each whole blob against a
 * window of ten others with no memory cap, across one thread per core. A
 * template with large binaries (game assets, videos, datasets) got the run
 * OOM-killed. Blobs above `core.bigFileThreshold` are streamed and never
 * delta-compressed, and the window and caches are bounded. The pushed objects
 * are the same; only how git packs them on the wire changes.
 */
export const LOW_MEMORY_GIT_CONFIG = [
  'core.bigFileThreshold=32m',
  'core.deltaBaseCacheLimit=32m',
  'core.packedGitLimit=256m',
  'core.packedGitWindowSize=32m',
  'pack.threads=1',
  'pack.windowMemory=100m',
  'pack.deltaCacheSize=32m',
];

/**
 * Most a single push may carry. Github refuses a push over 2 GB and drops the
 * connection mid-upload ("RPC failed; curl 55 Failed sending data to the
 * peer"); half of that leaves room for estimate error.
 */
export const PUSH_CHUNK_BYTES = 1024 ** 3;

/** `git ls-remote --heads` output as branch name to commit. */
export const parseRemoteHeads = (output: string): Map<string, string> => {
  const heads = new Map<string, string>();
  for (const line of output.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha && ref?.startsWith('refs/heads/')) {
      heads.set(ref.slice('refs/heads/'.length), sha);
    }
  }
  return heads;
};

/**
 * Whether `sha` is `ref` or one of its ancestors. A commit unknown locally is
 * not. (`merge-base --is-ancestor` answers by exit code alone, which
 * simple-git does not surface, so the merge base is compared instead.)
 */
export const isAncestor = async (git: SimpleGit, sha: string, ref: string): Promise<boolean> => {
  try {
    return (await git.raw(['merge-base', sha, ref])).trim() === sha;
  } catch {
    return false;
  }
};

/** Bytes the local object store takes: packed plus loose. */
export const localObjectBytes = async (git: SimpleGit): Promise<number> => {
  const out = await git.raw(['count-objects', '-v']);
  const kib = (key: string) => Number(out.match(new RegExp(`^${key}: (\\d+)`, 'm'))?.[1] ?? 0);
  return (kib('size') + kib('size-pack')) * 1024;
};

/** On-disk bytes of the objects reachable from `commit` but not from `base`. */
const bytesBetween = async (git: SimpleGit, commit: string, base: string | null) =>
  Number(
    (
      await git.raw([
        'rev-list',
        '--objects',
        '--disk-usage',
        commit,
        ...(base ? [`^${base}`] : []),
      ])
    ).trim()
  );

/**
 * Force-push `branch` to `remote`, in several pushes when one would be too big.
 *
 * A template under `budgetBytes` goes up in one `git push --force`, as it
 * always has. A bigger one is pushed along its first-parent history: each push
 * moves the remote branch to the furthest commit whose new objects fit the
 * budget, so every push stays under Github's per-push limit (the template's
 * own history was pushed to Github within that limit, so commits fit). A
 * single commit bigger than the budget still goes up alone.
 *
 * `alreadyPushed` is a commit of this branch the remote already has (a run
 * that stopped partway); the pushes continue from it.
 *
 * @returns the number of pushes made.
 */
export const pushBranchInChunks = async (
  git: SimpleGit,
  {
    remote,
    branch,
    budgetBytes = PUSH_CHUNK_BYTES,
    alreadyPushed = null,
  }: { remote: string; branch: string; budgetBytes?: number; alreadyPushed?: string | null }
): Promise<number> => {
  if ((await localObjectBytes(git)) <= budgetBytes) {
    await git.push(remote, branch, ['--force']);
    return 1;
  }

  const commits = (await git.raw(['rev-list', '--reverse', '--first-parent', branch]))
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  let base = alreadyPushed;
  let start = alreadyPushed ? commits.indexOf(alreadyPushed) + 1 : 0;
  let pushes = 0;

  logger.info(`Pushing ${branch} in parts`, { commits: commits.length, budgetBytes });

  while (start < commits.length) {
    // Furthest commit whose new objects fit: the size only grows along the
    // first-parent chain, so binary search finds it.
    let best = start;
    let lo = start + 1;
    let hi = commits.length - 1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await bytesBetween(git, commits[mid], base)) <= budgetBytes) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    if (best === commits.length - 1) {
      await git.push(remote, branch, ['--force']);
    } else {
      await git.push(remote, `+${commits[best]}:refs/heads/${branch}`);
    }
    pushes += 1;
    logger.info(`Pushed ${branch} up to commit ${best + 1} of ${commits.length}`);

    base = commits[best];
    start = best + 1;
  }

  return pushes;
};

/**
 * Whether the checked-out commit's root `.gitattributes` routes files through
 * Git LFS. Without LFS handling a copy carries only the pointer files, and the
 * new repository has no content behind them.
 */
export const usesLfs = async (git: SimpleGit): Promise<boolean> => {
  try {
    return /filter=lfs/.test(await git.show(['HEAD:.gitattributes']));
  } catch {
    return false;
  }
};

/**
 * Download every LFS object the local branches reference from `remote`.
 * Returns false (and logs) when it cannot, e.g. git-lfs is not installed.
 */
export const fetchLfsObjects = async (git: SimpleGit, remote: string): Promise<boolean> => {
  try {
    await git.raw(['lfs', 'fetch', '--all', remote]);
    return true;
  } catch (error: unknown) {
    logger.warn('Could not fetch the template Git LFS files; the copy will hold only pointers', {
      error: errorText(error),
    });
    return false;
  }
};

/** Upload every LFS object the local branches reference to `remote`. */
export const pushLfsObjects = async (git: SimpleGit, remote: string): Promise<void> => {
  try {
    await git.raw(['lfs', 'push', '--all', remote]);
  } catch (error: unknown) {
    logger.warn('Could not upload the template Git LFS files; the copy will hold only pointers', {
      error: errorText(error),
    });
  }
};
