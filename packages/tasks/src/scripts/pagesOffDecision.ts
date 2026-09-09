/**
 * The pure half of `disableGitHubPages.ts`: argument parsing and the
 * per-classroom gate.
 *
 * Split out so the refusal logic can be tested. The script itself opens a
 * database connection and talks to GitHub the moment it is imported, so a test
 * cannot reach into it; these functions decide everything that matters before
 * either of those happens, and decide it from plain values.
 */

export interface Options {
  dryRun: boolean;
  force: boolean;
  allEnabled: boolean;
  classroomSlug: string | null;
}

/** `--classroom <slug>` or `--classroom=<slug>`. */
export function parseArgs(argv: string[]): Options {
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
 * Exactly one selector, always — `null` when the pair is legal.
 *
 * Defaulting to "every classroom" on a script that removes the fallback CDN for
 * a whole install is the one mistake worth making impossible, and
 * `--all-enabled` says out loud which set is meant.
 */
export function selectorError({ allEnabled, classroomSlug }: Options): string | null {
  if (allEnabled && classroomSlug) {
    return 'Pass either --classroom <slug> or --all-enabled, not both.';
  }
  if (!allEnabled && !classroomSlug) {
    return 'Pass --classroom <slug>, or --all-enabled for every gated classroom.';
  }
  return null;
}

export type Decision =
  | { action: 'skip'; reason: string }
  | { action: 'refuse'; reason: string }
  | { action: 'proceed'; forced: boolean };

/**
 * Everything decided before a single GitHub call is made.
 *
 * The refusal is the property that makes this script safe to point at a slug
 * someone read off a spreadsheet: with `content_delivery_enabled` false,
 * github.io IS that classroom's delivery path, and taking Pages away breaks its
 * images on the spot. `--force` is the deliberate override for the
 * end-of-rollout sweep, and it says so in the output rather than passing
 * silently.
 */
export function decideClassroom({
  provider,
  login,
  contentDeliveryEnabled,
  force,
}: {
  provider: string;
  login: string | null;
  contentDeliveryEnabled: boolean;
  force: boolean;
}): Decision {
  if (provider !== 'GITHUB') {
    return { action: 'skip', reason: `not a GitHub organization (${provider})` };
  }
  // Pages here is the GitHub Pages API; without a login there is no owner to
  // address, so there is nothing this script can act on either way.
  if (!login) {
    return { action: 'skip', reason: 'git organization has no login' };
  }
  if (!contentDeliveryEnabled && !force) {
    return {
      action: 'refuse',
      reason:
        'content_delivery_enabled is FALSE; Pages is still serving this class. ' +
        'Re-run with --force only if you mean it.',
    };
  }
  return { action: 'proceed', forced: !contentDeliveryEnabled };
}
