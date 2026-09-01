import { logger, schedules } from '@trigger.dev/sdk';
import { ClassmojiService } from '@classmoji/services';
import { sendEmailTask } from './email.ts';

/**
 * The forms housekeeping sweep.
 *
 * ── Why a schedule and not a cleanup-on-write ──────────────────────────────
 * A public submission stores a PENDING_VERIFICATION row immediately, so it
 * holds the (form_id, email_normalized) uniqueness slot before anyone has
 * proven they own that address. That is deliberate — it is what stops two
 * people racing for one identity — but nothing on the write path is in a
 * position to clean up after an abandoned one: the person who needs a slot
 * freed is exactly the person who cannot get far enough in to free it.
 *
 * So: a sweep, on a clock. It is also the GDPR-shaped half of the design —
 * answers typed by someone who never confirmed are personal data nobody ever
 * asked to keep, and thirty days is how long they are kept so that staff can
 * SEE that somebody tried before the row goes.
 *
 * ── The policy lives in the service ────────────────────────────────────────
 * Which rows are stale is `formResponse.expireStale`'s decision (30 days for
 * unverified rows with no staff label, 30 days for anonymous drafts, classroom
 * drafts kept). This task is scheduling and nothing else, so the same rules
 * apply when the sweep is run by hand from a script or asserted in a unit test.
 *
 * ── Cadence ────────────────────────────────────────────────────────────────
 * Every six hours. Four runs a day is precision far beyond what a 30-day
 * retention policy is expressing, and it is the cadence the reminder pass in
 * the same file needs — a nudge due at 6h goes out within six hours of being
 * due, which for "you have two days to click this" is close enough.
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

/**
 * Should this process actually dispatch mail?
 *
 * The same test `apps/pages/app/utils/tasks.server.ts` makes, and for the same
 * reason: a developer with production secrets in their `.env` must not mail a
 * real applicant every time a sweep runs on a laptop. Requiring production as
 * well as a key means the dangerous direction needs an explicit deployment and
 * the safe direction is what a laptop does.
 */
const canDispatchEmail = (): boolean =>
  Boolean(process.env.TRIGGER_SECRET_KEY) && process.env.NODE_ENV === 'production';

/**
 * The reminder pass: one nudge to everybody who submitted a public response and
 * never clicked the link.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * The verification click is the single point where a public submission can be
 * lost, and it is lost SILENTLY — for the applicant, who believes they applied,
 * and for the instructor, who never sees them. A form that mails once and gives
 * up is quietly discarding the people whose mail client buried it.
 *
 * ── Where the policy lives ─────────────────────────────────────────────────
 * `formResponse.remindUnverified` decides who is due (6h, then 24h), mints the
 * fresh link, and composes the mail. That includes the idempotence: a stage is
 * due only when no token was minted after it came due, and minting one is what
 * marks it served — so running this twice mails once, with no column tracking
 * it and no state in this task. This function is dispatch and logging.
 *
 * ── The dev escape ─────────────────────────────────────────────────────────
 * Off production the links are written to stdout — the same
 * `[forms:magic-link]` line the fill route logs, so the same reader (and the
 * same e2e helper) finds them. Never both.
 */
export const remindUnverifiedFormResponsesTask = schedules.task({
  id: 'forms-remind-unverified',
  cron: '0 */6 * * *',
  run: async () => {
    const { emails, remindedByStage, skippedForCooldown } =
      await ClassmojiService.formResponse.remindUnverified();

    if (!canDispatchEmail()) {
      for (const email of emails) {
        // eslint-disable-next-line no-console
        console.log(
          `[forms:magic-link] to=${email.payload.to} ${email.payload.template.variables.VERIFY_URL}`
        );
      }
    } else {
      for (const email of emails) {
        try {
          await sendEmailTask.trigger(email.payload);
        } catch (error) {
          // One undeliverable nudge must not abort the pass for everybody else.
          // The row keeps its token, so the NEXT stage is suppressed rather than
          // retried — which is the conservative direction: a missed reminder is
          // better than a duplicate one.
          logger.error('forms: reminder dispatch failed', {
            to: email.payload.to,
            error: (error as Error).message,
          });
        }
      }
    }

    logger.info('forms: reminded unverified responses', {
      reminded: emails.length,
      remindedByStage,
      skippedForCooldown,
      dispatched: canDispatchEmail(),
    });

    return { reminded: emails.length, remindedByStage, skippedForCooldown };
  },
});
