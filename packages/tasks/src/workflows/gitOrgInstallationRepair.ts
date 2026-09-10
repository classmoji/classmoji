import { schemaTask, logger } from '@trigger.dev/sdk';
import getPrisma from '@classmoji/database';
import {
  GitHubProvider,
  GitHubRateLimitedError,
  listAppInstallations,
  lookupInstallationForOrg,
  repairInstallation,
} from '@classmoji/services';
import type { InstallationLike } from '@classmoji/services';

/**
 * Operator sweep: reconnect GitOrganizations whose `github_installation_id` is
 * NULL to the GitHub App installation they already have.
 *
 * ── HOW TO RUN ─────────────────────────────────────────────────────────────
 * From the Trigger.dev dashboard (Tasks → `git-org-installation-repair` → Test)
 * or locally with `npm run trigger:dev -w @classmoji/tasks` and the same Test
 * panel. ALWAYS do a dry run first and read the report:
 *
 *   {}                                  // dry run — the default, writes nothing
 *   { "dryRun": true, "limit": 5 }      // dry run, first 5 orgs by login
 *   { "dryRun": true, "orgIds": ["…"] } // dry run, just these orgs
 *   { "dryRun": false }                 // APPLY — writes the ids it found
 *
 * `dryRun` defaults to TRUE, so a mis-typed payload can only report. Only
 * `{ "dryRun": false }` writes, and even then every write goes through the same
 * conditional claim the "Check again" button uses: an org whose column stopped
 * being NULL in the meantime is left exactly as it is.
 *
 * The payload is validated STRICTLY: an unrecognised key fails the run before
 * anything is read. `{ "limt": 5 }` would otherwise be an applying sweep of
 * every org, because the typo drops through to defaults.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * ~45 orgs with real classrooms have a NULL installation id — either they were
 * created GitHub-free by the Classroom ZIP import, or a stale
 * `installation.deleted` webhook cleared an id a reinstall had already replaced.
 * Most of them have the app installed and just don't know it. This finds those.
 *
 * ── RATE LIMITS ────────────────────────────────────────────────────────────
 * Orgs are processed ONE AT A TIME with a short pause between them, never in
 * parallel. `GET /app/installations` — the paginated account-id scan, and the
 * expensive half of a lookup — is read ONCE per run and handed to every org, so
 * a 45-org sweep costs one scan plus one cheap by-login request each, not 45
 * scans. When GitHub does throttle us the sweep STOPS rather than grinding
 * through the remaining orgs collecting the same refusal — the partial report
 * comes back with `stoppedEarly: true` and `retryAfterSeconds`, and the run is
 * simply re-triggered after that.
 *
 * The 15 s per-org cooldown inside `repairInstallation` is bypassed here: this
 * task asks about each org exactly once per run, and a re-triggered sweep must
 * not be turned away just because the previous run (or an instructor's own
 * "Check again") touched the same org seconds ago. In-flight sharing still
 * applies, so this can never double a request already in the air.
 */

/** Only orgs that carry real coursework — an example-course org has no GitHub. */
const NON_EXAMPLE_CLASSROOM = { is_example: false } as const;

/**
 * Pause between two orgs' GitHub lookups.
 *
 * Not a rate-limit guarantee (that's what stopping early is for) — just enough
 * spacing that a sweep reads as a trickle rather than a burst, which is what
 * GitHub's secondary limits actually watch for.
 */
const DELAY_BETWEEN_ORGS_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export interface GitOrgInstallationRepairPayload {
  /** Report only. TRUE unless explicitly set to false. */
  dryRun?: boolean;
  /** Restrict the sweep to these GitOrganization ids (still filtered as below). */
  orgIds?: string[];
  /** Stop after this many orgs, ordered by login. */
  limit?: number;
}

/** Everything the payload may contain. Anything else is a typo, not an option. */
const PAYLOAD_KEYS = ['dryRun', 'orgIds', 'limit'] as const;

const reject = (message: string): never => {
  throw new Error(`[git-org-installation-repair] ${message}`);
};

