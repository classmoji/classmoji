/**
 * Student-navigation visibility flags, derived from classroom settings and
 * shared by the role layout loaders (admin/student/assistant) so the nav reads
 * a single, fresh source. Defaults match the Prisma schema: modules off,
 * pages/repos on.
 */
export interface NavVisibility {
  showModules: boolean;
  showPages: boolean;
  showRepos: boolean;
}

export const DEFAULT_NAV_VISIBILITY: NavVisibility = {
  showModules: false,
  showPages: true,
  showRepos: true,
};

// Settings arrive loosely typed (sanitized to Record<string, unknown>), so the
// flags are read defensively while preserving the schema defaults.
export const navVisibilityFromSettings = (
  settings?: { show_modules?: unknown; show_pages?: unknown; show_repos?: unknown } | null
): NavVisibility => ({
  showModules: settings?.show_modules === true,
  showPages: settings?.show_pages !== false,
  showRepos: settings?.show_repos !== false,
});
