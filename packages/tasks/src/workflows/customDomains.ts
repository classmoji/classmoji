import { schedules, logger } from '@trigger.dev/sdk';
import { ClassmojiService, FlyCertService, isFlyCertsConfigured } from '@classmoji/services';

/**
 * Reconcile Fly certificates against the custom domains we actually claim.
 *
 * Every ordinary path already cleans up after itself — `clearCustomDomain` and
 * `deleteSiteForClassroom` both call `removeCert`. This job exists for the
 * paths that have no code on them at all:
 *
 *  - **Classroom deletion.** `classroom_sites.classroom_id` is `ON DELETE
 *    CASCADE`, so deleting a classroom drops its site row inside Postgres. No
 *    application code runs, no `removeCert` can fire, and the hostname stops
 *    being enumerable from our side entirely — the certificate would otherwise
 *    live on the app forever, undiscoverable.
 *  - **Partial failures.** `removeCert` is deliberately best-effort so a Fly
 *    outage cannot block an instructor from removing their site. That trade is
 *    only sound because this sweep exists to finish the job later.
 *
 * ONE-DIRECTIONAL, and that asymmetry is the safety property: it deletes
 * certificates we no longer claim, and it never issues certificates for claims
 * that lack one. Issuance is an admin action with rate limits attached (Fly
 * counts certificates per registered domain); a sweep that "helpfully"
 * re-requested them could burn that budget on a domain whose DNS was never
 * configured, on every run, forever. A claim missing its certificate is
 * reported and left for the admin's Retry button.
 */

/** Never delete more than this in one run. */
const MAX_DELETIONS_PER_RUN = 25;

export const reconcileCustomDomainCerts = schedules.task({
  id: 'reconcile-custom-domain-certs',
  // 04:40 UTC daily — off the hour, and clear of the other nightly jobs.
  cron: '40 4 * * *',
  run: async () => {
    if (!isFlyCertsConfigured()) {
      logger.info('Fly certificate automation is not configured; skipping reconciliation');
      return { skipped: true as const };
    }

    const [claimed, certificates] = await Promise.all([
      ClassmojiService.site.listCustomDomainRoutes(),
      FlyCertService.listCerts(),
    ]);

    const claimedHosts = new Set(claimed.map(route => route.domain));
    const certHosts = new Set(certificates.map(hostname => hostname.trim().toLowerCase()));

    // A certificate for a hostname nobody claims: the orphan case above.
    const orphaned = [...certHosts].filter(hostname => !claimedHosts.has(hostname));
    // A claim with no certificate: reported, never auto-issued. See the header.
    const missing = claimed.filter(route => !certHosts.has(route.domain)).map(r => r.domain);

    // The cap is a blast-radius guard, not a throughput one. If this ever wants
    // to delete dozens of certificates at once, the likeliest explanation is
    // that `listCustomDomainRoutes` returned a short list for a bad reason — a
    // partially-applied migration, a replica mid-restore — and mass-deleting
    // live certificates on that basis would take real sites offline. Stopping
    // and reporting is the recoverable failure; deleting is not.
    const toDelete = orphaned.slice(0, MAX_DELETIONS_PER_RUN);
    if (orphaned.length > MAX_DELETIONS_PER_RUN) {
      logger.warn('Unusually many orphaned certificates; deleting only the first batch', {
        orphaned: orphaned.length,
        limit: MAX_DELETIONS_PER_RUN,
      });
    }

    const removed: string[] = [];
    const failed: string[] = [];

    for (const hostname of toDelete) {
      try {
        await FlyCertService.removeCert(hostname);
        removed.push(hostname);
      } catch (error: unknown) {
        // One stubborn hostname must not abandon the rest of the sweep; it will
        // still be orphaned tomorrow, and tomorrow this runs again.
        failed.push(hostname);
        logger.error('Could not remove an orphaned certificate', {
          hostname,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (missing.length > 0) {
      logger.warn('Custom domains claimed with no certificate on the Fly app', {
        domains: missing,
      });
    }

    logger.info('Reconciled custom-domain certificates', {
      claimed: claimedHosts.size,
      certificates: certHosts.size,
      removed: removed.length,
      failed: failed.length,
      missing: missing.length,
    });

    return {
      skipped: false as const,
      claimed: claimedHosts.size,
      certificates: certHosts.size,
      removed,
      failed,
      missing,
    };
  },
});
