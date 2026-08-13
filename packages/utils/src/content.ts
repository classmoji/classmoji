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
 * Per-classroom content repos are a DIFFERENT repo: their name is stored on
 * `Classroom.content_repo` (user-editable, never derived). This helper is for
 * the org-level fallback only — do not unify the two.
 */
export const getContentRepoName = (organization: Organization): string => {
  if (organization.settings?.content_repo_name) {
    return organization.settings.content_repo_name;
  }
  return `content-${organization.login}`;
};
