import getPrisma from '@classmoji/database';
import type { GitOrganization, GitProvider, Prisma } from '@prisma/client';
import type { Octokit } from 'octokit';
import { GitHubProvider } from '../git/GitHubProvider.ts';

/**
 * Find a GitOrganization by its UUID
 * @param {string} id - UUID of the GitOrganization
 * @returns {Promise<Object|null>}
 */
export const findById = async (id: string) => {
  return getPrisma().gitOrganization.findUnique({
    where: { id },
    include: {
      classrooms: true,
    },
  });
};

/**
 * Find a GitOrganization by provider and provider_id
 * @param {string} provider - Git provider (GITHUB, GITLAB, etc.)
 * @param {string} providerId - Provider-specific ID (GitHub org ID, GitLab group ID)
 * @returns {Promise<Object|null>}
 */
export const findByProviderId = async (provider: GitProvider, providerId: string) => {
  return getPrisma().gitOrganization.findUnique({
    where: {
      provider_provider_id: {
        provider,
        provider_id: providerId,
      },
    },
    include: {
      classrooms: true,
    },
  });
};

/**
 * Find a GitOrganization by provider and login
 * @param {string} provider - Git provider (GITHUB, GITLAB, etc.)
 * @param {string} login - Organization login/slug on the provider
 * @returns {Promise<Object|null>}
 */
export const findByLogin = async (provider: GitProvider, login: string) => {
  return getPrisma().gitOrganization.findFirst({
    where: {
      provider,
      login,
    },
    include: {
      classrooms: true,
    },
  });
};

/**
 * Find all GitOrganizations
 * @param {Object} query - Optional where clause
 * @param {Object} include - Optional include clause
 * @returns {Promise<Object[]>}
 */
export const findAll = async (
  query: Prisma.GitOrganizationWhereInput = {},
  include: Prisma.GitOrganizationInclude = { classrooms: true }
) => {
  return getPrisma().gitOrganization.findMany({
    where: query,
    include,
  });
};

/**
 * Create a new GitOrganization
 * @param {Object} data - GitOrganization data
 * @param {string} data.provider - Git provider (GITHUB, GITLAB, etc.)
 * @param {string} data.provider_id - Provider-specific ID
 * @param {string} data.login - Organization login/slug
 * @param {string} [data.name] - Display name
 * @param {string} [data.github_installation_id] - GitHub App installation ID
 * @param {string} [data.access_token] - Access token for GitLab/Gitea/Bitbucket
 * @param {string} [data.base_url] - Base URL for self-hosted providers
 * @returns {Promise<Object>}
 */
export const create = async (data: Prisma.GitOrganizationUncheckedCreateInput) => {
  return getPrisma().gitOrganization.create({
    data,
    include: {
      classrooms: true,
    },
  });
};

/**
 * Create or update a GitOrganization (upsert)
 * @param {Object} data - GitOrganization data
 * @returns {Promise<Object>}
 */
export const upsert = async (data: Prisma.GitOrganizationUncheckedCreateInput) => {
  const { provider, provider_id, ...rest } = data;

  return getPrisma().gitOrganization.upsert({
    where: {
      provider_provider_id: {
        provider,
        provider_id,
      },
    },
    create: {
      provider,
      provider_id,
      ...rest,
    },
    update: rest,
    include: {
      classrooms: true,
    },
  });
};

export interface SyncedInstallation {
  provider_id: string;
  login: string;
  github_installation_id: string;
  avatar_url: string;
}

/**
 * Sync the GitHub App installations accessible to a user into our database.
 *
 * Reads installations live from GitHub (`GET /user/installations`) and upserts a
 * GitOrganization row for each Organization-account installation. This is what
 * lets the create-classroom flow show a just-installed org immediately, without
 * waiting for the async `installation.created` webhook (which performs the same
 * idempotent upsert as a backup and handles uninstall).
 *
 * Only Organization accounts are returned — the create-classroom action verifies
 * org admin rights, so personal-account installations aren't selectable orgs.
 *
 * Every row written here goes through `validateInstallationIdentity` first. The
 * list is read with the USER's token, so it is a list of installations that user
 * can see — including installations of OTHER GitHub Apps they administer, and
 * suspended ones. Upserting those straight through would write an id that mints
 * no token and then show the org as connected; the same gate the webhook and the
 * repair path run keeps them out. A personal account is skipped quietly (that is
 * the documented filter, not an anomaly); anything else is logged.
 *
 * @param {Octokit} octokit - Octokit authenticated with the user's token
 *   (from `GitHubProvider.getUserOctokit`).
 * @returns {Promise<SyncedInstallation[]>} the synced Organization installations.
 */