/**
 * Strict payload validation, run by `schemaTask` BEFORE `run`.
 *
 * Hand-written rather than a Zod schema because `@classmoji/tasks` does not
 * depend on Zod and no sibling task pulls one in; `schemaTask` accepts a plain
 * validator function, which is all this needs.
 *
 * Unknown keys are a hard failure on purpose. This task's default is safe and
 * its dangerous mode is one key away, so a payload the operator believed
 * narrowed the run — `{ "limt": 5 }`, `{ "dry_run": false }` — must fail loudly
 * rather than silently mean something else.
 *
 * @param {unknown} input - The raw trigger payload.
 * @returns {GitOrgInstallationRepairPayload}
 */
export const parseRepairPayload = (input: unknown): GitOrgInstallationRepairPayload => {
  if (input === undefined || input === null) return {};

  if (typeof input !== 'object' || Array.isArray(input)) {
    reject('payload must be an object');
  }

  const raw = input as Record<string, unknown>;
  const unknown = Object.keys(raw).filter(
    key => !(PAYLOAD_KEYS as readonly string[]).includes(key)
  );
  if (unknown.length > 0) {
    reject(
      `unknown payload key(s): ${unknown.join(', ')} — expected only ${PAYLOAD_KEYS.join(', ')}`
    );
  }

  const payload: GitOrgInstallationRepairPayload = {};

  if (raw.dryRun !== undefined) {
    if (typeof raw.dryRun !== 'boolean') reject('dryRun must be a boolean');
    payload.dryRun = raw.dryRun as boolean;
  }

  if (raw.orgIds !== undefined) {
    if (!Array.isArray(raw.orgIds) || raw.orgIds.some(id => typeof id !== 'string' || id === '')) {
      reject('orgIds must be an array of non-empty strings');
    }
    payload.orgIds = raw.orgIds as string[];
  }

  if (raw.limit !== undefined) {
    if (typeof raw.limit !== 'number' || !Number.isInteger(raw.limit) || raw.limit <= 0) {
      reject('limit must be a positive integer');
    }
    payload.limit = raw.limit as number;
  }

  return payload;
};

/**
 * What happened for one org.
 *
 * `would-connect` is the dry-run twin of `connected`: an installation was found
 * and validated, and a real run would have claimed it.
 */
export type GitOrgRepairOutcome =
  | 'would-connect'
  | 'connected'
  | 'already-connected'
  | 'not-installed'
  | 'login-moved'
  | 'suspended'
  | 'wrong-app'
  | 'not-github'
  | 'not-found'
  | 'rate-limited'
  | 'error';

export interface GitOrgRepairResult {
  orgId: string;
  login: string;
  /** Non-example classrooms in this org. */
  classrooms: number;
  /** Distinct users holding OWNER on any of them — who to email. */
  owners: number;
  outcome: GitOrgRepairOutcome;
  /** The installation id found (dry run) or written (apply). */
  installationId?: string;
  /** Why it failed, on `error` only — without it the report says nothing useful. */
  message?: string;
}

export interface GitOrgInstallationRepairReport {
  dryRun: boolean;
  /** Orgs the scan matched. `scanned` is smaller when a throttle stopped us. */
  candidates: number;
  scanned: number;
  results: GitOrgRepairResult[];
  summary: { byOutcome: Record<string, number> };
  /**
   * Ids passed in `orgIds` that matched no candidate — already connected, not
   * a GitHub org, example-only, or no such row. (A `limit` small enough to
   * truncate the scan also lands ids here.)
   */
  unmatchedOrgIds: string[];
  /** GitHub throttled us; the orgs after the last result were not looked at. */
  stoppedEarly?: boolean;
  retryAfterSeconds?: number;
}

/**
 * Owners per org, in one query.
 *
 * Distinct on (user_id, classroom_id) because one person can hold OWNER on
 * several classrooms in the same org and would otherwise be counted twice; the
 * per-org de-dupe below turns that into "how many people to contact".
 */
