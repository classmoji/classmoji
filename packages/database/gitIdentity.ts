// Git identity query helpers. Pure (no Prisma client, no process handlers), so
// tests that mock `@classmoji/database` can re-export the real ones with
// `vi.importActual('@classmoji/database/gitIdentity')`.
import type { Prisma } from '@prisma/client';

/**
 * Loads a user's git identity (Github / GitLab username, id, avatar) from their
 * Account rows. Include it wherever a user's git username is needed and read it
 * with `gitUsername` / `withLogin` / `withLogins` from `@classmoji/utils`.
 * Never selects tokens or password hashes, so results are safe to serialize.
 */
export const GIT_IDENTITY = {
  accounts: {
    where: { provider_id: { in: ['github', 'gitlab'] } },
    select: {
      provider_id: true,
      account_id: true,
      username: true,
      image: true,
      email: true,
    },
  },
} satisfies Prisma.UserInclude;

/**
 * Where a git username is looked up: a provider (`'GITHUB'`, `'GITLAB'`), or a
 * git organization (`{ provider, gitlab_instance_id }`). GitLab usernames are
 * unique per server, so pass the organization whenever the lookup belongs to a
 * classroom: a bare `'GITLAB'` matches that username on any GitLab server.
 */
export type GitUsernameScope =
  | string
  | null
  | { provider: string | null; gitlab_instance_id?: string | null };

/** The provider a scope names ('GITHUB' when unset). */
export const gitScopeProvider = (scope: GitUsernameScope = 'GITHUB'): string =>
  (typeof scope === 'object' && scope ? scope.provider : scope) || 'GITHUB';

/** The account filter for `scope`: provider, plus the GitLab server when known. */
const scopeFilter = (scope: GitUsernameScope = 'GITHUB') => {
  const provider_id = gitScopeProvider(scope).toLowerCase();
  if (provider_id !== 'gitlab' || !scope || typeof scope !== 'object') return { provider_id };
  return { provider_id, gitlab_instance_id: scope.gitlab_instance_id ?? '' };
};

/** `where` filter: users whose username in `scope` is `username` (case-insensitive). */
export const whereGitUsername = (
  username: string,
  scope: GitUsernameScope = 'GITHUB'
): Prisma.UserWhereInput => ({
  accounts: {
    some: {
      ...scopeFilter(scope),
      username: { equals: username, mode: 'insensitive' },
    },
  },
});

/** `where` filter: users whose username in `scope` is any of `usernames` (exact). */
export const whereGitUsernameIn = (
  usernames: string[],
  scope: GitUsernameScope = 'GITHUB'
): Prisma.UserWhereInput => ({
  accounts: {
    some: { ...scopeFilter(scope), username: { in: usernames } },
  },
});