export const syncUserInstallations = async (octokit: Octokit): Promise<SyncedInstallation[]> => {
  const installations = await octokit.paginate(
    octokit.rest.apps.listInstallationsForAuthenticatedUser,
    { per_page: 100 }
  );

  const orgInstallations: SyncedInstallation[] = [];

  for (const inst of installations) {
    const accountId = inst.account && 'id' in inst.account ? inst.account.id : undefined;
    if (accountId === undefined || accountId === null) continue;

    const validation = validateInstallationIdentity(inst as InstallationLike, {
      providerId: String(accountId),
    });

    if (!validation.ok) {
      if (validation.reason !== 'not-organization') {
        console.warn(
          `[git-org-sync] user installation=${inst.id} account=${accountId} skipped: ${validation.reason}`
        );
      }
      continue;
    }

    orgInstallations.push(validation.synced);
  }

  await Promise.all(
    orgInstallations.map(inst =>
      upsert({
        provider: 'GITHUB',
        provider_id: inst.provider_id,
        login: inst.login,
        github_installation_id: inst.github_installation_id,
      })
    )
  );

  return orgInstallations;
};

/**
 * Resolve a single GitHub App installation by its id (app-authenticated) and
 * upsert it as a GitOrganization.
 *
 * Used right after install: the list endpoint (`GET /user/installations`) is
 * eventually consistent and may not yet include a brand-new installation, but a
 * direct lookup by id is immediately consistent. GitHub hands us the
 * `installation_id` in the post-install redirect, so the create-classroom loader
 * uses this to guarantee the just-installed org appears on first render.
 *
 * Returns the synced installation, or null if it isn't an Organization account
 * or the lookup fails.
 *
 * @param {Octokit} appOctokit - App-JWT Octokit (`GitHubProvider.getAppOctokit`).
 * @param {string|number} installationId - The GitHub App installation id.
 * @returns {Promise<SyncedInstallation | null>}
 */
export const syncInstallationById = async (
  appOctokit: Octokit,
  installationId: string | number
): Promise<SyncedInstallation | null> => {
  const { data } = await appOctokit.rest.apps.getInstallation({
    installation_id: Number(installationId),
  });

  const account = data.account;
  if (!account || account.id === undefined || account.id === null) {
    return null;
  }

  // The installation GitHub just handed back has to be OURS, for an
  // Organization, and live. Note what this call can and cannot check: the
  // provider id passed in comes from the SAME response, so the account-mismatch
  // arm cannot fire here — this path enforces org-type, app identity and
  // suspension only. What stops a post-install redirect carrying somebody
  // else's `installation_id` from minting or moving a GitOrganization is the
  // caller's org-admin check, not this validation.
  const validation = validateInstallationIdentity(data, { providerId: String(account.id) });
  if (!validation.ok) {
    console.warn(`[git-org-sync] installation=${installationId} rejected: ${validation.reason}`);
    return null;
  }

  const synced = validation.synced;

  await upsert({
    provider: 'GITHUB',
    provider_id: synced.provider_id,
    login: synced.login,
    github_installation_id: synced.github_installation_id,
  });

  return synced;
};

/**
 * Update a GitOrganization
 * @param {string} id - UUID of the GitOrganization
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>}
 */
export const update = async (id: string, updates: Prisma.GitOrganizationUpdateInput) => {
  return getPrisma().gitOrganization.update({
    where: { id },
    data: updates,
    include: {
      classrooms: true,
    },
  });
};

/**
 * Delete a GitOrganization by ID
 * @param {string} id - UUID of the GitOrganization
 * @returns {Promise<Object>}
 */
export const deleteById = async (id: string) => {
  return getPrisma().gitOrganization.delete({
    where: { id },
  });
};

/**
 * Count classrooms in a GitOrganization
 * Used to determine if it's safe to delete the GitOrganization
 * @param {string} gitOrgId - UUID of the GitOrganization
 * @returns {Promise<number>}
 */
