/**
 * Records an OAuth provider profile (username, email, avatar) on the user's
 * Account row at sign-in and when an account is connected.
 *
 * Lives outside ./server.ts so the rules can be unit-tested without standing up
 * betterAuth. `mapGitHubProfile` runs BEFORE better-auth's findOAuthUser lookup;
 * what it returns is only used when better-auth creates a brand-new user.
 *
 * Git identity is per account: a Github username is only ever compared with
 * other Github accounts' usernames, never with another provider's.
 */

import type { PrismaClient } from '@prisma/client';
import { parseGitlabId, scopeGitlabId } from '@classmoji/utils';

type Prisma = Pick<PrismaClient, 'user' | 'account'>;

type ProviderId = 'github' | 'gitlab';

interface ProviderProfile {
  username: string | null;
  email: string | null;
  image: string | null;
}

/** Prefix of placeholder account ids for users known only by a Github username. */
export const UNRESOLVED_ACCOUNT_PREFIX = 'unresolved:';

/**
 * Github sign-in (and Github connect from settings; better-auth runs this in
 * both flows). Keeps the stored profile current and claims a placeholder
 * account left for a user who was added by username before they ever signed in.
 */
export async function mapGitHubProfile(
  prisma: Prisma,
  profile: {
    id: number | string;
    login: string;
    email?: string | null;
    avatar_url?: string | null;
  }
): Promise<{ emailVerified: false }> {
  const githubId = String(profile.id);
  const note: ProviderProfile = {
    username: profile.login || null,
    email: profile.email ?? null,
    image: profile.avatar_url ?? null,
  };

  try {
    // Claim a placeholder held under this username, so better-auth's
    // (provider_id, account_id) lookup lands on that user.
    if (note.username) {
      const alreadyLinked = await prisma.account.findFirst({
        where: { provider_id: 'github', account_id: githubId },
        select: { id: true },
      });
      if (!alreadyLinked) {
        const placeholder = await prisma.account.findFirst({
          where: {
            provider_id: 'github',
            account_id: { startsWith: UNRESOLVED_ACCOUNT_PREFIX },
            username: { equals: note.username, mode: 'insensitive' },
          },
          select: { id: true },
        });
        if (placeholder) {
          await prisma.account.update({
            where: { id: placeholder.id },
            data: { account_id: githubId },
          });
        }
      }
    }
  } catch (error: unknown) {
    // Never block sign-in on the claim; better-auth then treats this as a new
    // Github account.
    console.error('[auth] Github placeholder claim failed', error);
  }

  await noteProviderProfile(prisma, 'github', githubId, note);

  // A brand-new user must still confirm a contact email at registration: the
  // Github email lands in users.email unverified.
  return { emailVerified: false };
}

/**
 * Gitlab sign-in (gitlab.com through socialProviders, a self-managed instance
 * through the gitlabInstances plugin) and Gitlab connect from settings. Records
 * the profile the same way as Github. A Gitlab account is only ever found by
 * its own (provider_id, account_id), never claimed by username.
 *
 * `instanceId` is the self-managed instance signed in with (null: the default
 * instance). Gitlab ids repeat across instances, so the stored id is scoped.
 */
export async function mapGitLabProfile(
  prisma: Prisma,
  profile: {
    id: number | string;
    username: string;
    email?: string | null;
    avatar_url?: string | null;
  },
  instanceId: string | null = null
): Promise<{ emailVerified: false }> {
  await noteProviderProfile(prisma, 'gitlab', scopeGitlabId(instanceId, profile.id), {
    username: profile.username || null,
    email: profile.email ?? null,
    image: profile.avatar_url ?? null,
  });
  return { emailVerified: false };
}

// ─── Parking the profile for the account-create hook ────────────────────────
//
// On a first sign-in or a connect, the mapper runs before the account row
// exists (better-auth writes only ids and tokens on it), so the profile is
// parked here and written by the account-create hook later in the same request.

const pendingProfiles = new Map<string, ProviderProfile & { at: number }>();
const PENDING_TTL_MS = 5 * 60 * 1000;
const pendingKey = (providerId: string, accountId: string) => `${providerId}:${accountId}`;

/** Records the profile: now on an existing row, later (via onAccountCreated) on a new one. */
async function noteProviderProfile(
  prisma: Prisma,
  providerId: ProviderId,
  accountId: string,
  profile: ProviderProfile
): Promise<void> {
  const now = Date.now();
  for (const [key, entry] of pendingProfiles) {
    if (now - entry.at > PENDING_TTL_MS) pendingProfiles.delete(key);
  }
  pendingProfiles.set(pendingKey(providerId, accountId), { ...profile, at: now });

  try {
    const existing = await prisma.account.findFirst({
      where: { provider_id: providerId, account_id: accountId },
      select: { id: true, user_id: true },
    });
    if (existing) await writeProfile(prisma, providerId, accountId, existing, profile);
  } catch (error: unknown) {
    console.error('[auth] provider profile update failed', error);
  }
}

/**
 * Runs after better-auth creates an Account row (first sign-in, or connect in
 * settings). Stores the parked profile on it. Never throws: a failure here must
 * not undo the sign-in.
 */
export async function onAccountCreated(
  prisma: Prisma,
  account: { id: string; providerId: string; accountId: string; userId: string }
): Promise<void> {
  if (account.providerId !== 'github' && account.providerId !== 'gitlab') return;
  const key = pendingKey(account.providerId, account.accountId);
  const profile = pendingProfiles.get(key);
  pendingProfiles.delete(key);
  if (!profile) return;

  try {
    await writeProfile(
      prisma,
      account.providerId,
      account.accountId,
      { id: account.id, user_id: account.userId },
      profile
    );
  } catch (error: unknown) {
    console.error('[auth] recording account profile failed', error);
  }
}

/** The GitLab server an account lives on ("" for gitlab.com and other providers). */
export const accountGitlabInstanceId = (providerId: string, accountId: string): string =>
  providerId === 'gitlab' ? (parseGitlabId(accountId).instanceId ?? '') : '';

async function writeProfile(
  prisma: Prisma,
  providerId: ProviderId,
  accountId: string,
  account: { id: string; user_id: string },
  profile: ProviderProfile
): Promise<void> {
  const gitlabInstanceId = accountGitlabInstanceId(providerId, accountId);
  if (profile.username) {
    // Usernames are unique per provider and server. One held by another
    // account there is stale (that account renamed, and the name was reused):
    // release it. Another GitLab server's `jdoe` is someone else and keeps it.
    await prisma.account.updateMany({
      where: {
        provider_id: providerId,
        gitlab_instance_id: gitlabInstanceId,
        username: { equals: profile.username, mode: 'insensitive' },
        NOT: { id: account.id },
      },
      data: { username: null },
    });
  }
  await prisma.account.update({
    where: { id: account.id },
    data: {
      gitlab_instance_id: gitlabInstanceId,
      ...(profile.username ? { username: profile.username } : {}),
      ...(profile.email ? { email: profile.email } : {}),
      ...(profile.image ? { image: profile.image } : {}),
    },
  });
  // The displayed avatar is the Github one; without Github connected, Gitlab's.
  if (profile.image) {
    const showsThis =
      providerId === 'github' ||
      !(await prisma.account.findFirst({
        where: { user_id: account.user_id, provider_id: 'github' },
        select: { id: true },
      }));
    if (showsThis) {
      await prisma.user.update({ where: { id: account.user_id }, data: { image: profile.image } });
    }
  }
}
