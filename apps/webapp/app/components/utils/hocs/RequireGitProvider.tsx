import type { GitProvider } from '@prisma/client';

import { useGitProvider } from '~/hooks';

interface RequireGitProviderProps {
  /** Platform(s) that should see `children`. e.g. "GITHUB" or ["GITHUB", "GITLAB"]. */
  provider: GitProvider | GitProvider[];
  children: React.ReactNode;
  /** Rendered when the current platform doesn't match. Defaults to nothing. */
  fallback?: React.ReactNode;
}

/**
 * Show/hide UI based on the signed-in user's git platform (login provider).
 * Mirrors the `RequireRole` wrapper. Reads `useGitProvider()`.
 */
const RequireGitProvider = ({ provider, children, fallback = null }: RequireGitProviderProps) => {
  const current = useGitProvider();
  const allowed = Array.isArray(provider) ? provider : [provider];
  return allowed.includes(current) ? children : fallback;
};

export default RequireGitProvider;