const countOwnersByOrg = async (
  classroomIdsByOrg: Map<string, string[]>
): Promise<Map<string, number>> => {
  const classroomIds = [...classroomIdsByOrg.values()].flat();
  const owners = new Map<string, number>();
  if (classroomIds.length === 0) return owners;

  const memberships = await getPrisma().classroomMembership.findMany({
    where: { classroom_id: { in: classroomIds }, role: 'OWNER' },
    select: { user_id: true, classroom_id: true },
    distinct: ['user_id', 'classroom_id'],
  });

  const orgByClassroom = new Map<string, string>();
  for (const [orgId, ids] of classroomIdsByOrg) {
    for (const id of ids) orgByClassroom.set(id, orgId);
  }

  const userIdsByOrg = new Map<string, Set<string>>();
  for (const membership of memberships) {
    const orgId = orgByClassroom.get(membership.classroom_id);
    if (!orgId) continue;
    const set = userIdsByOrg.get(orgId) ?? new Set<string>();
    set.add(membership.user_id);
    userIdsByOrg.set(orgId, set);
  }

  for (const [orgId, set] of userIdsByOrg) owners.set(orgId, set.size);
  return owners;
};

const summarize = (results: GitOrgRepairResult[]): Record<string, number> => {
  const byOutcome: Record<string, number> = {};
  for (const result of results) {
    byOutcome[result.outcome] = (byOutcome[result.outcome] ?? 0) + 1;
  }
  return byOutcome;
};

