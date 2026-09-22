/**
 * Backfill submission times for REPO-mode assignments.
 *
 * Usage:
 *   npx tsx packages/database/scripts/backfillRepoSubmissions.ts            # dry run
 *   npx tsx packages/database/scripts/backfillRepoSubmissions.ts --apply    # write
 *
 * The phase 3 migration turns every repository that had no issues into one
 * REPO-mode assignment with one OPEN submission row per existing student repo.
 * Those students may well have pushed already; Classmoji only learns about
 * pushes from the webhook from now on. This script asks GitHub for each such
 * repo's recent commits and, when the student has pushed (template and bot
 * commits do not count) before the deadline, marks the row submitted then. Rows that already have a closed_at are
 * left alone. Idempotent.
 */

import getPrisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';

process.on('unhandledRejection', reason => {
  console.error('[backfill] Unhandled rejection:', reason);
  process.exitCode = 1;
});

const APPLY = process.argv.includes('--apply');

async function main(): Promise<void> {
  const prisma = getPrisma();
  const rows = await prisma.gitRepoAssignment.findMany({
    where: {
      closed_at: null,
      provider_id: null,
      assignment: { type: 'REPO', submission_mode: 'REPO' },
    },
    include: {
      git_repo: { include: { classroom: { include: { git_organization: true } } } },
    },
  });

  if (rows.length === 0) {
    console.log('[backfill] no REPO-mode submission rows without a submission time');
    return;
  }
  console.log(`[backfill] ${rows.length} row(s) to check${APPLY ? '' : ' (dry run)'}`);

  let updated = 0;
  for (const row of rows) {
    try {
      if (APPLY) {
        const at = await ClassmojiService.gitRepoAssignment.recordExistingPush(row.id);
        if (at) {
          updated += 1;
          console.log(`[backfill] ${row.id} (${row.git_repo.name}): submitted ${at.toISOString()}`);
        } else {
          console.log(`[backfill] ${row.id} (${row.git_repo.name}): no student push before the deadline`);
        }
      } else {
        console.log(`[backfill] ${row.id} (${row.git_repo.name}): would check the repo history`);
      }
    } catch (error) {
      console.warn(`[backfill] ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(
    APPLY
      ? `[backfill] marked ${updated} submission(s)`
      : '[backfill] dry run complete; re-run with --apply to write'
  );
}

main()
  .catch(err => {
    console.error('[backfill] failed:', err);
    process.exitCode = 1;
  })
  .finally(() => getPrisma().$disconnect());
