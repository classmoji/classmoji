import { schedules, logger } from '@trigger.dev/sdk';
import {
  ClassmojiService,
  FlyCertService,
  isFlyCertsConfigured,
  isPlatformDomain,
} from '@classmoji/services';

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
 *
 * NOT EVERY CERTIFICATE ON THE APP IS A TENANT'S. The same app carries the
 * wildcard that terminates TLS for every `{subdomain}.classmoji.io` class site
 * and the canonical `pages.` host — hostnames that can never appear in the claim
 * list, because a custom domain under a platform domain is rejected both by
 * `setCustomDomain` and by a CHECK constraint. A plain certs-minus-claims diff
 * therefore classifies our own infrastructure as orphaned. They are filtered out
 * here, and `removeCert` refuses them a second time at the deletion primitive.
 */

/**
 * Never delete more than this in one run — and if a run wants to, it deletes
 * NOTHING. See the abort in `run` for why the cap is not a batch size.
 */
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

    // Both sides normalized identically. A claim stored with different case
    // would otherwise fail to match its own certificate and be swept.
    const claimedHosts = claimed.map(route => route.domain.trim().toLowerCase());
    const claimedSet = new Set(claimedHosts);
    const certHosts = new Set(certificates.map(hostname => hostname.trim().toLowerCase()));

    // A certificate for a hostname nobody claims: the orphan case above. The
    // platform's own hostnames are never claims and are never orphans — the
    // header explains why a bare certs-minus-claims diff points at our wildcard.
    const orphaned = [...certHosts].filter(
      hostname => !claimedSet.has(hostname) && !isPlatformDomain(hostname)
    );
    // A claim with no certificate: reported, never auto-issued. See the header.
    const missing = claimedHosts.filter(domain => !certHosts.has(domain));

    // Reported by every branch, so an abort reads as legibly as a sweep.
    const counts = {
      claimed: claimedSet.size,
      certificates: certHosts.size,
      orphaned: orphaned.length,
    };

    // Two reads this refuses to act on, both saying the same thing: the claim
    // list is far shorter than the certificates on the app, and the likeliest
    // explanation is a bad read rather than a genuine mass release — a
    // partially-applied migration, a replica mid-restore, or a worker whose
    // DATABASE_URL and FLY_PAGES_APP came from different environments. Note the
    // asymmetry that makes this necessary: a database ERROR is already safe (the
    // read rejects and the run aborts before any delete), so the only bad read
    // that reaches this point is an empty-or-short SUCCESSFUL one.
    //
    // The cap is therefore a blast-radius guard, not a batch size: a run that
    // wants to delete more than it deletes NOTHING. Slicing would delete the
    // first 25 of exactly the list we just decided not to trust.
    //
    // Tested against `orphaned`, deliberately never against the raw certificate
    // count: the platform's own certificates sit on the app on every run, good
    // read or bad, so counting them would flag a healthy zero-customer
    // environment as suspicious every single night and bury the real signal.
    const suspicious =
      (claimedHosts.length === 0 && orphaned.length > 0) || orphaned.length > MAX_DELETIONS_PER_RUN;

    if (suspicious) {
      logger.error('Refusing to delete: the custom-domain claim list looks untrustworthy', {
        ...counts,
        missing: missing.length,
        limit: MAX_DELETIONS_PER_RUN,
        wouldHaveRemoved: orphaned,
      });

      return {
        skipped: false as const,
        suspicious: true,
        ...counts,
        removed: [] as string[],
        failed: [] as string[],
        missing,
      };
    }

    const removed: string[] = [];
    const failed: string[] = [];

    for (const hostname of orphaned) {
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
      ...counts,
      removed: removed.length,
      failed: failed.length,
      missing: missing.length,
    });

    return {
      skipped: false as const,
      suspicious: false,
      ...counts,
      removed,
      failed,
      missing,
    };
  },
});