export const gitOrgInstallationRepairTask = schemaTask({
  id: 'git-org-installation-repair',
  schema: parseRepairPayload,
  /**
   * ONE sweep at a time, platform-wide.
   *
   * Two operators triggering this together would double the GitHub traffic for
   * a run whose whole design is not to spike it, and would race each other on
   * the same rows. The second run queues behind the first instead.
   */
  queue: { concurrencyLimit: 1 },
  /** 45 orgs × (a by-login request + 250ms) with room to spare. */
  maxDuration: 600,
  /**
   * No retries. A failed sweep is re-triggered by a human who has read the
   * partial report — an automatic second attempt would just re-ask GitHub the
   * questions that already failed, which is exactly what the rate limit is
   * complaining about.
   */
  retry: { maxAttempts: 1 },
  run: async (
    payload: GitOrgInstallationRepairPayload
  ): Promise<GitOrgInstallationRepairReport> => {
    const dryRun = payload.dryRun !== false;
    const { orgIds, limit } = payload;

    const orgs = await getPrisma().gitOrganization.findMany({
      where: {
        provider: 'GITHUB',
        github_installation_id: null,
        classrooms: { some: NON_EXAMPLE_CLASSROOM },
        ...(orgIds && orgIds.length > 0 ? { id: { in: orgIds } } : {}),
      },
      select: {
        id: true,
        login: true,
        provider_id: true,
        classrooms: { where: NON_EXAMPLE_CLASSROOM, select: { id: true } },
      },
      orderBy: { login: 'asc' },
      ...(limit && limit > 0 ? { take: limit } : {}),
    });

    // An id an operator explicitly asked about and that the scan did not
    // return is the one thing a per-org report cannot show — the row is simply
    // absent — so it is called out rather than left to be noticed.
    const foundIds = new Set(orgs.map(org => org.id));
    const unmatchedOrgIds = (orgIds ?? []).filter(id => !foundIds.has(id));

    if (orgs.length === 0) {
      logger.info(
        `[git-org-installation-repair] ${dryRun ? 'dry-run' : 'applied'}: nothing to do` +
          (unmatchedOrgIds.length > 0
            ? ` (${unmatchedOrgIds.length} requested id(s) unmatched)`
            : '')
      );
      return {
        dryRun,
        candidates: 0,
        scanned: 0,
        results: [],
        summary: { byOutcome: {} },
        unmatchedOrgIds,
      };
    }

    const ownersByOrg = await countOwnersByOrg(
      new Map(orgs.map(org => [org.id, org.classrooms.map(classroom => classroom.id)]))
    );

    const results: GitOrgRepairResult[] = [];
    let stoppedEarly = false;
    let retryAfterSeconds: number | undefined;

    // ONE app-JWT client and ONE `GET /app/installations` for the whole run,
    // handed to every org below. Both paths take them: the dry run reads
    // through `lookupInstallationForOrg` (which writes nothing), the applying
    // run through `repairInstallation` (which owns the conditional claim). What
    // selects the path is `dryRun` itself — never the presence of a client.
    const appOctokit = GitHubProvider.getAppOctokit();

    let installations: InstallationLike[];
    try {
      installations = await listAppInstallations(appOctokit);
    } catch (error: unknown) {
      if (error instanceof GitHubRateLimitedError) {
        logger.warn('[git-org-installation-repair] throttled before the sweep began', {
          retryAfterSeconds: error.retryAfterSeconds,
        });
        return {
          dryRun,
          candidates: orgs.length,
          scanned: 0,
          results: [],
          summary: { byOutcome: {} },
          unmatchedOrgIds,
          stoppedEarly: true,
          retryAfterSeconds: error.retryAfterSeconds,
        };
      }
      throw error;
    }

    for (const [index, org] of orgs.entries()) {
      if (index > 0) await sleep(DELAY_BETWEEN_ORGS_MS);

      const base = {
        orgId: org.id,
        login: org.login,
        classrooms: org.classrooms.length,
        owners: ownersByOrg.get(org.id) ?? 0,
      };

      try {
        if (dryRun) {
          const lookup = await lookupInstallationForOrg(appOctokit, org, { installations });
          results.push(
            lookup.status === 'found'
              ? {
                  ...base,
                  outcome: 'would-connect',
                  installationId: lookup.synced.github_installation_id,
                }
              : { ...base, outcome: lookup.status }
          );
          continue;
        }

        const repair = await repairInstallation(org.id, {
          appOctokit,
          installations,
          bypassCooldown: true,
        });

        if (repair.status === 'rate-limited') {
          results.push({ ...base, outcome: 'rate-limited' });
          stoppedEarly = true;
          retryAfterSeconds = repair.retryAfterSeconds;
          break;
        }

        results.push({
          ...base,
          outcome: repair.status,
          ...(repair.status === 'connected' || repair.status === 'already-connected'
            ? { installationId: repair.org?.github_installation_id ?? undefined }
            : {}),
          // `repairInstallation` swallows unexpected failures into a status, so
          // its message is the only account of what actually went wrong.
          ...(repair.status === 'error' ? { message: repair.message } : {}),
        });
      } catch (error: unknown) {
        // A throttle is the one failure that must stop the sweep: every
        // remaining org would collect the same refusal and read as
        // "not installed", which is the wrong thing to tell an instructor.
        if (error instanceof GitHubRateLimitedError) {
          results.push({ ...base, outcome: 'rate-limited' });
          stoppedEarly = true;
          retryAfterSeconds = error.retryAfterSeconds;
          break;
        }

        const message = error instanceof Error ? error.message : String(error);
        logger.error('Installation repair failed for org', {
          orgId: org.id,
          login: org.login,
          error: message,
        });
        results.push({ ...base, outcome: 'error', message });
      }
    }

    const byOutcome = summarize(results);

    logger.info(
      `[git-org-installation-repair] ${dryRun ? 'dry-run' : 'applied'}: ${results.length}/${orgs.length} orgs scanned` +
        `${stoppedEarly ? ` (stopped early, retry in ${retryAfterSeconds}s)` : ''} — ` +
        (Object.entries(byOutcome)
          .map(([outcome, count]) => `${outcome}=${count}`)
          .join(' ') || 'nothing to do')
    );

    return {
      dryRun,
      candidates: orgs.length,
      scanned: results.length,
      results,
      summary: { byOutcome },
      unmatchedOrgIds,
      ...(stoppedEarly ? { stoppedEarly, retryAfterSeconds } : {}),
    };
  },
});
