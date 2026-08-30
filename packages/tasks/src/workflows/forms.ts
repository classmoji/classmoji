import { logger, schedules } from '@trigger.dev/sdk';
import { ClassmojiService } from '@classmoji/services';

/**
 * The forms housekeeping sweep.
 *
 * ── Why a schedule and not a cleanup-on-write ──────────────────────────────
 * A public submission stores a PENDING_VERIFICATION row immediately, so it
 * holds the (form_id, email_normalized) uniqueness slot before anyone has
 * proven they own that address. That is deliberate — it is what stops two
 * people racing for one identity — but it means an abandoned submission would
 * lock the address out of the form forever. Something has to release it, and
 * "the next person to submit cleans up" is the wrong shape: the person who
 * needs the slot freed is exactly the person who cannot get far enough into the
 * write path to free it.
 *
 * So: a sweep, on a clock. It is also the GDPR-shaped half of the design —
 * answers typed by someone who never confirmed are personal data nobody ever
 * asked to keep.
 *
 * ── The policy lives in the service ────────────────────────────────────────
 * Which rows are stale is `formResponse.expireStale`'s decision (48h for
 * unverified, 30 days for anonymous drafts, classroom drafts kept). This task
 * is scheduling and nothing else, so the same rules apply when the sweep is run
 * by hand from a script or asserted in a unit test.
 *
 * ── Cadence ────────────────────────────────────────────────────────────────
 * Every six hours. The TTL it enforces is 48 hours, so a row lives at most
 * 48h + 6h before it goes — precision far below what the policy is expressing,
 * at four runs a day instead of the 1,440 a minutely schedule would cost.
 */
export const expireStaleFormResponsesTask = schedules.task({
  id: 'forms-expire-stale',
  cron: '0 */6 * * *',
  run: async () => {
    const { pendingDeleted, draftsDeleted } = await ClassmojiService.formResponse.expireStale();

    logger.info('forms: expired stale responses', { pendingDeleted, draftsDeleted });

    return { pendingDeleted, draftsDeleted };
  },
});
