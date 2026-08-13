/**
 * Repository naming helpers (browser-safe)
 */

/**
 * @deprecated LEGACY PATTERN — the content repo name is now STORED on
 * `Classroom.content_repo` and fully user-editable. Nothing derives it at
 * runtime any more; read `classroom.content_repo` instead. Kept only to
 * document the historical name (`content-{orgLogin}-{contentNamespace}`, e.g.
 * `content-dali-26w`) that the 20260813150000_classroom_content_repo migration
 * backfilled existing rows with, and for one-off migration scripts that must
 * reconstruct pre-backfill names.
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
 * Default content repo name for a NEW classroom: `content-{namespace}`.
 *
 * Deliberately does NOT embed the org login — the repo already lives inside the
 * org, so `content-dartmouth-cs52-26f` under org `dartmouth-cs52` just repeated
 * it. Only a default: `Classroom.content_repo` is stored and fully editable, so
 * this is never used to re-derive an existing classroom's repo name.
 *
 * Every classroom-creation path MUST set content_repo (the column is NOT NULL);
 * use this when the caller has no user-supplied name.
 */
export function defaultContentRepoName(namespace: string): string {
  return sanitizeRepoName(`content-${namespace}`);
}

/**
 * Normalize user input into a name GitHub will accept for a repository.
 *
 * GitHub allows only [A-Za-z0-9._-] in repo names; anything else it silently
 * rewrites, so a name that round-trips differently would leave the DB pointing
 * at a repo that doesn't exist. Normalizing up front keeps the stored name and
 * the real repo identical.
 *
 * Rules: lowercase; every run of disallowed characters collapses to a single
 * '-'; leading/trailing dashes and dots are trimmed (GitHub rejects '.' and
 * '..' and dislikes edge punctuation); truncated to GitHub's 100-char cap,
 * then re-trimmed so truncation can't leave a trailing dash.
 *
 * Returns '' when nothing usable survives — callers MUST fall back to a
 * default rather than storing an empty name.
 */
export function sanitizeRepoName(input: string): string {
  const collapsed = String(input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-');
  const trimmed = collapsed.replace(/^[-.]+/, '').replace(/[-.]+$/, '');
  return trimmed.slice(0, GITHUB_REPO_NAME_MAX).replace(/[-.]+$/, '');
}

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