export const countClassrooms = async (gitOrgId: string) => {
  return getPrisma().classroom.count({
    where: { git_org_id: gitOrgId },
  });
};

/**
 * Delete GitOrganization only if it has no classrooms
 * Returns true if deleted, false if still has classrooms
 * @param {string} gitOrgId - UUID of the GitOrganization
 * @returns {Promise<boolean>}
 */
export const deleteIfOrphaned = async (gitOrgId: string) => {
  const classroomCount = await countClassrooms(gitOrgId);

  if (classroomCount > 0) {
    return false;
  }

  await getPrisma().gitOrganization.delete({
    where: { id: gitOrgId },
  });

  return true;
};

// ---------------------------------------------------------------------------
// Installation repair
//
// 45 orgs with real classrooms carry `github_installation_id = NULL` — either
// they were created GitHub-free by the Classroom ZIP import, or a stale
// `installation.deleted` webhook cleared an id that a reinstall had already
// replaced. Everything below exists to put a NULL id back, and to make sure the
// id we put back is the one that actually belongs to that org.
// ---------------------------------------------------------------------------

/**
 * GitHub answered "not now" rather than "no".
 *
 * A rate limit is the one lookup failure that must not read as "the app isn't
 * installed" — the caller has to say "try again in N seconds" instead of
 * telling an instructor to go reinstall an app that is already there.
 */
