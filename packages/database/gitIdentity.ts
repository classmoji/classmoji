// Git identity query helpers. Pure (no Prisma client, no process handlers), so
// tests that mock `@classmoji/database` can re-export the real ones with
// `vi.importActual('@classmoji/database/gitIdentity')`.
import type { Prisma } from '@classmoji/database/client';

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
 * `GIT_IDENTITY` without the git account's email: the identity a user is shown
 * by to other people (username, provider id, avatar).
 */
export const GIT_IDENTITY_PUBLIC = {
  accounts: {
    where: { provider_id: { in: ['github', 'gitlab'] } },
    select: {
      provider_id: true,
      account_id: true,
      username: true,
      image: true,
    },
  },
} satisfies Prisma.UserInclude;

/**
 * The user's `avatar_url`, the computed field the database client's result
 * extension adds (`image`, or the default avatar). A `select` returns a
 * computed field only when it names it, so the user selects below name it.
 * Typed `object` because the base client's types do not know the field (as
 * with an `include`, rows carry it at runtime only).
 */
const COMPUTED_AVATAR_URL: object = { avatar_url: true };

/**
 * A user as other people see them: id, name, avatar and git identity. For any
 * user row a read returns to someone other than that user. Never the billing,
 * moderation, sign-in or platform-role columns (`stripe_customer_id`,
 * `banned`/`ban_reason`/`ban_expires_at`, `last_seen_at`, `first_sign_in_at`,
 * `onboarding_completed_at`, `role`), and no email.
 */
export const USER_PUBLIC_SELECT = {
  id: true,
  name: true,
  image: true,
  ...COMPUTED_AVATAR_URL,
  ...GIT_IDENTITY_PUBLIC,
} satisfies Prisma.UserSelect;

/**
 * A user as the classroom's teaching staff see them: `USER_PUBLIC_SELECT` plus
 * the contact columns staff may read (email, school id, and the git account's
 * email). For staff-facing reads of the classroom's people only; never in a
 * payload a student receives about someone else.
 */
export const USER_STAFF_VIEW_SELECT = {
  id: true,
  name: true,
  image: true,
  ...COMPUTED_AVATAR_URL,
  email: true,
  school_id: true,
  ...GIT_IDENTITY,
} satisfies Prisma.UserSelect;

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
