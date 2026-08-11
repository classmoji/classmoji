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
