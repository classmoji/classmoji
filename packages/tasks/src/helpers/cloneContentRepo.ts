/**
 * cloneContentRepo.ts — copy a classroom's WHOLE content repository into a
 * freshly created target content repo with one git clone and one force-push.
 *
 * Why not the Contents API: the per-file importer
 * (`contentImport.importClassroomContent`) reads every page/deck folder file by
 * file and writes them back through blob commits. On a real course that is
 * hundreds of sequential round-trips against a ~1/sec limiter — a production
 * import spent 40+ minutes in that phase. Git moves the same bytes in one
 * transfer, so the copy takes a minute or two, and files over the Contents
 * API's 1MB single-file read cap (previously skipped with a warning) come
 * across intact.
 *
 * The clone is SHALLOW and its `.git` is discarded: the target gets a single
 * fresh "Import content from <source>" commit, never the source repo's history.
 * That is deliberate — a term rollover must not ship the previous term's
 * deleted files, which a full-history copy would keep recoverable forever.
 *
 * Force-push is intended and safe here: the target content repo was created by
 * this same import moments earlier (`ensureContentRepo`, which seeds an
 * auto-init commit), so the only thing overwritten is that empty scaffold. This
 * helper must never be pointed at a content repo with real content in it.
 *
 * Mirrors packages/tasks/src/helpers/createRepository.ts: simple-git with
 * `x-access-token:<installation token>` clone URLs, and a `finally` that always
 * removes the working directory.
 */

import { simpleGit } from 'simple-git';
import { logger } from '@trigger.dev/sdk';
import path from 'path';
import fs from 'fs';

import { ClassmojiService, redactAccessTokens } from '@classmoji/services';

/** Top-level folders the content repo organizes managed content under. */
const PAGES_DIR = 'pages';
const SLIDES_DIR = 'slides';

/**
 * The manifest is rebuilt wholesale from the TARGET's DB rows after the import
 * (contentManifest.saveManifest), so copying the source's would publish the
 * source classroom's ids until that ran — and leave them if it failed.
 */
const MANIFEST_PATH = path.join('.classmoji', 'manifest.json');

/** Cap on a single file's in-memory URL rewrite. Content files are text, not datasets. */
const MAX_REWRITE_BYTES = 5 * 1024 * 1024;

export interface ContentRepoCoordinates {
  orgLogin: string;
  repo: string;
  /** Installation access token for that org (gitProvider.getAccessToken()). */
  token: string;
}

export interface CloneContentRepoPayload {
  source: ContentRepoCoordinates;
  target: ContentRepoCoordinates;
  /** Drop the `pages/` tree when false (the user imported slides only). */
  keepPages: boolean;
  /** Drop the `slides/` tree when false. */
  keepSlides: boolean;
  commitMessage: string;
  /** Coarse step reporting for the progress banner. Never awaited by callers. */
  onStep?: (note: string) => void;
}

/** Why nothing reached the target. Set whenever `pushed` is false. */
export type CloneSkipReason =
  /** The source repo does not exist, or this installation cannot see it. */
  | 'missing'
  /** The source repo exists but has no commits. */
  | 'empty'
  /** Everything the source had was pruned away by the pages/slides selection. */
  | 'pruned';

export interface CloneContentRepoResult {
  /** false when there was nothing to copy — see `skipped`. Not an error. */
  pushed: boolean;
  /** Files whose absolute source-repo URLs were repointed at the target repo. */
  rewritten: number;
  /** Files in the pushed tree (excluding .git). */
  files: number;
  /** Present only when `pushed` is false: which of the empty cases it was. */
  skipped?: CloneSkipReason;
}

const cloneUrl = ({ orgLogin, repo, token }: ContentRepoCoordinates): string =>
  `https://x-access-token:${token}@github.com/${orgLogin}/${repo}.git`;

