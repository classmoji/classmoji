/**
 * Build the content-asset map for every classroom that doesn't have one yet.
 *
 * From here on the map maintains itself: a push webhook syncs the paths a push
 * touched, and the nightly `content-assets-sweep` re-reads anything that has
 * gone stale. Neither helps a classroom that has never synced at all, and
 * `ensureContentAssets` only fixes those one render at a time. This is the
 * one-shot that fills them all in, so the first render after the feature ships
 * is already fast instead of paying for a full tree read.
 *
 * It is a convenience, not a requirement — the system is self-bootstrapping
 * and skipping this costs a slow first render per classroom, nothing more.
 *
 * Every classroom is triggered as its OWN Trigger run rather than synced here:
 * a few hundred GitHub tree reads in one process would take longer than any
 * sensible timeout and lose all of its progress on the first failure. The runs
 * are also idempotent — `syncContentAssets` is mark-and-sweep, so a second
 * bootstrap over the same classrooms lands on exactly the same rows.
 *
 * GitHub only: `getTree` is implemented on GitHubProvider alone, so a
 * GitLab-backed classroom would only produce a failed run.
 *
 * Usage:
 *   npx tsx packages/tasks/src/scripts/bootstrapContentAssets.ts --dry-run  # list what would be triggered
 *   npx tsx packages/tasks/src/scripts/bootstrapContentAssets.ts            # trigger the runs
 *
 * DATABASE_URL and the Trigger.dev credentials come from the environment, the
 * same as every other script in this repo (see .dev-context) — this script
 * does not pick an environment for you. Check both before running it.
 */

import getPrisma from '@classmoji/database';
import Tasks from '../index.ts';

async function bootstrapContentAssets({ dryRun }: { dryRun: boolean }): Promise<void> {
  const classrooms = await getPrisma().classroom.findMany({
    where: {
      content_repo: { not: '' },
      git_organization: { provider: 'GITHUB' },
    },
    select: {
      id: true,
      slug: true,
      content_repo: true,
      git_organization: { select: { login: true } },
    },
    orderBy: { slug: 'asc' },
  });

  console.log(`📦 ${classrooms.length} classroom(s) with a GitHub content repo`);

  let triggered = 0;

  for (const classroom of classrooms) {
    const label = `${classroom.git_organization.login}/${classroom.content_repo} (${classroom.slug})`;

    if (dryRun) {
      console.log(`   would sync ${label}`);
      continue;
    }

    // No `changes`, so the task takes the full path: read the whole tree and
    // stamp-and-sweep. That is the only correct mode for a classroom whose map
    // may be absent, partial, or arbitrarily out of date.
    await Tasks.contentAssetsSyncTask.trigger({
      classroomId: classroom.id,
      reason: 'bootstrap' as const,
    });
    triggered += 1;
    console.log(`   ✅ queued ${label}`);
  }

  if (dryRun) {
    console.log(`\n🔍 Dry run — nothing was triggered. Re-run without --dry-run to queue them.`);
  } else {
    console.log(`\n🚀 Queued ${triggered} content-asset sync run(s)`);
  }
}

bootstrapContentAssets({ dryRun: process.argv.includes('--dry-run') }).catch((err: unknown) => {
  console.error('Bootstrap failed:', err);
  process.exitCode = 1;
});
