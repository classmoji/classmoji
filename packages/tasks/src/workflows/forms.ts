import { logger, schedules } from '@trigger.dev/sdk';
import { ClassmojiService } from '@classmoji/services';

/**
 * The forms housekeeping sweep — anonymous drafts, and nothing else.
 *
 * ── What it does NOT do any more ───────────────────────────────────────────
 * It used to also delete abandoned unverified submissions after thirty days,
 * and this file used to carry a second task that chased them with reminder
 * mail at six and twenty-four hours. Both are gone.
 *
 * They existed to serve a deadline, and the deadline existed because a link
 * used to expire in forty-eight hours. A link now lives as long as its form,
 * so there is nothing to chase: somebody who filled the form in and did not
 * click can still click months later, and their row stays where staff can see
 * it in the meantime. An abandoned entry is a real applicant, and "did anybody
 * bounce off the confirmation step?" is worth being able to answer.
 *
 * ── Why a draft is different ───────────────────────────────────────────────
 * A draft is half-typed answers nobody has ever seen, saved automatically as
 * somebody types under an on-form promise. Keeping those for ever means
 * holding personal data because a person started filling something in and
 * changed their mind, so thirty days still applies. The policy itself lives in
 * `formResponse.expireStale`, so a hand-run script and a test see the same
 * rules this schedule does.
 *
 * ── Cadence ────────────────────────────────────────────────────────────────
 * Every six hours — far more precision than a thirty-day retention policy
 * needs, and it costs nothing.
 */
export const expireStaleFormResponsesTask = schedules.task({
  id: 'forms-expire-stale',
  cron: '0 */6 * * *',
  run: async () => {
    const { draftsDeleted } = await ClassmojiService.formResponse.expireStale();

    logger.info('forms: expired stale drafts', { draftsDeleted });

    return { draftsDeleted };
  },
});
