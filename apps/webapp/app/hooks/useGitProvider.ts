import type { GitProvider } from '@prisma/client';

import { useUser } from './useUser';

/**
 * The signed-in user's git platform. Every classroom member has a connected
 * Github account (the root loader requires it), so this is `GITHUB`; kept as a
 * hook so GitLab can be answered from the user's accounts later. Works on
 * every page, including outside a classroom.
 */
export const useGitProvider = (): GitProvider => {
  useUser();
  return 'GITHUB';
};
