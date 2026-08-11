/**
 * Repository naming helpers (browser-safe)
 */

/**
 * Generate the per-classroom content repository name.
 * Pattern: `content-{orgLogin}-{contentNamespace}` (e.g. `content-dali-26w`).
 *
 * Distinct from the legacy org-level helper `getContentRepoName` in
 * `content.ts` (`content-{login}`, with a settings override) — that names a
 * DIFFERENT repo; do not unify them.
 */
export function classroomContentRepoName({
  login,
  namespace,
}: {
  login: string;
  namespace: string;
}): string {
  return `content-${login}-${namespace}`;
}

/** GitHub caps repository names at 100 characters. */
export const GITHUB_REPO_NAME_MAX = 100;

/**
 * Longest content namespace that keeps `content-{login}-{namespace}` within
 * GitHub's repo-name limit for the given org login.
 */
export function maxContentNamespaceLength(login: string): number {
  return GITHUB_REPO_NAME_MAX - 'content-'.length - login.length - 1;
}

/**
 * Suggested content namespace for a new classroom: the classroom slug with the
 * git org's login stripped off the front, so the derived repo name
 * `content-{login}-{namespace}` doesn't repeat the org (classroom slugs
 * conventionally start with the course/org name — `dartmouth-cs52-26f` under
 * org `dartmouth-cs52` would otherwise mint
 * `content-dartmouth-cs52-dartmouth-cs52-26f`).
 *
 * Falls back to the full slug when stripping wouldn't help: no prefix overlap,
 * or nothing meaningful left after the strip (slug === login).
 */
export function suggestContentNamespace({
  orgLogin,
  slug,
}: {
  orgLogin: string;
  slug: string;
}): string {
  const login = orgLogin.toLowerCase();
  const prefix = `${login}-`;
  if (slug.startsWith(prefix)) {
    const rest = slug.slice(prefix.length);
    if (rest.length > 0) return rest;
  }
  return slug;
}
