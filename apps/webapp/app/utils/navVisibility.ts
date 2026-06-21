/**
 * Student-navigation visibility flags, derived from classroom settings and
 * shared by the role layout loaders (admin/student/assistant) so the nav reads
 * a single, fresh source. Defaults match the Prisma schema: modules, pages,
 * and repos all on.
 */
export interface NavVisibility {
  showModules: boolean;
  showPages: boolean;
  showRepos: boolean;
  /**
   * Whether the classroom actually has any modules (published for students,
   * any for staff). The Modules nav item is hidden from non-owners when false,
   * so profs who never use modules don't show students an empty tab. Optional
   * so existing callers and error fallbacks default to showing it.
   */
  hasModules?: boolean;
}

export const DEFAULT_NAV_VISIBILITY: NavVisibility = {
  showModules: true,
  showPages: true,
  showRepos: true,
  hasModules: true,
};

// Settings arrive loosely typed (sanitized to Record<string, unknown>), so the
// flags are read defensively while preserving the schema defaults.
export const navVisibilityFromSettings = (
  settings?: { show_modules?: unknown; show_pages?: unknown; show_repos?: unknown } | null
): NavVisibility => ({
  showModules: settings?.show_modules !== false,
  showPages: settings?.show_pages !== false,
  showRepos: settings?.show_repos !== false,
});
