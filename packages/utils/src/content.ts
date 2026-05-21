/**
 * Content repository utilities (browser-safe)
 */

interface Organization {
  login: string;
  term?: string;
  year?: number;
  content_namespace?: string;
  settings?: {
    content_repo_name?: string;
  };
}

/**
 * Generate term string from term enum and year (e.g., Winter 2025 -> "25w")
 *
 * @deprecated kept temporarily for backward compatibility during the term
 * removal migration. New code should use `classroom.content_namespace`.
 */
export function generateTermString(
  term: string | undefined,
  year: number | undefined
): string | null {
  if (!term || !year) return null;
  const termMap: Record<string, string> = { Winter: 'w', Spring: 's', Summer: 'u', Fall: 'f' };
  const yearShort = String(year).slice(-2);
  return `${yearShort}${termMap[term] || term.charAt(0).toLowerCase()}`;
}

/**
 * Generate the content repository name for an organization.
 * Uses settings.content_repo_name if set, otherwise falls back to the default pattern.
 *
 * If a `content_namespace` is provided, the repo is namespaced as
 * `content-{login}-{namespace}`; otherwise it falls back to `content-{login}`.
 */
export const getContentRepoName = (organization: Organization): string => {
  if (organization.settings?.content_repo_name) {
    return organization.settings.content_repo_name;
  }

  const orgLogin = organization.login;
  const namespace = organization.content_namespace;

  return namespace ? `content-${orgLogin}-${namespace}` : `content-${orgLogin}`;
};
