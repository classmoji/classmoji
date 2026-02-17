/**
 * Content repository utilities (browser-safe)
 */

/**
 * Generate term string from term enum and year (e.g., Winter 2025 → "25w")
 * @param {string} term - Term name (Winter, Spring, Summer, Fall)
 * @param {number} year - Full year (e.g., 2025)
 * @returns {string|null} Short term code or null if params missing
 */
export function generateTermString(term, year) {
  if (!term || !year) return null;
  const termMap = { Winter: 'w', Spring: 's', Summer: 'u', Fall: 'f' };
  const yearShort = String(year).slice(-2);
  return `${yearShort}${termMap[term] || term.charAt(0).toLowerCase()}`;
}

/**
 * Generate the content repository name for an organization.
 * Uses settings.content_repo_name if set, otherwise falls back to the default pattern.
 *
 * @param {Object} organization - The organization object with settings, term, year, and login
 * @returns {string} The content repository name (e.g., "content-csc-25w")
 */
export const getContentRepoName = organization => {
  // If explicitly set in settings, use that
  if (organization.settings?.content_repo_name) {
    return organization.settings.content_repo_name;
  }

  // Generate default: content-{org}-{term}
  const orgLogin = organization.login;
  const termCode = generateTermString(organization.term, organization.year);

  return termCode ? `content-${orgLogin}-${termCode}` : `content-${orgLogin}`;
};
