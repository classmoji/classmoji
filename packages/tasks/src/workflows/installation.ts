import { task } from '@trigger.dev/sdk';
import getPrisma from '@classmoji/database';
import {
  GitHubProvider,
  clearInstallationIfMatches,
  validateInstallationIdentity,
} from '@classmoji/services';

interface InstallationPayload {
  installation: {
    id: number;
    account: { id: number; login: string; [key: string]: unknown };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface AdoptResult {
  success: true;
  /** Set when the delivery was refused; absent when the id was written. */
  skipped?: string;
}

/**
 * Read the installation back from GitHub, check it is ours for this account,
 * and write its id onto the org.
 *
 * Shared by `installation.created` and `installation.unsuspend` because they
 * are the same claim made for two different reasons — one after an install, one
 * after a suspension is lifted — and the checks that make the claim safe must
 * not drift apart between them.
 *
 * The payload is NOT trusted on its own. Webhook deliveries are retried, can
 * arrive minutes late, and can be replayed — so a delivery for an installation
 * that has since been removed would otherwise write an id that mints no token.
 * The live read answers three things the payload cannot: that the installation
 * still exists (404 → stale, ignore it), that it belongs to the account the
 * payload named, and that it is this app's and not suspended.
 *
 * @param {InstallationPayload} payload - The webhook delivery.
 * @param {string} label - Log prefix naming the delivery, e.g. `installation.created`.
 * @returns {Promise<AdoptResult>}
 */
const adoptInstallation = async (
  payload: InstallationPayload,
  label: string
): Promise<AdoptResult> => {
  const {
    installation: { id: installationId, account },
  } = payload;

  let live;
  try {
    const { data } = await GitHubProvider.getAppOctokit().rest.apps.getInstallation({
      installation_id: Number(installationId),
    });
    live = data;
  } catch (error: unknown) {
    if ((error as { status?: number })?.status === 404) {
      // The installation is gone — a replayed or long-delayed delivery.
      // Writing its id would leave the org looking connected to nothing.
      console.warn(`[${label}] installation=${installationId} no longer exists`);
      return { success: true, skipped: 'stale' as const };
    }
    throw error;
  }

  const validation = validateInstallationIdentity(live, { providerId: String(account.id) });
  if (!validation.ok) {
    console.warn(`[${label}] installation=${installationId} rejected: ${validation.reason}`);
    return { success: true, skipped: validation.reason };
  }

  // GitHub has just confirmed this installation is live FOR THIS ACCOUNT, so
  // the id may be written unconditionally — unlike the repair path, this is
  // not a guess that could clobber a better answer.
  await getPrisma().gitOrganization.upsert({
    where: {
      provider_provider_id: {
        provider: 'GITHUB',
        provider_id: validation.synced.provider_id,
      },
    },
    update: {
      github_installation_id: validation.synced.github_installation_id,
      login: validation.synced.login, // Update in case org was renamed
    },
    create: {
      provider: 'GITHUB',
      provider_id: validation.synced.provider_id,
      login: validation.synced.login,
      github_installation_id: validation.synced.github_installation_id,
    },
  });

  return { success: true };
};

/**
 * Handle new GitHub App installation
 * Only creates/updates GitOrganization record.
 * Classroom creation happens via the UI.
 */
export const newInstallationHandlerTask = task({
  id: 'webhook-new_installation_handler',
  run: async (payload: InstallationPayload) => adoptInstallation(payload, 'installation.created'),
});

/**
 * Handle GitHub App uninstallation
 * Clears the installation ID so we know the app is no longer installed
 *
 * Scoped to the installation that was actually removed. Clearing by account id
 * alone let a stale or replayed `installation.deleted` wipe the id a LATER
 * reinstall had already written, silently disconnecting an org whose app is
 * installed and fine. A delivery that no longer matches clears nothing.
 */
export const appUninstalledHandlerTask = task({
  id: 'webhook-app_uninstalled_handler',
  run: async (payload: InstallationPayload) => {
    const {
      installation: { id: installationId, account },
    } = payload;

    const cleared = await clearInstallationIfMatches({
      providerId: String(account.id),
      installationId: String(installationId),
    });

    return { success: true, cleared };
  },
});

/**
 * Handle a GitHub App installation being SUSPENDED.
 *
 * A suspended installation still exists but mints no tokens, so an org holding
 * its id looks connected and fails every call. Treat it exactly like an
 * uninstall: clear the id, scoped to the installation the delivery names, so a
 * replayed suspend cannot wipe an id a later reinstall wrote. `unsuspend` puts
 * it back after re-validating against live GitHub.
 */
export const appSuspendedHandlerTask = task({
  id: 'webhook-app_suspended_handler',
  run: async (payload: InstallationPayload) => {
    const {
      installation: { id: installationId, account },
    } = payload;

    const cleared = await clearInstallationIfMatches({
      providerId: String(account.id),
      installationId: String(installationId),
    });

    return { success: true, cleared };
  },
});

/**
 * Handle a suspension being LIFTED.
 *
 * The same claim `installation.created` makes, and for the same reason: the id
 * is usable again. It re-reads live state rather than trusting the delivery,
 * because a replayed `unsuspend` for an installation that has since been
 * removed — or re-suspended — must write nothing.
 */
export const appUnsuspendedHandlerTask = task({
  id: 'webhook-app_unsuspended_handler',
  run: async (payload: InstallationPayload) => adoptInstallation(payload, 'installation.unsuspend'),
});
