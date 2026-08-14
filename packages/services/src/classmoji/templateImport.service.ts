/**
 * templateImport.service.ts — duplicate the assignment TEMPLATE repositories an
 * import just carried over, as PRIVATE repos in the TARGET classroom's org, and
 * repoint the imported Repository rows at the copies.
 *
 * Why: `repositoryImport.cloneModule` copies `Repository.template` verbatim, so
 * an imported term keeps pointing at the previous term's template. Editing or
 * deleting that template then changes the new term, and a CROSS-ORG import
 * leaves a ref the target org cannot even read (student provisioning clones the
 * template with the TARGET org's installation token).
 *
 * Mirrors contentImport.service: ContentService reads (raw base64, 1MB per-file
 * cap), ONE uploadBatch commit per template, warn() accumulation, and pure
 * helpers kept separable for unit tests.
 *
 * Never touches the SOURCE classroom's rows or repos: every relink is scoped to
 * the caller-supplied imported row ids, and the duplicate is always a NEW repo.
 */

import getPrisma from '@classmoji/database';
import { ContentService } from '../content/ContentService.ts';
import { getGitProvider } from '../git/index.ts';

/** GitHub Contents API caps single-file reads at 1MB — larger files are skipped. */
const ONE_MB = 1024 * 1024;

/** Templates are starter code, not monorepos: past this a template is skipped whole. */
const MAX_TEMPLATE_FILES = 200;

/** Cap on retained warnings and on per-warning detail length (bounded output). */
const MAX_WARNINGS = 50;
const WARNING_DETAIL_MAX = 200;

/** GitHub repository names are capped at 100 characters. */
const MAX_REPO_NAME_LENGTH = 100;

/** Candidate names tried before giving up on a free name in the target org. */
const MAX_NAME_CANDIDATES = 10;

/**
 * Minimum spacing between repository CREATE calls.
 *
 * GitHub enforces a secondary rate limit on content-creation requests
 * (repo/issue/comment creates) that is far tighter than the 5000/hr primary
 * limit and is not advertised in the rate-limit headers. Creating ~14 template
 * duplicates back-to-back tripped it in production and wedged the next create
 * in octokit's retry/backoff for over half an hour. In a background job with a
 * progress bar, spacing the creates out is free; tripping the limit is not.
 */
const REPO_CREATE_SPACING_MS = 15_000;

/** Retries for a create that trips the secondary limit before the item is given up on. */
const MAX_SECONDARY_LIMIT_RETRIES = 3;

/** Upper bound on an honored Retry-After, so one bad header cannot stall the job. */
const MAX_RETRY_AFTER_MS = 120_000;

/** Wait for a named secondary-limit trip that carries no header — GitHub's own advice. */
const SECONDARY_LIMIT_DEFAULT_WAIT_MS = 60_000;

export interface TemplateDuplicationSummary {
  /** distinct templates duplicated */
  duplicated: number;
  /** imported Repository rows repointed */
  relinked: number;
  /** source template ref (`owner/name`) → new repo name in the target org */
  template_map: Record<string, string>;
  warnings: string[];
}

