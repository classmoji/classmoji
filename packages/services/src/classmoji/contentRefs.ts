/**
 * The URL shapes that address a file in a classroom's OWN content repo.
 *
 * Every one of them is really the same thing written differently — a repo path
 * with a host-specific prefix in front of it. They live here, alone, so the
 * import rewriter (which swaps one repo's prefix for another's) and the
 * delivery resolver (which strips the prefix back off to recover the path)
 * cannot drift apart: a fourth shape, or a changed one, is a single edit.
 *
 * Deliberately dependency-free — no Prisma, no GitHub, no zod. Both callers
 * are on a render path, and this module is the only thing either of them needs
 * in order to agree on what "a reference into this repo" means.
 */

const RAW_HOST = 'https://raw.githubusercontent.com';

/** `https://raw.githubusercontent.com/{login}/{repo}/{branch}` (no trailing slash). */
export function rawContentBase(login: string, repo: string, branch = 'main'): string {
  return `${RAW_HOST}/${login}/${repo}/${branch}`;
}

/** `https://{login}.github.io/{repo}` — the GitHub Pages CDN (no trailing slash). */
export function pagesContentBase(login: string, repo: string): string {
  return `https://${login}.github.io/${repo}`;
}

/** `/content/{login}/{repo}` — the slides app's same-origin content proxy. */
export function contentProxyBase(login: string, repo: string): string {
  return `/content/${login}/${repo}`;
}

/**
 * A commit-pinned ref: 40 hex characters where a branch name would be.
 *
 * These are not references to "the current file", they are references to one
 * exact historical version, and every caller here has to leave them alone for
 * its own reason. The delivery resolver must not turn one into a repo path,
 * because the map holds the DEFAULT BRANCH's content and serving that would
 * quietly hand back today's bytes for a URL that asked for a specific old
 * revision. The import rewriter must not repoint one at the target repo,
 * because that commit does not exist there and never will.
 */
export function isCommitRef(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref);
}

/**
 * Split `{ref}/{path}` off the tail of a raw URL, where the ref may be
 * fully qualified.
 *
 * GitHub's own "Raw" button emits `refs/heads/main/...`, not `main/...`, and
 * the two are the same URL. Consuming ONE segment as the ref against the
 * qualified form leaves `ref: 'refs'` and a path of `heads/main/pages/…` — a
 * path no repo has, so the resolver misses it and the rewriter carries the
 * item folder across unremapped. Tags (`refs/tags/v1`) arrive the same way.
 *
 * Returns null when there is no path after the ref, which is not a file
 * reference at all.
 */
export function splitRawRef(rest: string): { ref: string; path: string } | null {
  const qualified = /^(refs\/(?:heads|tags)\/[^/]+)\/(.+)$/.exec(rest);
  if (qualified) {
    return { ref: qualified[1], path: qualified[2] };
  }

  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  return { ref: rest.slice(0, slash), path: rest.slice(slash + 1) };
}

/** Everything after the first `?` or `#` — never part of a repo path. */
function stripUrlTail(value: string): string {
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
}

/** One percent-decode, tolerating a malformed escape by leaving it alone. */
function decodePathOnce(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * An absolute reference into THIS repo → the repo path it names; else null.
 *
 * Null is the answer for every external URL, every other classroom's repo, and
 * every `data:` — the caller leaves those exactly as it found them. The raw
 * shape is matched branch-agnostically (content imported or hand-authored
 * elsewhere may name any branch), which is why the ref is consumed positionally
 * rather than by comparing against a fixed prefix. A COMMIT-pinned raw URL is
 * deliberately not a match: see `isCommitRef`.
 */
export function extractOwnRepoPath(urlOrRef: string, login: string, repo: string): string | null {
  if (typeof urlOrRef !== 'string' || urlOrRef.length === 0) return null;

  const bare = stripUrlTail(urlOrRef);

  const pagesPrefix = `${pagesContentBase(login, repo)}/`;
  if (bare.startsWith(pagesPrefix)) {
    return normalizeExtracted(bare.slice(pagesPrefix.length));
  }

  const proxyPrefix = `${contentProxyBase(login, repo)}/`;
  if (bare.startsWith(proxyPrefix)) {
    return normalizeExtracted(bare.slice(proxyPrefix.length));
  }

  const rawPrefix = `${RAW_HOST}/${login}/${repo}/`;
  if (bare.startsWith(rawPrefix)) {
    // The leading segment(s) are the ref, whatever it is called and however it
    // is qualified.
    const split = splitRawRef(bare.slice(rawPrefix.length));
    if (!split || isCommitRef(split.ref)) return null;
    return normalizeExtracted(split.path);
  }

  return null;
}

function normalizeExtracted(path: string): string | null {
  const decoded = decodePathOnce(path).replace(/^\/+/, '');
  return decoded.length > 0 ? decoded : null;
}
