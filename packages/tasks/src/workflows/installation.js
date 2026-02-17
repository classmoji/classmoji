import { task } from '@trigger.dev/sdk';
import prisma from '@classmoji/database';

/**
 * Handle new GitHub App installation
 * Only creates/updates GitOrganization record.
 * Classroom creation happens via the UI.
 */
export const newInstallationHandlerTask = task({
  id: 'webhook-new_installation_handler',
  run: async payload => {
    const {
      installation: { id: installationId, account },
    } = payload;

    // Upsert GitOrganization - that's ALL the webhook does
    // No user lookup, no classroom, no membership, no teams yet
    await prisma.gitOrganization.upsert({
      where: {
        provider_provider_id: {
          provider: 'GITHUB',
          provider_id: String(account.id),
        },
      },
      update: {
        github_installation_id: String(installationId),
        login: account.login, // Update in case org was renamed
      },
      create: {
        provider: 'GITHUB',
        provider_id: String(account.id),
        login: account.login,
        github_installation_id: String(installationId),
      },
    });

    return { success: true };
  },
});

/**
 * Handle GitHub App uninstallation
 * Clears the installation ID so we know the app is no longer installed
 */
export const appUninstalledHandlerTask = task({
  id: 'webhook-app_uninstalled_handler',
  run: async payload => {
    const {
      installation: { account },
    } = payload;

    // Clear installation ID - classrooms remain but can't interact with GitHub
    await prisma.gitOrganization.updateMany({
      where: {
        provider: 'GITHUB',
        provider_id: String(account.id),
      },
      data: {
        github_installation_id: null,
      },
    });

    return { success: true };
  },
});