export interface TemplateImportOptions {
  onProgress?: (update: {
    done: number;
    total: number;
    /** Transient status (e.g. a rate-limit wait). `null` clears it. */
    note?: string | null;
  }) => void | Promise<void>;
  /**
   * Templates a PREVIOUS run of this same import already duplicated: source ref
   * (`owner/name`) → the duplicate's name in the target org.
   *
   * Resume support. Duplicating a repo is not idempotent — a second run would
   * mint `lab1-template-2` beside the perfectly good `lab1-template` the first
   * run made, and burn a paced 15s create doing it. A ref listed here is
   * RELINKED ONLY: the rows are repointed if they aren't already (a run that
   * died between the create and the relink left them stale), and no GitHub call
   * is made at all.
   */
  knownTemplateMap?: Readonly<Record<string, string>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (unit-tested — no DB/GitHub)
// ─────────────────────────────────────────────────────────────────────────────

export interface TemplateRef {
  owner: string;
  name: string;
}

/**
 * Parse a stored `Repository.template`. The canonical form is owner-qualified
 * (`owner/name` — the repo-form autocomplete writes GitHub's `full_name`, and
 * three consumers do `template.split('/')`), but `repo_create` over MCP accepts
 * a bare name, so bare rows exist: those resolve against `fallbackOwner`.
 * Returns null for empty/unusable refs.
 */
export function parseTemplateRef(
  ref: string | null | undefined,
  fallbackOwner: string
): TemplateRef | null {
  const segments = (ref ?? '')
    .split('/')
    .map(segment => segment.trim())
    .filter(Boolean);
  if (segments.length === 1) {
    return fallbackOwner ? { owner: fallbackOwner, name: segments[0]! } : null;
  }
  if (segments.length === 2) {
    return { owner: segments[0]!, name: segments[1]! };
  }
  // Empty, or more path segments than a repo ref can carry — unusable.
  return null;
}

/** Canonical `owner/name`, the format every `template.split('/')` consumer needs. */
export function formatTemplateRef(ref: TemplateRef): string {
  return `${ref.owner}/${ref.name}`;
}

/** Grouping key for a template ref — GitHub logins and repo names are case-insensitive. */
export function templateRefKey(ref: TemplateRef): string {
  return `${ref.owner.toLowerCase()}/${ref.name.toLowerCase()}`;
}

/** One distinct template plus every raw `template` string that resolved to it. */
export interface TemplateRefGroup {
  ref: TemplateRef;
  /** the exact stored strings — relinks match on these, never on the canonical form */
  rawRefs: string[];
}

/**
 * Collapse the imported rows' `template` values into distinct templates. Bare
 * and owner-qualified spellings of the same repo group together, so a template
 * shared by several rows is duplicated ONCE and every spelling gets relinked.
 */
export function groupTemplateRefs(
  rows: ReadonlyArray<{ template: string | null }>,
  fallbackOwner: string
): TemplateRefGroup[] {
  const groups = new Map<string, TemplateRefGroup>();
  for (const row of rows) {
    const ref = parseTemplateRef(row.template, fallbackOwner);
    if (!ref) continue;
    const key = templateRefKey(ref);
    const existing = groups.get(key);
    const raw = row.template as string;
    if (existing) {
      if (!existing.rawRefs.includes(raw)) existing.rawRefs.push(raw);
      continue;
    }
    groups.set(key, { ref, rawRefs: [raw] });
  }
  return [...groups.values()];
}

/**
 * The already-made duplicate's name for `ref`, or null when this template has
 * not been duplicated yet.
 *
 * Matched on `templateRefKey`, not on raw string equality: the map is written
 * from `formatTemplateRef` output, but the rows it will be compared against can
 * spell the same template with different casing (GitHub is case-insensitive),
 * and a missed match would duplicate the template a second time.
 */
export function lookupKnownTemplate(
  knownTemplateMap: Readonly<Record<string, string>> | undefined,
  ref: TemplateRef,
  fallbackOwner: string
): string | null {
  if (!knownTemplateMap) return null;
  const wanted = templateRefKey(ref);
  for (const [knownRef, newName] of Object.entries(knownTemplateMap)) {
    const parsed = parseTemplateRef(knownRef, fallbackOwner);
    if (parsed && templateRefKey(parsed) === wanted) return newName || null;
  }
  return null;
}

/**
 * Names to try, in order, for the duplicate in the target org: the original
 * name, then namespace-qualified, then numbered. Pure — the caller runs the
 * `repositoryExists` probe over these. Each candidate is clamped to GitHub's
 * 100-character repo-name limit.
 */
export function templateNameCandidates(
  name: string,
  targetNamespace: string,
  limit: number = MAX_NAME_CANDIDATES
): string[] {
  const namespaced = targetNamespace ? `${name}-${targetNamespace}` : name;
  const candidates: string[] = [];
  // Clamping can make two candidates collide (a long name and its namespaced
  // form truncate to the same 100 chars), so dedupe as we go — a repeated
  // candidate would waste a repositoryExists probe on a name already rejected.
  const push = (value: string) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };
  push(name.slice(0, MAX_REPO_NAME_LENGTH));
  push(namespaced.slice(0, MAX_REPO_NAME_LENGTH));
  for (let n = 2; candidates.length < limit && n < limit + 2; n++) {
    const suffix = `-${n}`;
    push(namespaced.slice(0, MAX_REPO_NAME_LENGTH - suffix.length) + suffix);
  }
  return candidates.slice(0, limit);
}

