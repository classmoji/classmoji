import type { GitProvider } from '@prisma/client';

import { useUser } from './useUser';

/**
 * The signed-in user's git platform (their login provider).
 *
 * Reads `user.provider`. Legacy rows pre-date GitLab support and are GitHub
 * users, so null/unknown normalizes to `GITHUB` (same convention as
 * `ProviderBadge`). Works on every page, including outside a classroom.
 */
export const useGitProvider = (): GitProvider => {
  const { user } = useUser();
  return (user?.provider ?? 'GITHUB') as GitProvider;
};
