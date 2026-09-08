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
 * signed-URL path is still verifiable; the flip to private comes after. The
 * operator does the visibility flip by hand — this script only does the Pages
 * half.
 *
 * NOT DURABLE ON ITS OWN, and this is the sharp edge. `ensureContentRepoExists`
 * in page.service.ts calls `enableGitHubPages` unconditionally, and it runs on
 * every page create, slide create, batch page import, class-to-class import and
 * classroom-import run. So the next such action in a swept classroom turns Pages
 * back ON — on a now-private repo, which is the leak this exists to close, and
 * it happens silently (only the failure branch logs). Removing that call is its
 * own Phase 4 line item; until it lands, treat a run of this script as good only
 * until the classroom's next content write, and re-run before the visibility
 * flip.
 *
 * REFUSES a classroom whose `content_delivery_enabled` is false. That gate is
 * what routes renders through the signed Worker; with it off, the repo's
 * images are still served over `github.io`, and taking Pages away would break
 * that classroom's content on the spot. `--force` overrides it, and it also
 * widens `--all-enabled` to every classroom with a content repo — that pairing
 * is the end-of-rollout sweep, whose whole point is the gate-off stragglers the
 * gated selection would otherwise drop.
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
 *   npx tsx packages/tasks/src/scripts/disableGithubPages.ts --all-enabled --force
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
      // `--all-enabled` means the gated set; `--all-enabled --force` is the
      // end-of-rollout sweep, and the stragglers it exists for are exactly the
      // gate-off classrooms that filter would drop. Widen, and leave the
      // per-classroom refusal below as the thing that does the talking.
      ...(allEnabled
        ? force
          ? {}
          : { content_delivery_enabled: true }
        : { slug: classroomSlug! }),
      // Example classrooms are backed by a mock GitOrganization with no live
      // GitHub behind it; a real API call there can only produce noise.
      is_example: false,
    },
    select: {
      slug: true,
      content_repo: true,
      content_delivery_enabled: true,
      // Explicit, not `git_organization: true` — that pulls every column of the
      // row, the encrypted `access_token` included, into a process with no use
      // for it. These three are all `getGitProvider` reads on the GitHub path,
      // which is the only path this script takes.
      git_organization: {
        select: { provider: true, github_installation_id: true, login: true },
      },
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
    const gitOrg = classroom.git_organization;
    const org = gitOrg.login;
    const repo = classroom.content_repo;
    const label = `${org ?? '?'}/${repo} (${classroom.slug})`;

    if (!org || gitOrg.provider !== 'GITHUB') {
      record('skipped', `   ⏭️  ${label} — not a GitHub organization (${gitOrg.provider})`);
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
      const provider = getGitProvider(gitOrg);
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

      // A `workflow` build serves from an Actions run, so `source` is not the
      // truth for it — name the build type rather than print a branch that is
      // not one. The URL leads: it is the thing about to stop serving, and the
      // one field an operator can check by eye before approving a DELETE.
      const source =
        pages.buildType === 'workflow'
          ? 'source=Actions workflow'
          : `source=${pages.sourceBranch ?? '?'}${
              pages.sourcePath && pages.sourcePath !== '/' ? pages.sourcePath : ''
            }`;
      const state = `${pages.htmlUrl ?? '(no url)'} ${source} build=${pages.buildType ?? '?'} status=${pages.status ?? '?'}`;

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

  // A refusal is not a success: a runbook step or wrapper reading exit 0 would
  // tick off a repo whose Pages is still up.
  if (counts.failed > 0 || counts.refused > 0) process.exitCode = 1;
}

disableGithubPages(parseArgs(process.argv.slice(2))).catch((err: unknown) => {
  console.error('Disable GitHub Pages failed:', err);
  process.exitCode = 1;
});