/** Format one warning with truncated detail: `scope: detail…`. */
export function formatWarning(scope: string, detail: string): string {
  const trimmed =
    detail.length > WARNING_DETAIL_MAX ? `${detail.slice(0, WARNING_DETAIL_MAX)}…` : detail;
  return `${scope}: ${trimmed}`;
}

/** Case-insensitive header read — octokit lowercases, other error shapes may not. */
function readHeader(headers: Record<string, unknown>, name: string): unknown {
  if (name in headers) return headers[name];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

/** A numeric header value (octokit hands them back as strings), or null. */
function headerNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Detect GitHub's secondary rate limit and the wait it asks for. Matches the
 * documented shapes: a 403/429 whose message names the secondary limit or the
 * abuse-detection mechanism, and/or a `retry-after` (seconds) or
 * `x-ratelimit-reset` (epoch seconds) header. Returns null when the error is
 * something else, so ordinary failures keep their existing per-item handling.
 */
export function parseSecondaryRateLimit(
  error: unknown,
  nowMs: number = Date.now()
): { retryAfterMs: number } | null {
  if (!error || typeof error !== 'object') return null;
  const { status, message, response } = error as {
    status?: unknown;
    message?: unknown;
    response?: { headers?: Record<string, unknown> | null } | null;
  };
  if (status !== 403 && status !== 429) return null;

  const headers = response?.headers ?? {};
  const retryAfterSeconds = headerNumber(readHeader(headers, 'retry-after'));
  const text = typeof message === 'string' ? message.toLowerCase() : '';
  const named = text.includes('secondary rate limit') || text.includes('abuse detection');

  // `x-ratelimit-reset` rides on nearly every GitHub response, an ordinary
  // permissions 403 included — it may SIZE the wait but must never be what
  // detects one, or every 403 would be retried as if it were a rate limit.
  if (!named && retryAfterSeconds === null) return null;

  let waitMs: number | null = null;
  if (retryAfterSeconds !== null) {
    waitMs = retryAfterSeconds * 1000;
  } else {
    const resetSeconds = headerNumber(readHeader(headers, 'x-ratelimit-reset'));
    if (resetSeconds !== null) waitMs = resetSeconds * 1000 - nowMs;
  }
  // The common shape is a named trip with no header at all: GitHub just says to
  // wait a while, so fall back to the interval its own docs suggest.
  if (waitMs === null) waitMs = SECONDARY_LIMIT_DEFAULT_WAIT_MS;

  // Clamped both ways: a stale reset (already past) must still cost a real
  // pause, and one absurd header must not park the job for an hour.
  return { retryAfterMs: Math.min(Math.max(Math.round(waitMs), 1000), MAX_RETRY_AFTER_MS) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Impl helpers (touch DB/GitHub — not unit-tested)
// ─────────────────────────────────────────────────────────────────────────────

// Structural git-org shape ContentService + the git provider accept.
interface GitOrgRecord {
  id: string;
  provider: string;
  login: string;
  github_installation_id?: string | null;
  access_token?: string | null;
  base_url?: string | null;
  gitlab_group_id?: string | null;
}

type WarnFn = (scope: string, detail: string) => void;

type BatchFile = { path: string; content: string; encoding: 'base64' };

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The only timers in this file: create pacing and secondary-limit backoff. */
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Fire-and-forget progress. Progress reporting must never fail (or slow) an
 * import, so the result is deliberately not awaited and every error is
 * swallowed — including a synchronous throw from a bad callback.
 */
function emitProgress<T>(
  onProgress: ((update: T) => void | Promise<void>) | undefined,
  update: T
): void {
  if (!onProgress) return;
  try {
    void Promise.resolve(onProgress(update)).catch(() => {});
  } catch {
    // ignore
  }
}

/**
 * Create the duplicate repo, riding out GitHub's secondary rate limit instead
 * of letting octokit's internal backoff swallow the run: a detected trip is
 * reported as a NOTE on the still-running phase — a visible wait rather than a
 * hang — then slept off and retried, up to MAX_SECONDARY_LIMIT_RETRIES times.
 *
 * Only the create is wrapped. The file reads and the uploadBatch keep their
 * existing single-attempt handling, and once the retries are spent the ORIGINAL
 * error is rethrown untouched so the per-template catch warns and skips exactly
 * as it always has.
 */
async function createRepositoryWithBackoff({
  provider,
  orgLogin,
  name,
  onWait,
}: {
  provider: ReturnType<typeof getGitProvider>;
  orgLogin: string;
  name: string;
  onWait: (note: string | null) => void;
}): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await provider.createRepository(orgLogin, name, true);
      return;
    } catch (error: unknown) {
      const limit = parseSecondaryRateLimit(error);
      if (!limit || attempt >= MAX_SECONDARY_LIMIT_RETRIES) throw error;
      onWait(`waiting out GitHub rate limit (~${Math.round(limit.retryAfterMs / 1000)}s)`);
      await sleep(limit.retryAfterMs);
      onWait(null);
    }
  }
}

