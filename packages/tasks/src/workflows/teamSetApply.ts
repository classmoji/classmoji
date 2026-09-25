/**
 * teamSetApply.ts — turn a claimed, solved team-set run into Teams.
 *
 * `teamSet.claimCreate` (owner only, after the preview was approved) atomically
 * sets `created_run_id` and a RUNNING `create_state`, then triggers this task
 * with `{ teamSetId, attemptId }` (idempotency key per attempt id). Everything
 * else — which run, which teams, which logins — is read back by
 * `teamSet.applyCreate`, which ensures the set's Tag, creates each team (GitHub
 * team included) and adds its members, continuing past a team that fails and
 * recording every failure. It never deletes.
 *
 * ── Attempt identity ───────────────────────────────────────────────────────
 * `attemptId` is minted by the claim and stored in `create_state`. Every call
 * this task makes into the service carries it, and the service does nothing
 * when the row holds a different attempt: a task whose claim was released
 * (the trigger call failed on our side after Trigger had queued it), or that
 * starts after its create was expired and retried, cannot touch the retry.
 *
 * ── Progress ───────────────────────────────────────────────────────────────
 * `applyCreate` persists `create_state` itself after every team (that row is
 * what the page and `form_teams_get` poll), so this task does NOT write
 * progress: a second writer would race the service's wholesale writes. The
 * `onProgress` callback only feeds a throttled log line with counts — enough
 * to follow a long create in the Trigger dashboard, no names.
 *
 * ── Failure ────────────────────────────────────────────────────────────────
 * `applyCreate` turns its own internal errors into a FAILED `create_state`.
 * What it cannot cover is a throw that escapes it (the database gone while it
 * reads or records the final state), which would leave `create_state` RUNNING
 * and every viewer polling a create that stopped. The catch below is that
 * backstop: `teamSet.stopCreate` with `internal_error`, a conditional write
 * (only while the row still holds THIS attempt, RUNNING) that marks it FAILED
 * with a whole-create `{ team: '*' }` failure, keeping every team already
 * recorded. That includes applyCreate's own final write when it failed every
 * retry (`state_write_failed`): the teams made since the last good progress
 * write are then unrecorded, and a retry of the same run finds them on the tag
 * and adopts them. Then the sanitized error is rethrown so the Trigger run
 * shows failed too. This task never writes `create_state` itself.
 *
 * `maxAttempts: 1`: team creation is not replayable blindly (GitHub teams and
 * memberships would be retried against half-finished state). `applyCreate` is
 * idempotent on re-entry, so a deliberate re-trigger resumes, skipping teams
 * already recorded — that is a human decision, not an automatic retry.
 * Default machine (small-2x): this is GitHub-API bound, not CPU bound.
 *
 * ── Cancel ─────────────────────────────────────────────────────────────────
 * `applyCreate` takes no abort signal, so a cancel does not interrupt it
 * directly. `onCancel` waits up to CANCEL_GRACE_MS for it to finish on its
 * own (Trigger kills the process 30 s after cancel hooks start), and if it has
 * not, calls `teamSet.stopCreate` with `canceled`. `applyCreate`'s own writes
 * are conditional on its attempt still being RUNNING, so its next write finds
 * the create stopped and it ends there instead of flipping it back. A create
 * whose process dies before either write is expired lazily by the service.
 */
import { task, logger } from '@trigger.dev/sdk';
import { ClassmojiService, type CreateState } from '@classmoji/services';

export interface TeamSetApplyPayload {
  teamSetId: string;
  /** The claim's `create_state.attempt_id`; the service ignores any other attempt's task. */
  attemptId: string;
}

/** Minimum spacing between progress log lines. */
const PROGRESS_LOG_INTERVAL_MS = 10_000;

/**
 * How long `onCancel` waits for `applyCreate` to finish before marking the
 * create stopped. Trigger gives cancel hooks 30 s before it kills the process.
 */
export const CANCEL_GRACE_MS = 20_000;

/** true when `promise` settles (either way) within `ms`, false otherwise. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true
      ),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Counts only — a create's state carries team names and logins. */
function progressCounts(state: CreateState) {
  return {
    status: state.status,
    total: state.total,
    done: state.done,
    created: state.teams.length,
    failed: state.failed.length,
  };
}

export const teamSetApplyTask = task({
  id: 'team-set-apply',
  maxDuration: 1800,
  retry: { maxAttempts: 1 },
  run: async ({ teamSetId, attemptId }: TeamSetApplyPayload) => {
    let lastLogAt = 0;
    const onProgress = (state: CreateState) => {
      const now = Date.now();
      if (now - lastLogAt < PROGRESS_LOG_INTERVAL_MS) return;
      lastLogAt = now;
      logger.info('team-set-apply: progress', { teamSetId, ...progressCounts(state) });
    };

    try {
      const state = await ClassmojiService.teamSet.applyCreate({
        teamSetId,
        attemptId,
        onProgress,
      });
      const counts = progressCounts(state);
      if (state.attempt_id !== attemptId) {
        // Released or superseded before this task ran: the row belongs to
        // another attempt, and applyCreate left it alone.
        logger.warn('team-set-apply: not the current attempt; nothing done', { teamSetId });
        return { ...counts, superseded: true };
      }
      if (state.status === 'DONE') {
        logger.info('team-set-apply: finished', { teamSetId, ...counts });
      } else {
        // Per-team reasons are a closed vocabulary; log them without names.
        logger.warn('team-set-apply: finished with failures', {
          teamSetId,
          ...counts,
          reasons: state.failed.map(failure => failure.reason),
        });
      }
      return counts;
    } catch (error: unknown) {
      const code =
        error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unexpected';
      logger.error('team-set-apply: stopped', { teamSetId, code });
      await ClassmojiService.teamSet
        .stopCreate({ teamSetId, attemptId, reason: 'internal_error' })
        .catch(() => {
          logger.error('team-set-apply: could not mark the create failed', { teamSetId });
        });
      throw new Error(`team-set-apply failed: ${code}`);
    }
  },
  onCancel: async ({ payload, runPromise }) => {
    // A run function that settles has recorded its own outcome (applyCreate's
    // final state, or the catch above). Only a create still going after the
    // grace is marked stopped from here.
    if (await settlesWithin(runPromise, CANCEL_GRACE_MS)) return;
    logger.warn('team-set-apply: canceled while creating; marking the create failed', {
      teamSetId: payload.teamSetId,
    });
    await ClassmojiService.teamSet
      .stopCreate({
        teamSetId: payload.teamSetId,
        attemptId: payload.attemptId,
        reason: 'canceled',
      })
      .catch(() => {
        logger.error('team-set-apply: could not mark the canceled create failed', {
          teamSetId: payload.teamSetId,
        });
      });
  },
});