export class GitHubRateLimitedError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, message = 'GitHub rate limit exceeded') {
    super(message);
    this.name = 'GitHubRateLimitedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The shape of an account on an installation payload, across GitHub's unions. */
export interface InstallationAccountLike {
  id?: number | string;
  login?: string;
  type?: string;
  avatar_url?: string;
}

/**
 * The subset of a GitHub App installation this module reads.
 *
 * Structural on purpose: the same validation runs over `apps.getInstallation`,
 * `apps.getOrgInstallation`, `apps.listInstallations` and a raw webhook payload,
 * and Octokit types those four differently.
 */
export interface InstallationLike {
  id: number | string;
  app_id?: number | string;
  app_slug?: string;
  suspended_at?: string | null;
  account?: InstallationAccountLike | null;
}

/** Why an installation is not one we may write a row for. */
export type InstallationRejection =
  | 'not-organization'
  | 'account-mismatch'
  | 'wrong-app'
  | 'suspended';

export type InstallationValidation =
  | { ok: true; synced: SyncedInstallation }
  | { ok: false; reason: InstallationRejection };

/**
 * Is this installation ours, for this org, for an Organization, and live?
 *
 * Every write of `github_installation_id` goes through here. The four checks
 * answer four different ways the id in hand can be the wrong one:
 *
 * - **not-organization** — a personal-account install; classrooms need an org.
 * - **account-mismatch** — the login we asked about now belongs to a DIFFERENT
 *   account (org renamed, name recycled). Adopting that installation would
 *   hand one customer's org to another.
 * - **wrong-app** — an installation of some other GitHub App, or of this app in
 *   another environment. Staging holds production-cloned rows, so this is real.
 * - **suspended** — installed but suspended; the token mint would fail anyway,
 *   and storing the id would make the UI claim it is connected.
 *
 * `app_slug` is only compared when `GITHUB_APP_NAME` is configured — it is the
 * slug the install URL is built from, and an environment that never set it must
 * not have every installation rejected. The comparison is trimmed and
 * case-folded: GitHub slugs are lowercase, but the env var is hand-entered and
 * a stray capital or trailing space must not disconnect every org.
 *
 * @param {InstallationLike} installation - The installation as GitHub returned it.
 * @param {{ providerId: string }} expected - The org we believe it belongs to.
 * @returns {InstallationValidation} ok + the synced shape, or the refusal reason.
 */
export const validateInstallationIdentity = (
  installation: InstallationLike,
  expected: { providerId: string }
): InstallationValidation => {
  const account = installation.account;

  if (!account || account.type !== 'Organization' || !account.login) {
    return { ok: false, reason: 'not-organization' };
  }

  if (String(account.id) !== String(expected.providerId)) {
    return { ok: false, reason: 'account-mismatch' };
  }

  const expectedAppId = process.env.GITHUB_APP_ID;
  if (expectedAppId && String(installation.app_id) !== String(expectedAppId)) {
    return { ok: false, reason: 'wrong-app' };
  }

  const expectedAppSlug = process.env.GITHUB_APP_NAME?.trim().toLowerCase();
  if (expectedAppSlug && installation.app_slug?.trim().toLowerCase() !== expectedAppSlug) {
    return { ok: false, reason: 'wrong-app' };
  }

  if (installation.suspended_at) {
    return { ok: false, reason: 'suspended' };
  }

  return {
    ok: true,
    synced: {
      provider_id: String(account.id),
      login: account.login,
      github_installation_id: String(installation.id),
      avatar_url: account.avatar_url ?? '',
    },
  };
};

/**
 * Read a rate-limit refusal out of an Octokit error.
 *
 * GitHub answers a primary limit with 403 + `x-ratelimit-remaining: 0` and a
 * secondary limit with 403/429 + `retry-after`. Neither is "not found", so
 * neither may be swallowed by the 404 fallback path.
 *
 * @param {unknown} error - The thrown Octokit error.
 * @returns {number|null} seconds to wait, or null if this isn't a rate limit.
 */
const rateLimitRetryAfterSeconds = (error: unknown): number | null => {
  const err = error as {
    status?: number;
    response?: { headers?: Record<string, string | number | undefined> };
  };

  if (err?.status !== 403 && err?.status !== 429) return null;

  const headers = err.response?.headers ?? {};
  const retryAfter = Number(headers['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.ceil(retryAfter);

  if (String(headers['x-ratelimit-remaining']) === '0') {
    const reset = Number(headers['x-ratelimit-reset']);
    if (Number.isFinite(reset) && reset > 0) {
      return Math.max(1, Math.ceil(reset - Date.now() / 1000));
    }
    return 60;
  }

  return null;
};

/** Rethrow a rate limit as the typed error; leave everything else alone. */
const rethrowIfRateLimited = (error: unknown): void => {
  const retryAfterSeconds = rateLimitRetryAfterSeconds(error);
  if (retryAfterSeconds !== null) {
    throw new GitHubRateLimitedError(retryAfterSeconds);
  }
};

/**
 * Every installation of this app, paginated.
 *
 * Split out so a sweep can read it ONCE and hand the same list to every org it
 * repairs — the scan is the expensive half of a lookup, and doing it per org is
 * how a 45-org run spends the app's whole hourly budget. A throttle here comes
 * back as `GitHubRateLimitedError` like every other lookup failure, so a caller
 * can stop rather than mistake it for "nothing installed".
 *
 * @param {Octokit} appOctokit - App-JWT Octokit (`GitHubProvider.getAppOctokit`).
 * @returns {Promise<InstallationLike[]>}
 * @throws {GitHubRateLimitedError} when GitHub is throttling us.
 */
export const listAppInstallations = async (appOctokit: Octokit): Promise<InstallationLike[]> => {
  try {
    return (await appOctokit.paginate(appOctokit.rest.apps.listInstallations, {
      per_page: 100,
    })) as unknown as InstallationLike[];
  } catch (error: unknown) {
    rethrowIfRateLimited(error);
    throw error;
  }
};

export type InstallationLookup =
  | { status: 'found'; installation: InstallationLike; synced: SyncedInstallation }
  | { status: 'not-installed' }
  | { status: 'login-moved' }
  | { status: 'suspended' }
  | { status: 'wrong-app' };

/**
 * Find the live installation for an org we already have a row for.
 *
 * Two lookups, in this order, because they fail in opposite directions:
 *
 * 1. `GET /orgs/{login}/installation` — one cheap request, but keyed on a LOGIN,
 *    which is not stable. If the account behind that login is no longer ours,
 *    the answer is discarded, never adopted.
 * 2. `GET /app/installations` — keyed on the account id, which is stable, but
 *    costs a full paginated scan. It is the only thing that finds an org that
 *    was renamed out from under us.
 *
 * "Not installed" is therefore only ever concluded after the id scan came up
 * empty; a 404 on the login alone proves nothing.
 *
 * A caller sweeping MANY orgs passes `installations` — one preloaded
 * `GET /app/installations` shared across the whole run — so step 2 costs one
 * paginated scan for the sweep instead of one per org.
 *
 * @param {Octokit} appOctokit - App-JWT Octokit (`GitHubProvider.getAppOctokit`).
 * @param {{ provider_id: string; login: string }} org - The stored org row.
 * @param {Object} [opts]
 * @param {InstallationLike[]} [opts.installations] - Preloaded `GET /app/installations`.
 * @returns {Promise<InstallationLookup>}
 * @throws {GitHubRateLimitedError} when GitHub is throttling us.
 */
export const lookupInstallationForOrg = async (
  appOctokit: Octokit,
  org: { provider_id: string; login: string },
  opts: { installations?: InstallationLike[] } = {}
): Promise<InstallationLookup> => {
  /** The login resolved, but to somebody else's account. */
  let loginMoved = false;
  /** The login resolved to us, but the installation was unusable. */
  let byLoginRefusal: 'suspended' | 'wrong-app' | null = null;

  try {
    const { data } = await appOctokit.rest.apps.getOrgInstallation({ org: org.login });
    const validation = validateInstallationIdentity(data as InstallationLike, {
      providerId: org.provider_id,
    });

    if (validation.ok) {
      return { status: 'found', installation: data as InstallationLike, synced: validation.synced };
    }

    if (validation.reason === 'account-mismatch') loginMoved = true;
    else if (validation.reason === 'suspended') byLoginRefusal = 'suspended';
    else if (validation.reason === 'wrong-app') byLoginRefusal = 'wrong-app';
  } catch (error: unknown) {
    rethrowIfRateLimited(error);
    if ((error as { status?: number })?.status !== 404) throw error;
  }

  const installations = opts.installations ?? (await listAppInstallations(appOctokit));

  const match = installations.find(
    inst => inst.account && String(inst.account.id) === String(org.provider_id)
  );

  if (match) {
    const validation = validateInstallationIdentity(match, { providerId: org.provider_id });
    if (validation.ok) {
      return { status: 'found', installation: match, synced: validation.synced };
    }
    if (validation.reason === 'suspended') return { status: 'suspended' };
    if (validation.reason === 'wrong-app') return { status: 'wrong-app' };
    return { status: 'not-installed' };
  }

  // The login answered for an account that is not ours AND no installation
  // anywhere carries our account id — the org itself moved or was renamed.
  if (loginMoved) return { status: 'login-moved' };
  if (byLoginRefusal) return { status: byLoginRefusal };

  return { status: 'not-installed' };
};

/**
 * Claim an installation id for an org, but only while the column is still NULL.
 *
 * A conditional `updateMany` rather than an `update`: the repair path races the
 * `installation.created` webhook and any other tab the instructor has open, and
 * whoever writes second must not be able to overwrite a good id with a stale
 * one. `provider` and `provider_id` are in the WHERE for the same reason — the
 * id we found was found FOR that account, and must not land on a row that has
 * since been repointed.
 *
 * Never creates a row: repair fixes orgs we already know about.
 *
 * @param {Object} params
 * @param {string} params.orgId - GitOrganization UUID.
 * @param {string} params.providerId - The GitHub org account id we validated against.
 * @param {string} params.installationId - The installation id to store.
 * @param {string} params.login - The login GitHub reports now (may have changed).
 * @returns {Promise<{claimed: true} | {claimed: false, current: GitOrganization|null}>}
 */
export const claimInstallationIfNull = async ({
  orgId,
  providerId,
  installationId,
  login,
}: {
  orgId: string;
  providerId: string;
  installationId: string;
  login: string;
}): Promise<{ claimed: true } | { claimed: false; current: GitOrganization | null }> => {
  const { count } = await getPrisma().gitOrganization.updateMany({
    where: {
      id: orgId,
      provider: 'GITHUB',
      provider_id: providerId,
      github_installation_id: null,
    },
    data: {
      github_installation_id: installationId,
      login,
    },
  });

  if (count > 0) return { claimed: true };

  const current = await getPrisma().gitOrganization.findUnique({ where: { id: orgId } });
  return { claimed: false, current };
};

/**
 * Clear an installation id, but only where it is still THAT installation.
 *
 * The uninstall webhook used to clear by account id alone, so a stale or
 * replayed `installation.deleted` could wipe the id a later reinstall had
 * already written — which is half of why 45 orgs are disconnected. Matching the
 * id makes the clear idempotent and makes a late delivery a no-op.
 *
 * @param {Object} params
 * @param {string} params.providerId - The GitHub org account id from the payload.
 * @param {string} params.installationId - The installation being uninstalled.
 * @returns {Promise<number>} rows cleared (0 when the delivery was stale).
 */
export const clearInstallationIfMatches = async ({
  providerId,
  installationId,
}: {
  providerId: string;
  installationId: string;
}): Promise<number> => {
  const { count } = await getPrisma().gitOrganization.updateMany({
    where: {
      provider: 'GITHUB',
      provider_id: providerId,
      github_installation_id: installationId,
    },
    data: {
      github_installation_id: null,
    },
  });

  return count;
};

export type RepairInstallationResult =
  | { status: 'connected'; org: GitOrganization }
  | { status: 'already-connected'; org: GitOrganization | null }
  | { status: 'not-installed' }
  | { status: 'login-moved' }
  | { status: 'suspended' }
  | { status: 'wrong-app' }
  | { status: 'not-github' }
  | { status: 'not-found' }
  | { status: 'rate-limited'; retryAfterSeconds: number }
  | { status: 'error'; message: string };

/**
 * How long one org must wait between GitHub lookups, in ms.
 *
 * Per process, not per user: the "Check again" button, the create-classroom
 * guard and the operator task all land here, and a frustrated instructor
 * clicking repeatedly must not spend the app's whole rate-limit budget.
 */
const REPAIR_COOLDOWN_MS = 15_000;

/** orgId → timestamp (ms) before which another GitHub lookup is refused. */
const repairCooldowns = new Map<string, number>();
/** orgId → the lookup already running, so concurrent callers share one result. */
const repairInFlight = new Map<string, Promise<RepairInstallationResult>>();

/**
 * Forget cooldown stamps that have already run out.
 *
 * An expired entry is indistinguishable from an absent one, so keeping it only
 * grows the map — one dead key per org this process was ever asked about, for
 * the life of the process. Swept on the way into every `repairInstallation`,
 * which keeps the map to the orgs asked about in the last 15 seconds.
 */
const pruneExpiredCooldowns = (now: number): void => {
  for (const [id, until] of repairCooldowns) {
    if (until <= now) repairCooldowns.delete(id);
  }
};

/** `login` is omitted rather than printed as a placeholder when unknown. */
const logRepair = (orgId: string, login: string | null, status: string): void => {
  console.log(`[git-org-repair] org=${orgId}${login ? ` login=${login}` : ''} status=${status}`);
};

/**
 * Options shared by `repairInstallation` and the sweep that drives it.
 */
export interface RepairInstallationOptions {
  /**
   * Reuse this app-JWT Octokit instead of minting one. A sweep mints one per
   * RUN; without this every org would build a fresh JWT client.
   */
  appOctokit?: Octokit;
  /**
   * A preloaded `GET /app/installations`, shared across a sweep so the
   * account-id fallback scan happens once rather than once per org.
   */
  installations?: InstallationLike[];
  /**
   * Skip the local 15 s per-org cooldown. For the operator sweep, which asks
   * about each org exactly once per run and must not be aborted mid-sweep
   * because an earlier run (or the instructor's own button) touched the same
   * org. In-flight sharing still applies — this never doubles a live request.
   */
  bypassCooldown?: boolean;
}

/**
 * The lookup-and-claim itself. Wrapped by `repairInstallation`, which owns the
 * cooldown and the in-flight sharing.
 */
const performRepair = async (
  orgId: string,
  opts: RepairInstallationOptions
): Promise<RepairInstallationResult> => {
  let login: string | null = null;

  try {
    const org = await getPrisma().gitOrganization.findUnique({ where: { id: orgId } });

    if (!org) {
      logRepair(orgId, login, 'not-found');
      return { status: 'not-found' };
    }

    login = org.login;

    if (org.provider !== 'GITHUB') {
      logRepair(orgId, login, 'not-github');
      return { status: 'not-github' };
    }

    if (org.github_installation_id) {
      logRepair(orgId, login, 'already-connected');
      return { status: 'already-connected', org };
    }

    // Stamped BEFORE the network call so a second caller arriving mid-flight is
    // turned away by the cooldown (or joined to the in-flight promise) rather
    // than let through — and stamped AGAIN once GitHub answers, so the 15 s is
    // measured from completion. A lookup that itself took 14 s would otherwise
    // leave a window with a second left on it. A FOUND installation clears the
    // stamp instead: the row is about to hold an id, so the next call answers
    // `already-connected` from the database without touching GitHub.
    let lookup: InstallationLookup;
    let found = false;
    try {
      repairCooldowns.set(orgId, Date.now() + REPAIR_COOLDOWN_MS);
      lookup = await lookupInstallationForOrg(
        opts.appOctokit ?? GitHubProvider.getAppOctokit(),
        org,
        {
          installations: opts.installations,
        }
      );
      found = lookup.status === 'found';
    } finally {
      if (found) {
        repairCooldowns.delete(orgId);
      } else {
        repairCooldowns.set(orgId, Date.now() + REPAIR_COOLDOWN_MS);
      }
    }

    if (lookup.status !== 'found') {
      logRepair(orgId, login, lookup.status);
      return { status: lookup.status };
    }

    const claim = await claimInstallationIfNull({
      orgId,
      providerId: org.provider_id,
      installationId: lookup.synced.github_installation_id,
      login: lookup.synced.login,
    });

    if (!claim.claimed) {
      // Somebody (the webhook, another tab) filled the column first. Their id
      // came from the same validation, so it stands.
      logRepair(orgId, login, 'already-connected');
      return { status: 'already-connected', org: claim.current };
    }

    const fresh = await getPrisma().gitOrganization.findUnique({ where: { id: orgId } });
    logRepair(orgId, login, 'connected');
    return fresh
      ? { status: 'connected', org: fresh }
      : { status: 'error', message: 'Organization disappeared while connecting' };
  } catch (error: unknown) {
    if (error instanceof GitHubRateLimitedError) {
      logRepair(orgId, login, 'rate-limited');
      return { status: 'rate-limited', retryAfterSeconds: error.retryAfterSeconds };
    }

    // Only ids, logins and GitHub's own message ever reach the log here — an
    // Octokit failure's `message` is the API's text, never the credential.
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[git-org-repair] org=${orgId}${login ? ` login=${login}` : ''} failed:`,
      message
    );
    logRepair(orgId, login, 'error');
    return { status: 'error', message };
  }
};

/**
 * Reconnect one GitOrganization to its GitHub App installation.
 *
 * The single entry point for every repair caller — the "Check again" button,
 * the create-classroom guard, and the operator sweep task — so they cannot
 * disagree about what counts as connected or spend the rate limit separately.
 *
 * Rate-limit protection is two layered mechanisms:
 * - an in-flight map, so N simultaneous callers for one org make ONE request
 *   and all receive the same answer;
 * - a 15 s per-org cooldown, stamped before the request goes out and again when
 *   it settles, so a caller arriving just after one finishes is told to wait
 *   rather than asking again.
 *
 * The in-flight map is keyed by org alone, so a caller that joins somebody
 * else's live lookup gets THAT lookup's answer — its own `opts` are not applied
 * to a request already in the air.
 *
 * @param {string} orgId - GitOrganization UUID.
 * @param {RepairInstallationOptions} [opts] - Sweep-friendly overrides.
 * @returns {Promise<RepairInstallationResult>}
 */
export const repairInstallation = (
  orgId: string,
  opts: RepairInstallationOptions = {}
): Promise<RepairInstallationResult> => {
  const now = Date.now();
  pruneExpiredCooldowns(now);

  const inFlight = repairInFlight.get(orgId);
  if (inFlight) return inFlight;

  if (!opts.bypassCooldown) {
    const until = repairCooldowns.get(orgId) ?? 0;
    if (until > now) {
      const retryAfterSeconds = Math.max(1, Math.ceil((until - now) / 1000));
      logRepair(orgId, null, 'rate-limited');
      return Promise.resolve({ status: 'rate-limited', retryAfterSeconds });
    }
  }

  const run = performRepair(orgId, opts).finally(() => {
    repairInFlight.delete(orgId);
  });
  repairInFlight.set(orgId, run);
  return run;
};

/**
 * Drop the repair cooldown and in-flight state. Tests only — the maps are
 * process-lifetime by design.
 */
export const __resetRepairThrottleForTests = (): void => {
  repairCooldowns.clear();
  repairInFlight.clear();
};

/**
 * How many cooldown stamps are being held. Tests only — the point of the number
 * is to prove expired entries are swept rather than accumulated.
 */
export const __repairCooldownCountForTests = (): number => repairCooldowns.size;