/**
 * Every file path in a repo's DEFAULT branch. Reads omit `ref` on purpose —
 * templates are not content repos and their default branch is often not `main`;
 * the Contents API resolves the real default when no ref is given. Aborts as
 * soon as the count exceeds `cap` so an oversized template costs a directory
 * walk, not 200 content reads.
 */
async function listRepoFilePaths(
  gitOrganization: GitOrgRecord,
  repo: string,
  cap: number
): Promise<{ paths: string[]; exceededCap: boolean }> {
  const paths: string[] = [];

  const walk = async (dirPath: string): Promise<boolean> => {
    const entries = await ContentService.listFolder({
      gitOrganization,
      repo,
      path: dirPath,
      skipCache: true,
    });
    for (const entry of entries) {
      if (entry.type === 'dir') {
        if (await walk(entry.path)) return true;
        continue;
      }
      paths.push(entry.path);
      if (paths.length > cap) return true;
    }
    return false;
  };

  const exceededCap = await walk('');
  return { paths, exceededCap };
}

/**
 * Read each path as raw base64 off the default branch. Files over 1MB are
 * skipped with a warning (the Contents API returns no usable body for them).
 */
async function readRepoFiles({
  gitOrganization,
  repo,
  paths,
  scope,
  warn,
}: {
  gitOrganization: GitOrgRecord;
  repo: string;
  paths: string[];
  scope: string;
  warn: WarnFn;
}): Promise<BatchFile[]> {
  const files: BatchFile[] = [];
  for (const path of paths) {
    const meta = await ContentService.getMeta({
      gitOrganization,
      repo,
      path,
      skipCache: true,
    });
    if (meta && meta.size > ONE_MB) {
      warn(scope, `skipped ${path} (>1MB, ${meta.size} bytes)`);
      continue;
    }
    const file = await ContentService.getContent({
      gitOrganization,
      repo,
      path,
      raw: true,
      skipCache: true,
    });
    if (!file) {
      warn(scope, `could not read ${path}`);
      continue;
    }
    files.push({ path, content: file.content, encoding: 'base64' });
  }
  return files;
}