/**
 * Rethrow a git failure with the repo named and the installation token stripped.
 *
 * Both halves matter. Git echoes the remote URL verbatim on failure ("fatal:
 * repository 'https://x-access-token:<token>@github.com/...' not found"), and
 * that text is rethrown → recorded in `ImportJob.error` → rendered in the
 * progress banner, which would persist a live installation token in the
 * database. And a raw git error names no org, so an unreachable source org
 * reads as an unexplained clone failure.
 *
 * No token is minted in this file — the caller passes them in
 * (classroomImport's `contentRepoCoordinates`, which names the org on a mint
 * failure of its own).
 */
function gitFailure(
  action: string,
  { orgLogin, repo }: ContentRepoCoordinates,
  error: unknown
): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`${action} ${orgLogin}/${repo} failed: ${redactAccessTokens(detail)}`);
}

/**
 * Does this clone failure mean "there is no such repo"?
 *
 * Git says it two ways for the same condition — `remote: Repository not found.`
 * from the server, then `fatal: repository '<url>' not found` from the client —
 * and both land in one message, so either alternative matching is enough.
 *
 * Deliberately narrow: anything broader (a bare /not found/) would swallow
 * unrelated git failures and silently import a classroom with no content. Auth
 * and network failures must still throw.
 *
 * Note that GitHub answers 404 both for a repo that does not exist AND for one
 * the installation cannot see, and does not distinguish them on purpose. The
 * caller's warning has to name both possibilities, because we cannot tell.
 */
function isRepoNotFound(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /remote: Repository not found|repository '[^']*' not found/i.test(detail);
}

/** Every file under `dir`, recursively, as absolute paths. Skips `.git`. */
function listFilesRecursive(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listFilesRecursive(full));
      continue;
    }
    if (entry.isFile()) found.push(full);
  }
  return found;
}

/**
 * Repoint absolute source-repo asset URLs at the target repo, in place.
 *
 * Reuses the SAME pure helpers the per-file importer uses
 * (`isTextContentPath` to keep binaries untouched, `rewriteContentUrls` to do
 * the substitution), so both import paths rewrite identically.
 *
 * On a whole-repo copy the item folder path is IDENTICAL on both sides — this
 * is a fresh repo, so nothing is renamed or dedupe-suffixed — which means only
 * the org/repo segments of a URL actually change. The per-item path arguments
 * are therefore passed as the same value; the helper's item-specific pass
 * becomes a no-op and its repo-general pass does all the work.
 */
