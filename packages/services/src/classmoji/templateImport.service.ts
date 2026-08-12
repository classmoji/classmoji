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

export interface TemplateDuplicationSummary {
  /** distinct templates duplicated */
  duplicated: number;
  /** imported Repository rows repointed */
  relinked: number;
  /** source template ref (`owner/name`) → new repo name in the target org */
  template_map: Record<string, string>;
  warnings: string[];
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
  _opts: Record<string, never> = {}
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
  if (groups.length === 0) return summary;

  const targetProvider = getGitProvider(targetOrg);
  const targetNamespace = targetClassroom.content_namespace ?? '';

  for (const group of groups) {
    const sourceRef = formatTemplateRef(group.ref);
    const scope = `template ${sourceRef}`;

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

      await targetProvider.createRepository(targetOrg.login, newName, true);
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

      const newRef = `${targetOrg.login}/${newName}`;
      let relinked = 0;
      for (const rawRef of group.rawRefs) {
        const { count } = await getPrisma().repository.updateMany({
          where: { id: { in: scopedIds }, template: rawRef },
          data: { template: newRef },
        });
        relinked += count;
      }

      summary.duplicated++;
      summary.relinked += relinked;
      summary.template_map[sourceRef] = newName;
    } catch (error: unknown) {
      warn(scope, `duplication failed: ${errText(error)}`);
    }
  }

  return summary;
};
