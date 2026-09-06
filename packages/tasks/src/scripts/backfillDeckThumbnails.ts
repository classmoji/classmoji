/**
 * Render a card image for every deck that does not have a current one.
 *
 * From here on thumbnails maintain themselves: saving a deck enqueues
 * `deck-thumbnail-render`, and the index asks for one when it draws a
 * placeholder for a deck that has none. Neither helps a deck nobody has saved
 * since this shipped, which on day one is all of them. This is the one-shot
 * that fills them in, so the index arrives with pictures rather than earning
 * them one scroll at a time.
 *
 * It is a convenience, not a requirement — skipping it costs a page of
 * placeholders that fill in as decks are opened and saved, nothing more.
 *
 * Every deck is triggered as its OWN Trigger run rather than rendered here: a
 * few hundred headless-browser screenshots in one process would outlast any
 * sensible timeout and lose all their progress on the first failure. Throttling
 * is the task's own `queue: { concurrencyLimit: 4 }`, deliberately not paced
 * here — four concurrent browsers is two orders of magnitude under Browser Run's
 * ceilings, and pacing in two places means neither is the answer.
 *
 * IDEMPOTENT twice over. This script skips a deck whose `thumbnail_rendered_sha`
 * already equals the `index.html` sha the asset map holds; and the task repeats
 * that check against the live sha before it boots a browser, so a deck the map
 * has never heard of costs one run that returns `unchanged` rather than a
 * needless commit. Re-running the whole thing is free.
 *
 * GitHub only: the render commits through `ContentService.uploadBatch`, so a
 * GitLab-backed classroom would only produce a failed run.
 *
 * Usage:
 *   npx tsx packages/tasks/src/scripts/backfillDeckThumbnails.ts --dry-run
 *   npx tsx packages/tasks/src/scripts/backfillDeckThumbnails.ts
 *   npx tsx packages/tasks/src/scripts/backfillDeckThumbnails.ts --classroom cs98-fall-2026
 *
 * DATABASE_URL and the Trigger.dev credentials come from the environment, the
 * same as every other script in this repo (see .dev-context) — this script does
 * not pick an environment for you. Check both before running it.
 */

import getPrisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';
import Tasks from '../index.ts';

interface Options {
  dryRun: boolean;
  classroomSlug: string | null;
}

/** `--classroom <slug>` or `--classroom=<slug>`; null for every classroom. */
function parseArgs(argv: string[]): Options {
  const dryRun = argv.includes('--dry-run');

  let classroomSlug: string | null = null;
  const at = argv.indexOf('--classroom');
  if (at !== -1 && argv[at + 1] && !argv[at + 1].startsWith('--')) {
    classroomSlug = argv[at + 1];
  } else {
    const inline = argv.find(arg => arg.startsWith('--classroom='));
    if (inline) classroomSlug = inline.slice('--classroom='.length);
  }

  return { dryRun, classroomSlug: classroomSlug || null };
}

async function backfillDeckThumbnails({ dryRun, classroomSlug }: Options): Promise<void> {
  const slides = await getPrisma().slide.findMany({
    where: {
      classroom: {
        content_repo: { not: '' },
        git_organization: { provider: 'GITHUB' },
        ...(classroomSlug ? { slug: classroomSlug } : {}),
      },
    },
    select: {
      id: true,
      slug: true,
      content_path: true,
      classroom_id: true,
      thumbnail_path: true,
      thumbnail_rendered_sha: true,
      classroom: { select: { slug: true } },
    },
    orderBy: [{ classroom_id: 'asc' }, { slug: 'asc' }],
  });

  if (classroomSlug && slides.length === 0) {
    console.log(`⚠️  No decks found for classroom "${classroomSlug}" — check the slug.`);
    return;
  }

  console.log(
    `📦 ${slides.length} deck(s)${classroomSlug ? ` in ${classroomSlug}` : ' across all classrooms'}`
  );

  // One query per classroom for every deck's index.html sha, rather than one
  // per deck: the map is the cheap half of the skip check and there is no
  // reason to pay for it a deck at a time.
  const byClassroom = new Map<string, typeof slides>();
  for (const slide of slides) {
    const group = byClassroom.get(slide.classroom_id) ?? [];
    group.push(slide);
    byClassroom.set(slide.classroom_id, group);
  }

  let triggered = 0;
  let skipped = 0;

  for (const [classroomId, group] of byClassroom) {
    const indexPaths = group.map(slide => `${slide.content_path}/index.html`);
    const assets = await ClassmojiService.contentAssets.lookupContentAssets(
      classroomId,
      indexPaths
    );

    for (const slide of group) {
      const label = `${slide.classroom?.slug ?? classroomId}/${slide.slug}`;
      const indexSha = assets.get(`${slide.content_path}/index.html`)?.sha ?? null;

      // Both halves have to hold: a recorded sha that still matches AND a
      // thumbnail actually stored. A deck whose row says "rendered from this
      // sha" but has no `thumbnail_path` never got its commit, and is exactly
      // the deck this script exists for.
      if (indexSha && indexSha === slide.thumbnail_rendered_sha && slide.thumbnail_path) {
        skipped += 1;
        continue;
      }

      if (dryRun) {
        console.log(`   would render ${label}`);
        triggered += 1;
        continue;
      }

      // The same per-classroom fence the save path uses: a backfill run queues
      // behind a live render for that classroom rather than racing it into the
      // same repo.
      await Tasks.deckThumbnailRender.trigger(
        { slideId: slide.id },
        { concurrencyKey: classroomId }
      );
      triggered += 1;
      console.log(`   ✅ queued ${label}`);
    }
  }

  console.log(`\n⏭️  ${skipped} deck(s) already current — not queued`);
  if (dryRun) {
    console.log(
      `🔍 Dry run — nothing was triggered. ${triggered} would be. Re-run without --dry-run to queue them.`
    );
  } else {
    console.log(`🚀 Queued ${triggered} thumbnail render(s)`);
  }
}

backfillDeckThumbnails(parseArgs(process.argv.slice(2))).catch((err: unknown) => {
  console.error('Backfill failed:', err);
  process.exitCode = 1;
});
