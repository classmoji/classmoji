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
 * shape is matched branch-agnostically (the rewriter only ever writes `main`,
 * but content imported or hand-authored elsewhere may name another branch),
 * which is why the branch segment is consumed positionally rather than by
 * comparing against a fixed prefix.
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
    // The next segment is the branch/ref, whatever it is called.
    const rest = bare.slice(rawPrefix.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) return null;
    return normalizeExtracted(rest.slice(slash + 1));
  }

  return null;
}

function normalizeExtracted(path: string): string | null {
  const decoded = decodePathOnce(path).replace(/^\/+/, '');
  return decoded.length > 0 ? decoded : null;
}
