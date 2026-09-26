/**
 * Maps an OAuth provider profile onto our User fields at sign-in.
 *
 * Lives outside ./server.ts so the matching rules can be unit-tested without
 * standing up betterAuth. Both mappers run BEFORE better-auth's findOAuthUser
 * lookup, and what they return is only used when better-auth creates a
 * genuinely new user.
 *
 * `User.login` is unique across every provider, so a username is never proof of
 * identity on its own: Github `jdoe` and GitLab `jdoe` can be different people.
 * A login match is therefore only ever trusted within the same provider.
 */

import type { PrismaClient } from '@prisma/client';

type Prisma = Pick<PrismaClient, 'user' | 'account'>;

interface ProviderUserFields {
  login: string | null;
  provider: 'GITHUB' | 'GITLAB';
  provider_id: string;
}

/**
 * Github sign-in. Links a pre-provisioned user (roster/assistant invites create
 * users by username with no provider linkage) instead of letting better-auth
 * collide on the unique `login`. Only users that are Github's or not yet tied to
 * any provider can be claimed by login.
 */
export async function mapGitHubProfile(
  prisma: Prisma,
  profile: { id: number | string; login: string }
): Promise<ProviderUserFields> {
  const githubId = String(profile.id);
  const login = profile.login;
  await noteProviderUsername(prisma, 'github', githubId, login);

  // An already-connected Github account (e.g. linked before usernames were
  // recorded, or renamed on Github): make sure its username is the main login.
  try {
    const linked = await prisma.account.findFirst({
      where: { provider_id: 'github', account_id: githubId },
      select: { user_id: true },
    });
    if (linked) await promoteGitHubLogin(prisma, linked.user_id, githubId, login);
  } catch (error: unknown) {
    console.error('[auth] Github login promotion failed', error);
  }

  // ── Link existing users instead of colliding on the unique `login` ──────
  // Users can already exist in our DB without a linked Github account:
  //  - pre-provisioned by username via ClassmojiService.user.create (login
  //    set, no provider_id / no account row), e.g. roster/assistant invites
  //  - a prior login whose account row was removed
  // If we link the account here, findOAuthUser finds it and takes the
  // (non-destructive) link path — instead of falling through to
  // createOAuthUser, which would throw `unable to create user` on the
  // `login`/`provider` unique constraints.
  try {
    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { provider: 'GITHUB', provider_id: githubId },
          // A GitLab user holding this login is someone else: never claim it.
          { login, OR: [{ provider: null }, { provider: 'GITHUB' }] },
        ],
      },
      include: {
        accounts: { where: { provider_id: 'github' }, select: { id: true } },
      },
    });

    if (existing && existing.accounts.length === 0) {
      // Backfill provider linkage on the existing record (login-only invites
      // have a null provider_id) so the (provider, provider_id) unique key and
      // future lookups resolve correctly.
      await prisma.user.update({
        where: { id: existing.id },
        data: {
          provider: 'GITHUB',
          provider_id: githubId,
          login: existing.login ?? login,
        },
      });

      // Create the account link BetterAuth looks up by (provider_id, account_id).
      // Tokens are intentionally left null — BetterAuth fills them on this same
      // sign-in once it resolves the linked account.
      await prisma.account.upsert({
        where: {
          provider_id_account_id: { provider_id: 'github', account_id: githubId },
        },
        update: {},
        create: {
          user_id: existing.id,
          provider_id: 'github',
          account_id: githubId,
          username: login,
        },
      });
    }
  } catch (error: unknown) {
    // Never block sign-in on the linking attempt; if it fails, BetterAuth
    // proceeds with its default behavior and we surface its error as before.
    console.error('[auth] mapProfileToUser account-link failed', error);
  }

  return { login, provider: 'GITHUB', provider_id: githubId };
}

/**
 * GitLab sign-in. Never links to an existing user: a GitLab account only ever
 * resolves through its own account row (better-auth's lookup), so a returning
 * GitLab user is found by id and a new one gets a fresh user.
 *
 * The GitLab username becomes `login` only when nobody holds it. Otherwise
 * `login` stays null rather than failing sign-in on the unique constraint.
 */
