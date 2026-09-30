/**
 * Git identity lives on a user's Account rows, not on User: one user can hold
 * a Github account, a GitLab account and a password account at once. Each git
 * account carries that provider's username.
 *
 * Queries load it with `GIT_IDENTITY` (`@classmoji/database`); these helpers
 * read it back. Anything stored or queried says `username`; objects handed to
 * the UI are flattened to a `login` (the git username shown and linked to).
 */

export type GitProviderName = 'GITHUB' | 'GITLAB' | 'BITBUCKET' | 'GITEA';

export interface GitIdentityAccount {
  provider_id: string;
  username: string | null;
  account_id?: string;
  image?: string | null;
  email?: string | null;
}

export interface WithGitAccounts {
  accounts?: GitIdentityAccount[] | null;
}

/** better-auth provider id for a git provider: 'GITHUB' → 'github'. */
export const accountProviderId = (provider?: GitProviderName | string | null): string =>
  (provider || 'GITHUB').toLowerCase();

/** The user's account on `provider`, or null when they have not connected it. */
export function gitAccount(
  user: WithGitAccounts | null | undefined,
  provider: GitProviderName | string | null = 'GITHUB'
): GitIdentityAccount | null {
  const providerId = accountProviderId(provider);
  return user?.accounts?.find(account => account.provider_id === providerId) ?? null;
}

/** The user's username on `provider` (Github login, GitLab username), or null. */
export function gitUsername(
  user: (WithGitAccounts & { login?: string | null }) | null | undefined,
  provider: GitProviderName | string | null = 'GITHUB'
): string | null {
  if (!user) return null;
  if (!user.accounts && user.login !== undefined) return user.login ?? null;
  return gitAccount(user, provider)?.username ?? null;
}

/** The user's id on `provider` (the account's `account_id`), or null. */
export function gitAccountId(
  user: WithGitAccounts | null | undefined,
  provider: GitProviderName | string | null = 'GITHUB'
): string | null {
  const accountId = gitAccount(user, provider)?.account_id;
  // Placeholder rows for users known only by username are not real ids.
  return accountId && !accountId.startsWith('unresolved:') ? accountId : null;
}

/** Display username: Github first, then any other connected git provider. */
export function displayUsername(user: WithGitAccounts | null | undefined): string | null {
  if (!user?.accounts?.length) return null;
  return (
    gitAccount(user, 'GITHUB')?.username ??
    user.accounts.find(account => account.username)?.username ??
    null
  );
}

type Flattened<T> = Omit<T, 'accounts'> & { login: string | null };

/**
 * Replaces a user's identity `accounts` with `login` (their git username).
 * `provider` picks which account's username; by default Github, falling back to
 * any other connected git provider.
 */
export function withLogin<T extends WithGitAccounts>(
  user: T,
  provider?: GitProviderName | string | null
): Flattened<T> {
  const { accounts: _accounts, ...rest } = user;
  const login = provider ? gitUsername(user, provider) : displayUsername(user);
  return { ...rest, login } as Flattened<T>;
}

/** Recursively flattens every identity-bearing object inside `value` (see `withLogin`). */
export type WithLogins<T> = T extends Date
  ? T
  : T extends ReadonlyArray<infer U>
    ? WithLogins<U>[]
    : T extends object
      ? T extends { accounts: GitIdentityAccount[] }
        ? { [K in keyof Omit<T, 'accounts'>]: WithLogins<T[K]> } & { login: string | null }
        : { [K in keyof T]: WithLogins<T[K]> }
      : T;

const isIdentityAccounts = (value: unknown): value is GitIdentityAccount[] =>
  Array.isArray(value) &&
  value.every(
    item =>
      item !== null &&
      typeof item === 'object' &&
      'provider_id' in item &&
      'username' in item &&
      !('access_token' in item)
  );

/**
 * Walks a query result and flattens every object carrying identity `accounts`
 * into one with `login`. For loaders and API responses that return users
 * nested at any depth.
 */
export function withLogins<T>(value: T, provider?: GitProviderName | string | null): WithLogins<T> {
  const visit = (node: unknown): unknown => {
    if (node === null || typeof node !== 'object' || node instanceof Date) return node;
    if (Array.isArray(node)) return node.map(visit);
    const out: Record<string, unknown> = {};
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key === 'accounts' && isIdentityAccounts(record.accounts)) continue;
      out[key] = visit(record[key]);
    }
    if (isIdentityAccounts(record.accounts)) {
      const identity = { accounts: record.accounts };
      out.login = provider ? gitUsername(identity, provider) : displayUsername(identity);
    }
    return out;
  };
  return visit(value) as WithLogins<T>;
}