function rewriteAssetUrls({
  root,
  source,
  target,
}: {
  root: string;
  source: ContentRepoCoordinates;
  target: ContentRepoCoordinates;
}): { rewritten: number; files: number } {
  const { rewriteContentUrls, isTextContentPath } = ClassmojiService.contentImport;
  const files = listFilesRecursive(root);
  let rewritten = 0;

  for (const file of files) {
    const relative = path.relative(root, file);
    if (!isTextContentPath(relative)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (stat.size > MAX_REWRITE_BYTES) {
      logger.warn('content import: skipped URL rewrite for an oversized text file', {
        file: relative,
        size: stat.size,
      });
      continue;
    }

    const original = fs.readFileSync(file, 'utf8');
    const updated = rewriteContentUrls(original, {
      sourceLogin: source.orgLogin,
      sourceRepo: source.repo,
      sourcePath: '',
      targetLogin: target.orgLogin,
      targetRepo: target.repo,
      targetPath: '',
    });
    if (updated === original) continue;
    fs.writeFileSync(file, updated, 'utf8');
    rewritten++;
  }

  return { rewritten, files: files.length };
}

/**
 * Clone the source content repo, prune it to the selected content types, drop
 * the stale manifest, repoint asset URLs, and force-push the result as a single
 * commit onto the target repo's `main`.
 *
 * Idempotent by construction: re-running pushes the same tree to the same
 * branch, so a retried import converges instead of duplicating anything.
 */
export const cloneContentRepo = async (
  payload: CloneContentRepoPayload
): Promise<CloneContentRepoResult> => {
  const { source, target, keepPages, keepSlides, commitMessage, onStep } = payload;

  // Unique per run: two imports in the same org must never share a directory.
  const localPath = path.join(
    process.cwd(),
    'repos',
    `content-import-${target.repo}-${Date.now()}`
  );

  try {
    if (fs.existsSync(localPath)) {
      fs.rmSync(localPath, { recursive: true, force: true });
    }

    onStep?.(`cloning ${source.orgLogin}/${source.repo}`);
    // --depth 1: only the current tree is wanted, and the history is dropped
    // below anyway. On a content repo with years of commits this is the
    // difference between seconds and minutes.
    try {
      await simpleGit().clone(cloneUrl(source), localPath, ['--depth', '1']);
    } catch (error: unknown) {
      // A source classroom that never had a page or deck still carries a
      // content repo NAME: `Classroom.content_repo` is NOT NULL and every
      // creation path fills it with a derived default, while the repo itself is
      // only created on the first content write. "Named but absent" is
      // therefore the ordinary shape of a source with no content — the same
      // situation as the no-commits case below, and it has to behave the same
      // way. Throwing here failed the whole content phase and left the user
      // with an unretryable import (Trigger run 06g1u10i, 2026-08-20).
      if (isRepoNotFound(error)) {
        logger.warn('content import: source content repo not found — nothing to copy', {
          repo: `${source.orgLogin}/${source.repo}`,
        });
        return { pushed: false, rewritten: 0, files: 0, skipped: 'missing' };
      }
      throw gitFailure('cloning', source, error);
    }

    const repoGit = simpleGit(localPath);
    let sourceHasCommits = true;
    try {
      await repoGit.raw(['rev-parse', '--verify', 'HEAD']);
    } catch {
      sourceHasCommits = false;
    }
    if (!sourceHasCommits) {
      logger.warn('content import: source content repo has no commits — nothing to copy', {
        repo: `${source.orgLogin}/${source.repo}`,
      });
      return { pushed: false, rewritten: 0, files: 0, skipped: 'empty' };
    }

    // Discard the source's history: the target gets one fresh commit.
    fs.rmSync(path.join(localPath, '.git'), { recursive: true, force: true });

    onStep?.('preparing content');
    if (!keepPages) {
      fs.rmSync(path.join(localPath, PAGES_DIR), { recursive: true, force: true });
    }
    if (!keepSlides) {
      fs.rmSync(path.join(localPath, SLIDES_DIR), { recursive: true, force: true });
    }
    fs.rmSync(path.join(localPath, MANIFEST_PATH), { force: true });

    const { rewritten, files } = rewriteAssetUrls({ root: localPath, source, target });
    if (files === 0) {
      logger.warn('content import: nothing left to push after pruning', {
        repo: `${source.orgLogin}/${source.repo}`,
        keepPages,
        keepSlides,
      });
      return { pushed: false, rewritten: 0, files: 0, skipped: 'pruned' };
    }

    onStep?.(
      `pushing to ${target.orgLogin}/${target.repo} — one commit (${files} files), a single git push`
    );
    const freshGit = simpleGit(localPath);
    await freshGit.init();
    await freshGit.addConfig('user.name', 'Classmoji Bot');
    await freshGit.addConfig('user.email', 'hello@classmoji.com');
    // `git init` picks up the machine's init.defaultBranch, which is not
    // guaranteed to be `main` — every consumer (Pages, the content readers)
    // assumes `main`, so name it explicitly.
    await freshGit.checkoutLocalBranch('main');
    await freshGit.add('.');
    await freshGit.commit(commitMessage);
    // Only these two carry the credentialed remote URL — the local operations
    // above cannot leak a token, so they are left to throw as they are.
    try {
      await freshGit.addRemote('origin', cloneUrl(target));
      // Overwrites ONLY the auto-init scaffold ensureContentRepo just created.
      await freshGit.push('origin', 'main', ['--force']);
    } catch (error: unknown) {
      throw gitFailure('pushing to', target, error);
    }

    logger.info('content import: pushed content repo copy', {
      from: `${source.orgLogin}/${source.repo}`,
      to: `${target.orgLogin}/${target.repo}`,
      files,
      rewritten,
    });

    return { pushed: true, rewritten, files };
  } finally {
    if (fs.existsSync(localPath)) {
      fs.rmSync(localPath, { recursive: true, force: true });
    }
  }
};