export async function mapGitLabProfile(
  prisma: Prisma,
  profile: { id: number | string; username: string }
): Promise<ProviderUserFields> {
  const gitlabId = String(profile.id);
  let login: string | null = profile.username || null;
  await noteProviderUsername(prisma, 'gitlab', gitlabId, profile.username);

  if (login) {
    try {
      const holder = await prisma.user.findFirst({
        where: { login },
        select: { provider: true, provider_id: true },
      });
      // A returning GitLab user already holds their own login; anyone else
      // holding it means the name is taken.
      if (holder && !(holder.provider === 'GITLAB' && holder.provider_id === gitlabId)) {
        login = null;
      }
    } catch (error: unknown) {
      console.error('[auth] GitLab login availability check failed', error);
      login = null;
    }
  }

  return { login, provider: 'GITLAB', provider_id: gitlabId };
}

// ─── Per-provider usernames ──────────────────────────────────────────────────
//
// A user with Github and GitLab connected has two usernames; each lives on its
// Account row. The mappers above see the provider profile but run before the
// account row exists on a first sign-in or link, so the username is parked here
// and written by the account-create hook later in the same request.

type ProviderId = 'github' | 'gitlab';

const pendingUsernames = new Map<string, { username: string; at: number }>();
const PENDING_TTL_MS = 5 * 60 * 1000;
const pendingKey = (providerId: string, accountId: string) => `${providerId}:${accountId}`;

/** Records the profile's username: now for an existing row, later for a new one. */
async function noteProviderUsername(
  prisma: Prisma,
  providerId: ProviderId,
  accountId: string,
  username: string | null | undefined
): Promise<void> {
  if (!username) return;
  const now = Date.now();
  for (const [key, entry] of pendingUsernames) {
    if (now - entry.at > PENDING_TTL_MS) pendingUsernames.delete(key);
  }
  pendingUsernames.set(pendingKey(providerId, accountId), { username, at: now });
  try {
    // Returning sign-ins: keep the stored username current (renames).
    await prisma.account.updateMany({
      where: { provider_id: providerId, account_id: accountId },
      data: { username },
    });
  } catch (error: unknown) {
    console.error('[auth] provider username update failed', error);
  }
}

/**
 * Runs after better-auth creates an Account row (first sign-in, or Connect in
 * settings). Stores the provider username on it, and when the new account is
 * Github, makes the Github username the user's main `login`: every Github-side
 * operation (course invites, repo names, repo access) reads `User.login` as a
 * Github username. Never throws; a failure here must not undo the sign-in.
 */
export async function onAccountCreated(
  prisma: Prisma,
  account: { id: string; providerId: string; accountId: string; userId: string }
): Promise<void> {
  const key = pendingKey(account.providerId, account.accountId);
  const username = pendingUsernames.get(key)?.username;
  pendingUsernames.delete(key);
  if (!username) return;

  try {
    await prisma.account.update({ where: { id: account.id }, data: { username } });
    if (account.providerId === 'github') {
      await promoteGitHubLogin(prisma, account.userId, account.accountId, username);
    }
  } catch (error: unknown) {
    console.error('[auth] recording account username failed', error);
  }
}

/**
 * Makes `githubLogin` the user's main login. Skipped when another user already
 * holds it (their `login` is unique): the user keeps their current login and
 * Github courses stay closed to them until that is resolved.
 */
export async function promoteGitHubLogin(
  prisma: Prisma,
  userId: string,
  githubId: string,
  githubLogin: string
): Promise<'promoted' | 'unchanged' | 'taken'> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { login: true, provider: true },
  });
  if (!user) return 'unchanged';
  if ((user.provider ?? 'GITHUB') === 'GITHUB' && user.login === githubLogin) return 'unchanged';

  const holder = await prisma.user.findFirst({
    where: { login: githubLogin, NOT: { id: userId } },
    select: { id: true },
  });
  if (holder) return 'taken';

  await prisma.user.update({
    where: { id: userId },
    data: { login: githubLogin, provider: 'GITHUB', provider_id: githubId },
  });
  return 'promoted';
}
