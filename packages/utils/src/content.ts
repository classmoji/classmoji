/**
 * Content repository utilities (browser-safe)
 */

interface Organization {
  login: string;
  settings?: {
    content_repo_name?: string;
  };
}

/**
 * Generate the content repository name for an organization.
 * Uses settings.content_repo_name if set, otherwise falls back to `content-{login}`.
 *
 * Per-classroom repo names (`content-{org}-{namespace}`) are built inline at
 * call sites with `classroom.content_namespace`. This helper is for org-level
 * fallback only.
 */
export const getContentRepoName = (organization: Organization): string => {
  if (organization.settings?.content_repo_name) {
    return organization.settings.content_repo_name;
  }
  return `content-${organization.login}`;
};
