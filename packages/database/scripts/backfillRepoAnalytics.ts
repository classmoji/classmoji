/**
 * Backfill repo analytics snapshots for every active repository assignment.
 *
 * Usage:
 *   npx tsx packages/database/scripts/backfillRepoAnalytics.ts           # enqueue via Trigger.dev
 *   npx tsx packages/database/scripts/backfillRepoAnalytics.ts --inline  # run in-process (local dev)
 *
 * The default mode mirrors the production refresh flow in
 * `apps/webapp/app/routes/api.repos.$id.refresh/route.ts` — it enqueues the
 * `refresh-repo-analytics` Trigger.dev task for each active assignment id.
 * The `--inline` mode bypasses Trigger.dev and calls
 * `ClassmojiService.repoAnalytics.refreshOne` directly; useful when the
 * Trigger.dev runtime isn't available (e.g. a fresh local checkout).
 */

import { ClassmojiService } from '@classmoji/services';

process.on('unhandledRejection', (reason) => {
  console.error('[backfill] Unhandled rejection:', reason);
  process.exit(1);
});

const INLINE = process.argv.includes('--inline');

async function enqueueAll(ids: string[]): Promise<void> {
  // Lazy import so `--inline` users don't need Trigger.dev installed.
  const { tasks } = await import('@trigger.dev/sdk');

  for (const id of ids) {
    const handle = await tasks.trigger('refresh-repo-analytics', {
      repositoryAssignmentId: id,
    });
    console.log(`[backfill] enqueued repo ${id} → job ${handle.id}`);
  }
}

async function runInline(ids: string[]): Promise<void> {
  for (const id of ids) {
    try {
      await ClassmojiService.repoAnalytics.refreshOne(id);
      console.log(`[backfill] refreshed repo ${id} inline`);
    } catch (err) {
      console.error(`[backfill] failed repo ${id}:`, err);
    }
  }
}

async function main(): Promise<void> {
  const ids = await ClassmojiService.repoAnalytics.listActiveAssignmentIds();

  if (ids.length === 0) {
    console.log('[backfill] no active repository assignments found');
    return;
  }

  const first = ids[0];
  const last = ids[ids.length - 1];

  if (INLINE) {
    console.log(`[backfill] running inline for ${ids.length} assignments (first=${first} last=${last})`);
    await runInline(ids);
    console.log(`[backfill] completed ${ids.length} inline refreshes`);
    return;
  }

  console.log(`[backfill] enqueueing ${ids.length} Trigger.dev jobs (first=${first} last=${last})`);
  await enqueueAll(ids);
  console.log(`[backfill] enqueued ${ids.length} jobs (first=${first} last=${last})`);
}

main().catch((err) => {
  console.error('[backfill] fatal:', err);
  process.exit(1);
});
