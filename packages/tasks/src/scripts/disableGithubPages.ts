/**
 * Turn GitHub Pages OFF on a classroom's content repo.
 *
 * The step before a content repo is flipped private (private-content-engine
 * plan, Phase 4). Pages is the legacy CDN path — `{org}.github.io/{repo}/…` —
 * and it does not care that the repo behind it is private: the site keeps
 * serving the whole tree to anyone with the URL. Flipping visibility without
 * turning Pages off first therefore reads as "locked down" while changing
 * nothing about who can read the files.
 *
 * ORDER MATTERS and it is the reverse of what feels safe. Pages goes off
 * FIRST, while the repo is still public, so the fallback disappears while the
 * signed-URL path is still verifiable; the flip to private comes after. Tim
 * does the visibility flip by hand — this script only does the Pages half.
 *
 * REFUSES a classroom whose `content_delivery_enabled` is false. That gate is
 * what routes renders through the signed Worker; with it off, the repo's
 * images are still served over `github.io`, and taking Pages away would break
 * that classroom's content on the spot. `--force` overrides, for the sweep at
 * the end of the rollout when the gate is on everywhere and the remaining
 * repos are stragglers.
 *
 * IDEMPOTENT: a repo with no Pages site answers 404, which is reported as
 * "already off" rather than thrown. Re-running over the same allowlist is
 * free.
 *
 * GitHub only: Pages here is the GitHub Pages API, so GitLab-backed classrooms
 * are listed and skipped rather than half-attempted.
 *
 * Usage:
 *   npx tsx packages/tasks/src/scripts/disableGithubPages.ts --classroom cs98-fall-2026 --dry-run
 *   npx tsx packages/tasks/src/scripts/disableGithubPages.ts --classroom cs98-fall-2026
 *   npx tsx packages/tasks/src/scripts/disableGithubPages.ts --all-enabled --dry-run
 *   npx tsx packages/tasks/src/scripts/disableGithubPages.ts --all-enabled
 *   npx tsx packages/tasks/src/scripts/disableGithubPages.ts --classroom cs52-25s --force
 *
 * DATABASE_URL and the GitHub App credentials come from the environment, the
 * same as every other script in this repo (see .dev-context) — this script
 * does not pick an environment for you. Check both before running it.
 */

import getPrisma from '@classmoji/database';
import { getGitProvider, GitHubProvider } from '@classmoji/services';

interface Options {
  dryRun: boolean;
  force: boolean;
  allEnabled: boolean;
  classroomSlug: string | null;
}

/** `--classroom <slug>` or `--classroom=<slug>`. */
function parseArgs(argv: string[]): Options {
  let classroomSlug: string | null = null;
  const at = argv.indexOf('--classroom');
  if (at !== -1 && argv[at + 1] && !argv[at + 1].startsWith('--')) {
    classroomSlug = argv[at + 1];
  } else {
    const inline = argv.find(arg => arg.startsWith('--classroom='));
    if (inline) classroomSlug = inline.slice('--classroom='.length);
  }

  return {
    dryRun: argv.includes('--dry-run'),
    force: argv.includes('--force'),
    allEnabled: argv.includes('--all-enabled'),
    classroomSlug: classroomSlug || null,
  };
}

/**
 * Exactly one selector, always. Defaulting to "every classroom" on a script
 * that removes the fallback CDN for a whole install is the one mistake worth
 * making impossible, and `--all-enabled` says out loud which set is meant.
 */
function assertSelector({ allEnabled, classroomSlug }: Options): void {
  if (allEnabled && classroomSlug) {
    console.error('❌ Pass either --classroom <slug> or --all-enabled, not both.');
    process.exit(1);
  }
  if (!allEnabled && !classroomSlug) {
    console.error('❌ Pass --classroom <slug>, or --all-enabled for every gated classroom.');
    process.exit(1);
  }
}

type Outcome = 'disabled' | 'already-off' | 'would-disable' | 'refused' | 'skipped' | 'failed';