/** First candidate name free in the target org, or null when all are taken. */
async function resolveFreeRepoName(
  provider: ReturnType<typeof getGitProvider>,
  orgLogin: string,
  candidates: string[]
): Promise<string | null> {
  for (const candidate of candidates) {
    if (!(await provider.repositoryExists(orgLogin, candidate))) return candidate;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Duplicate the distinct template repos referenced by `importedRepositoryIds`
 * into the target classroom's org as PRIVATE repos, then repoint those rows.
 *
 * Resilience: every failure mode is a warning that KEEPS the original ref —
 * an unreadable template, an oversized one, a name-collision exhaustion, a
 * failed create or commit. A template whose owner is neither the target org nor
 * the source classroom's org is not readable with any installation this flow
 * holds, so it is warned and left linked.
 */
export const duplicateImportedTemplates = async (
  sourceClassroomId: string,
  targetClassroomId: string,
  importedRepositoryIds: string[],
  opts: TemplateImportOptions = {}
): Promise<TemplateDuplicationSummary> => {
  const warnings: string[] = [];
  const warn: WarnFn = (scope, detail) => {
    if (warnings.length >= MAX_WARNINGS) return;
    warnings.push(formatWarning(scope, detail));
  };

  const summary: TemplateDuplicationSummary = {
    duplicated: 0,
    relinked: 0,
    template_map: {},
    warnings,
  };

  if (importedRepositoryIds.length === 0) return summary;

  const [sourceClassroom, targetClassroom] = await Promise.all([
    getPrisma().classroom.findUnique({
      where: { id: sourceClassroomId },
      include: { git_organization: true },
    }),
    getPrisma().classroom.findUnique({
      where: { id: targetClassroomId },
      include: { git_organization: true },
    }),
  ]);

  const targetOrg = targetClassroom?.git_organization as GitOrgRecord | null | undefined;
  if (!targetClassroom || !targetOrg?.login) {
    warn('templates', 'target classroom has no git organization');
    return summary;
  }
  if (targetOrg.provider !== 'GITHUB') {
    warn(
      'templates',
      `template duplication supports GitHub only (target is ${targetOrg.provider})`
    );
    return summary;
  }
  const sourceOrg = sourceClassroom?.git_organization as GitOrgRecord | null | undefined;

  // Scope to the target classroom as well as the id list — the relink queries
  // below inherit this scope, which is what keeps SOURCE rows untouched.
  const importedRows = await getPrisma().repository.findMany({
    where: { id: { in: importedRepositoryIds }, classroom_id: targetClassroomId },
    select: { id: true, template: true },
  });
  const scopedIds = importedRows.map(row => row.id);
  if (scopedIds.length === 0) return summary;

  const groups = groupTemplateRefs(importedRows, sourceOrg?.login ?? targetOrg.login);

  /**
   * Repoint every imported row that spells this template one of `rawRefs` at the
   * duplicate `newName`, returning how many rows actually changed. Scoped to
   * `scopedIds` (target-classroom rows only) — that scope is what keeps SOURCE
   * rows untouched. A row already pointing at the new ref reports 0, which is
   * what makes a resumed relink a no-op rather than a double count.
   */
  const relinkRows = async (rawRefs: string[], newName: string): Promise<number> => {
    const newRef = `${targetOrg.login}/${newName}`;
    let relinked = 0;
    for (const rawRef of rawRefs) {
      const { count } = await getPrisma().repository.updateMany({
        where: { id: { in: scopedIds }, template: rawRef },
        data: { template: newRef },
      });
      relinked += count;
    }
    return relinked;
  };

  // The real total lands before the empty-set return, so the bar sizes itself
  // the moment the phase starts even when there is nothing to duplicate.
  const total = groups.length;
  let consumed = 0;
  /**
   * Count/note emit for this phase. An omitted `note` LEAVES the current one
   * alone (the progress reducer's convention); `null` clears it.
   */
  const emit = (note?: string | null) =>
    emitProgress(opts.onProgress, { done: consumed, total, note });
  emit();

  if (groups.length === 0) return summary;

  const targetProvider = getGitProvider(targetOrg);
  const targetNamespace = targetClassroom.content_namespace ?? '';

  // Pacing is per RUN, not per template: the first create pays nothing, every
  // later one waits out REPO_CREATE_SPACING_MS first.
  let attemptedAnyCreate = false;

  for (const group of groups) {
    // `finally` owns the count, not the end of the body: every skip below is a
    // `continue`, and `done` tracks source templates CONSUMED, not duplicated.
    try {
      const sourceRef = formatTemplateRef(group.ref);
      const scope = `template ${sourceRef}`;

      // Resume: a previous attempt of THIS import already duplicated this
      // template. Repoint anything still stale (a run can die between the create
      // and the relink) and move on — no GitHub call, no second copy, and none
      // of the 15s create pacing. Counted as consumed by the `finally`, and
      // reported in `template_map` so the caller's total stays right, but NOT
      // as `duplicated`: this run did not duplicate it.
      const knownName = lookupKnownTemplate(opts.knownTemplateMap, group.ref, targetOrg.login);
      if (knownName) {
        try {
          summary.relinked += await relinkRows(group.rawRefs, knownName);
          summary.template_map[sourceRef] = knownName;
        } catch (error: unknown) {
          warn(scope, `relink of the existing duplicate failed: ${errText(error)}`);
        }
        continue;
      }

      // Readable only through an installation this flow holds: the target org's,
      // or the source classroom's. Anything else (a third org, a personal
      // account) stays linked to the original.
      const ownerLower = group.ref.owner.toLowerCase();
      let readerOrg: GitOrgRecord | null = null;
      if (ownerLower === targetOrg.login.toLowerCase()) {
        readerOrg = targetOrg;
      } else if (sourceOrg?.login && ownerLower === sourceOrg.login.toLowerCase()) {
        readerOrg = sourceOrg.provider === 'GITHUB' ? sourceOrg : null;
      }
      if (!readerOrg) {
        warn(scope, `not readable from ${targetOrg.login} — keeping the original link`);
        continue;
      }

      try {
        // Distinguish a DELETED template from an empty one — a dangling ref is
        // the exact failure this feature exists to stop repeating, so say so.
        const readerProvider = readerOrg === targetOrg ? targetProvider : getGitProvider(readerOrg);
        if (!(await readerProvider.repositoryExists(group.ref.owner, group.ref.name))) {
          warn(scope, 'skipped — template repository no longer exists');
          continue;
        }

        const { paths, exceededCap } = await listRepoFilePaths(
          readerOrg,
          group.ref.name,
          MAX_TEMPLATE_FILES
        );
        if (exceededCap) {
          warn(scope, `skipped — more than ${MAX_TEMPLATE_FILES} files`);
          continue;
        }
        if (paths.length === 0) {
          warn(scope, 'skipped — no readable files on the default branch');
          continue;
        }

        const files = await readRepoFiles({
          gitOrganization: readerOrg,
          repo: group.ref.name,
          paths,
          scope,
          warn,
        });
        if (files.length === 0) {
          warn(scope, 'skipped — every file was unreadable or oversized');
          continue;
        }

        const newName = await resolveFreeRepoName(
          targetProvider,
          targetOrg.login,
          templateNameCandidates(group.ref.name, targetNamespace)
        );
        if (!newName) {
          warn(scope, `skipped — no free repository name in ${targetOrg.login}`);
          continue;
        }

        // Pace BEFORE the retry loop, so a create that just slept off a
        // rate-limit backoff is not made to wait all over again.
        if (attemptedAnyCreate) {
          emit('pacing repository creation to stay under GitHub limits');
          await sleep(REPO_CREATE_SPACING_MS);
          emit(null);
        }
        // Marked on ATTEMPT, not on success: a failed create still spends
        // GitHub's content-creation budget, so the next one still gets paced.
        attemptedAnyCreate = true;
        await createRepositoryWithBackoff({
          provider: targetProvider,
          orgLogin: targetOrg.login,
          name: newName,
          onWait: emit,
        });
        try {
          // The new repo has no commits: allowRootCommit seeds the initial commit
          // (Contents API — the Git Data API 409s on an empty repo) and creates
          // `main`, which becomes the default branch.
          await ContentService.uploadBatch({
            gitOrganization: targetOrg,
            repo: newName,
            files,
            branch: 'main',
            message: `Duplicated from ${sourceRef} for ${targetClassroom.slug}`,
            allowRootCommit: true,
          });
        } catch (uploadError: unknown) {
          // Drop the repo we just made rather than leave an empty shell behind —
          // it has no commits, and the rows still point at the original template.
          try {
            await targetProvider.deleteRepository(targetOrg.login, newName);
          } catch (cleanupError: unknown) {
            warn(scope, `left an empty ${newName} behind: ${errText(cleanupError)}`);
          }
          throw uploadError;
        }

        summary.duplicated++;
        summary.relinked += await relinkRows(group.rawRefs, newName);
        summary.template_map[sourceRef] = newName;
      } catch (error: unknown) {
        warn(scope, `duplication failed: ${errText(error)}`);
      }
    } finally {
      consumed++;
      emit();
    }
  }

  return summary;
};
