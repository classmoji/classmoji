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
 * repo's latest default-branch commit and, when there is one, marks the row
 * submitted at that commit's time. Rows that already have a closed_at are
 * left alone. Idempotent.
 */

import getPrisma from '@classmoji/database';
import { getGitProvider } from '@classmoji/services';

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
    const gitOrg = row.git_repo.classroom.git_organization;
    if (!gitOrg?.login) {
      console.warn(`[backfill] ${row.id}: classroom has no git organization, skipped`);
      continue;
    }
    try {
      const provider = getGitProvider(gitOrg);
      const commits = await provider.listCommits(gitOrg.login, row.git_repo.name, {
        maxCommits: 1,
      });
      const latest = commits[0];
      if (!latest) {
        console.log(`[backfill] ${row.id} (${row.git_repo.name}): no commits yet`);
        continue;
      }
      const closedAt = new Date(latest.ts);
      console.log(
        `[backfill] ${row.id} (${row.git_repo.name}): last push ${closedAt.toISOString()}`
      );
      if (APPLY) {
        await prisma.gitRepoAssignment.update({
          where: { id: row.id },
          data: { status: 'CLOSED', closed_at: closedAt },
        });
        updated += 1;
      }
    } catch (err) {
      console.error(`[backfill] ${row.id} (${row.git_repo.name}) failed:`, err);
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