async function disableGithubPages(options: Options): Promise<void> {
  assertSelector(options);
  const { dryRun, force, allEnabled, classroomSlug } = options;

  const classrooms = await getPrisma().classroom.findMany({
    where: {
      content_repo: { not: '' },
      ...(allEnabled ? { content_delivery_enabled: true } : { slug: classroomSlug! }),
    },
    select: {
      slug: true,
      content_repo: true,
      content_delivery_enabled: true,
      git_organization: true,
    },
    orderBy: { slug: 'asc' },
  });

  if (classrooms.length === 0) {
    console.log(
      allEnabled
        ? '⚠️  No classrooms have content_delivery_enabled = true — nothing to do.'
        : `⚠️  No classroom found for "${classroomSlug}" with a content repo — check the slug.`
    );
    return;
  }

  console.log(
    `📦 ${classrooms.length} classroom(s)${allEnabled ? ' with content delivery on' : ''}\n`
  );

  const counts: Record<Outcome, number> = {
    disabled: 0,
    'already-off': 0,
    'would-disable': 0,
    refused: 0,
    skipped: 0,
    failed: 0,
  };
  const record = (outcome: Outcome, line: string): void => {
    counts[outcome] += 1;
    console.log(line);
  };

  for (const classroom of classrooms) {
    const org = classroom.git_organization?.login;
    const repo = classroom.content_repo;
    const label = `${org ?? '?'}/${repo} (${classroom.slug})`;

    if (!org || classroom.git_organization?.provider !== 'GITHUB') {
      record(
        'skipped',
        `   ⏭️  ${label} — not a GitHub organization (${classroom.git_organization?.provider ?? 'none'})`
      );
      continue;
    }

    // The refusal that makes this script safe to point at a slug someone read
    // off a spreadsheet: with the gate off, github.io IS the delivery path.
    if (!classroom.content_delivery_enabled && !force) {
      record(
        'refused',
        `   🚫 ${label} — content_delivery_enabled is FALSE; Pages is still serving this class. Re-run with --force only if you mean it.`
      );
      continue;
    }
    const forced = !classroom.content_delivery_enabled ? ' (FORCED, gate is off)' : '';

    try {
      const provider = getGitProvider(classroom.git_organization);
      if (!(provider instanceof GitHubProvider)) {
        record('skipped', `   ⏭️  ${label} — provider has no Pages API`);
        continue;
      }

      const pages = await provider.getRepoPages(org, repo);
      if (!pages) {
        // GitHub answers 404 both for "no Pages site" and for "no such repo,
        // as far as this installation is concerned". Reported as-is, the
        // second becomes a confident "already off" over a repo that may still
        // be serving its whole tree — the one wrong answer here that gets a
        // repo flipped private on a false all-clear. One extra call settles it.
        if (!(await provider.repositoryExists(org, repo))) {
          record(
            'failed',
            `   ❌ ${label} — repo not visible to the GitHub App; cannot confirm Pages is off`
          );
          continue;
        }
        record('already-off', `   ✅ ${label} — no Pages site${forced}`);
        continue;
      }

      const state = `has_pages=true source=${pages.sourceBranch ?? '?'}${
        pages.sourcePath && pages.sourcePath !== '/' ? pages.sourcePath : ''
      } build=${pages.buildType ?? '?'} status=${pages.status ?? '?'}`;

      if (dryRun) {
        record('would-disable', `   🔍 ${label} — ${state} → would DELETE${forced}`);
        continue;
      }

      const { alreadyDisabled } = await provider.disableRepoPages(org, repo);
      if (alreadyDisabled) {
        // Raced with someone else's turn-off between the GET and the DELETE.
        record('already-off', `   ✅ ${label} — already off${forced}`);
      } else {
        record('disabled', `   ✅ ${label} — Pages DISABLED (was ${state})${forced}`);
      }
    } catch (error: unknown) {
      // One bad repo must not strand the rest of an allowlist half-done.
      const status = (error as { status?: number }).status;
      const detail = error instanceof Error ? error.message : String(error);
      record('failed', `   ❌ ${label} — ${status ? `HTTP ${status}: ` : ''}${detail}`);
    }
  }

  console.log('\n─── summary ───');
  if (dryRun) console.log(`🔍 ${counts['would-disable']} would have Pages disabled`);
  else console.log(`🔻 ${counts.disabled} disabled`);
  console.log(`✅ ${counts['already-off']} already off`);
  if (counts.refused) console.log(`🚫 ${counts.refused} refused (gate off — pass --force)`);
  if (counts.skipped) console.log(`⏭️  ${counts.skipped} skipped (not GitHub)`);
  if (counts.failed) console.log(`❌ ${counts.failed} failed`);
  if (dryRun) console.log('\nNothing was changed. Re-run without --dry-run to apply.');

  if (counts.failed > 0) process.exitCode = 1;
}

disableGithubPages(parseArgs(process.argv.slice(2))).catch((err: unknown) => {
  console.error('Disable GitHub Pages failed:', err);
  process.exitCode = 1;
});
