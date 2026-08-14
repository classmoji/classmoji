import getPrisma from '@classmoji/database';
import { GitHubProvider } from '../git/index.ts';
import type { Prisma, Role } from '@prisma/client';

/**
 * Whitelist of setting fields that are SAFE to expose to the client.
 * NEVER add secret fields (API keys, tokens, etc.) to this list.
 */
const SAFE_SETTINGS_FIELDS = [
  'llm_model',
  'llm_provider',
  'llm_temperature',
  'llm_max_tokens',
  'code_aware_model',
  'syllabus_bot_enabled',
  'syllabus_bot_model',
  'content_repo_name',
  'slides_enabled',
  'quizzes_enabled',
  'default_tokens_per_hour',
  'late_penalty_points_per_hour',
  'show_grades_to_students',
  'show_modules',
  'show_pages',
  'show_repos',
  'default_student_page',
  'recent_viewers_enabled',
  'theme',
];

/**
 * Find a Classroom by its UUID
 * @param {string} id - UUID of the Classroom
 * @returns {Promise<Object|null>}
 */
export const findById = async (id: string) => {
  return getPrisma().classroom.findUnique({
    where: { id },
    include: {
      git_organization: true,
      settings: true,
      tags: true,
    },
  });
};

/**
 * Find a Classroom by its unique slug
 * @param {string} slug - URL-friendly slug (e.g., "cs101-fall-2025")
 * @returns {Promise<Object|null>}
 */
export const findBySlug = async (slug: string) => {
  return getPrisma().classroom.findFirst({
    where: { slug },
    include: {
      git_organization: true,
      settings: true,
      tags: true,
    },
  });
};

/**
 * Find all Classrooms for a GitOrganization
 * @param {string} gitOrgId - UUID of the GitOrganization
 * @returns {Promise<Object[]>}
 */
export const findByGitOrgId = async (gitOrgId: string) => {
  return getPrisma().classroom.findMany({
    where: { git_org_id: gitOrgId },
    include: {
      settings: true,
      tags: true,
    },
    orderBy: { created_at: 'desc' },
  });
};

/**
 * Find all Classrooms where a user is a member
 * @param {string} userId - UUID of the User
 * @param {string} [role] - Optional role filter
 * @returns {Promise<Object[]>}
 */
export const findByUserId = async (userId: string, role: Role | null = null) => {
  const where: Prisma.ClassroomMembershipWhereInput = { user_id: userId };
  if (role) where.role = role;

  const memberships = await getPrisma().classroomMembership.findMany({
    where,
    include: {
      classroom: {
        include: {
          git_organization: true,
          settings: true,
        },
      },
    },
    orderBy: { created_at: 'desc' },
  });

  return memberships.map(m => ({
    ...m.classroom,
    membership: {
      role: m.role,
      is_grader: m.is_grader,
      has_accepted_invite: m.has_accepted_invite,
    },
  }));
};

/**
 * Find all active Classrooms
 * @param {Object} query - Optional where clause
 * @returns {Promise<Object[]>}
 */
export const findAll = async (query: Prisma.ClassroomWhereInput = {}) => {
  return getPrisma().classroom.findMany({
    where: { ...query },
    include: {
      git_organization: true,
      settings: true,
    },
    orderBy: { created_at: 'desc' },
  });
};

/**
 * Create a new Classroom
 * @param {Object} data - Classroom data
 * @param {string} data.git_org_id - UUID of the GitOrganization
 * @param {string} data.slug - URL-friendly slug
 * @param {string} data.name - Display name
 * @param {string} data.content_namespace - Internal identifier (names no repo)
 * @param {string} data.content_repo - GitHub repo holding this classroom's content
 * @param {string} [data.emoji] - Emoji (default: "dart")
 * @returns {Promise<Object>}
 */
export const create = async (data: Prisma.ClassroomUncheckedCreateInput) => {
  return getPrisma().classroom.create({
    data,
    include: {
      git_organization: true,
      settings: true,
    },
  });
};

/**
 * Create a Classroom with its settings in a transaction
 * @param {Object} classroomData - Classroom data
 * @param {Object} settingsData - ClassroomSettings data (without classroom_id)
 * @returns {Promise<Object>}
 */
export const createWithSettings = async (
  classroomData: Prisma.ClassroomUncheckedCreateInput,
  settingsData: Prisma.ClassroomSettingsUncheckedCreateWithoutClassroomInput = {}
) => {
  return getPrisma().$transaction(async tx => {
    const classroom = await tx.classroom.create({
      data: classroomData,
    });

    await tx.classroomSettings.create({
      data: {
        classroom_id: classroom.id,
        ...settingsData,
      },
    });

    return tx.classroom.findUnique({
      where: { id: classroom.id },
      include: {
        git_organization: true,
        settings: true,
      },
    });
  });
};

/**
 * Update a Classroom
 * @param {string} id - UUID of the Classroom
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>}
 */
export const update = async (id: string, updates: Prisma.ClassroomUpdateInput) => {
  return getPrisma().classroom.update({
    where: { id },
    data: updates,
    include: {
      git_organization: true,
      settings: true,
    },
  });
};

/**
 * Update a Classroom by slug
 * @param {string} slug - Classroom slug
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>}
 */
export const updateBySlug = async (slug: string, updates: Prisma.ClassroomUpdateInput) => {
  const classroom = await getPrisma().classroom.findFirst({
    where: { slug },
    select: { id: true },
  });
  if (!classroom) {
    throw new Error(`Classroom with slug "${slug}" not found`);
  }
  return getPrisma().classroom.update({
    where: { id: classroom.id },
    data: updates,
    include: {
      git_organization: true,
      settings: true,
    },
  });
};

/**
 * Delete a Classroom by ID
 * @param {string} id - UUID of the Classroom
 * @returns {Promise<Object>}
 */
export const deleteById = async (id: string) => {
  return getPrisma().classroom.delete({
    where: { id },
  });
};

/** One GitHub artifact the optional delete-cleanup will remove. */
export interface GitHubArtifact {
  kind: 'repo' | 'team';
  org: string;
  /** Repo name or team slug. */
  name: string;
  /** Human label for summaries ('content repo', 'classroom team', …). */
  label: string;
}

/**
 * Pure helper: the duplicate-template repo names an import actually CREATED for
 * this classroom, read out of its `ImportJob.progress`.
 *
 * PROVENANCE, never inference. A template repo is only ever deletable because
 * THIS classroom's import made it — never because it merely looks unused or
 * carries a familiar name. Reference-counting was considered and rejected: in a
 * small org the only classroom referencing a hand-authored original would make
 * that original look exclusive, and cleanup would destroy the instructor's real
 * template. Naming heuristics are equally unsafe — a same-org duplicate is
 * effectively always term-suffixed (the original name is taken), while a
 * CROSS-ORG duplicate usually keeps the bare original name, so the two are
 * indistinguishable by name alone.
 *
 * Reads `id_maps.templates` (canonical: source ref → created name) and the
 * `template_map` alias, tolerating anything in the Json column — a row written
 * by an older shape must degrade to "no template artifacts", never throw.
 * A classroom with no ImportJob (every pre-feature classroom) yields none.
 */
export function importedTemplateRepoNames(progress: unknown): string[] {
  if (!progress || typeof progress !== 'object') return [];
  const record = progress as Record<string, unknown>;
  const idMaps = record.id_maps;
  const sources = [
    idMaps && typeof idMaps === 'object'
      ? (idMaps as Record<string, unknown>).templates
      : undefined,
    record.template_map,
  ];

  const names: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const value of Object.values(source as Record<string, unknown>)) {
      if (typeof value !== 'string') continue;
      const name = value.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    }
  }
  return names;
}

/**
 * Pure helper: the repo NAMES a set of stored `Repository.template` refs point
 * at WITHIN `orgLogin`, de-duplicated case-insensitively (GitHub repo names and
 * logins are case-insensitive; the first spelling seen wins).
 *
 * Two accepted ref shapes, matching what the app writes: the canonical
 * owner-qualified `owner/name` (the repo-form autocomplete stores GitHub's
 * `full_name`), and a bare `name` (accepted by `repo_create` over MCP), which
 * resolves against the classroom's OWN org exactly as templateImport resolves
 * it. A ref owned by any other account is somebody else's repo and is dropped.
 *
 * Used to work out which OTHER classrooms still point at a duplicate this
 * classroom created — not to discover deletable repos on its own.
 */
export function ownedTemplateRepoNames(
  templateRefs: ReadonlyArray<string | null | undefined>,
  orgLogin: string
): string[] {
  const wantedOwner = orgLogin.toLowerCase();
  const names: string[] = [];
  const seen = new Set<string>();
  for (const ref of templateRefs) {
    const segments = (ref ?? '')
      .split('/')
      .map(segment => segment.trim())
      .filter(Boolean);
    let name: string | null = null;
    if (segments.length === 1) {
      name = segments[0]!;
    } else if (segments.length === 2 && segments[0]!.toLowerCase() === wantedOwner) {
      name = segments[1]!;
    }
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

/**
 * Pure helper: of the duplicate templates this classroom's import created, the
 * ones no OTHER classroom in the org still points at.
 *
 * The safety guard on top of provenance: an instructor can relink a later
 * term's assignment to a duplicate this classroom made, and deleting it would
 * break that live classroom. Comparison is by resolved repo NAME within the
 * org, so `org/lab1-26w` and a bare `lab1-26w` both count as a reference.
 */
export function exclusiveImportedTemplateNames({
  createdNames,
  otherClassroomTemplateRefs,
  orgLogin,
}: {
  createdNames: string[];
  otherClassroomTemplateRefs: ReadonlyArray<string | null | undefined>;
  orgLogin: string;
}): string[] {
  const stillReferenced = new Set(
    ownedTemplateRepoNames(otherClassroomTemplateRefs, orgLogin).map(name => name.toLowerCase())
  );
  return createdNames.filter(name => !stillReferenced.has(name.toLowerCase()));
}

/**
 * Pure helper: enumerate the GitHub artifacts a classroom owns, from DB-known
 * facts ONLY — the content repo (the classroom's STORED content_repo name),
 * the two conventional classroom teams ({slug}-students / {slug}-assistants),
 * any provider-backed project-team slugs, the classroom's git repos by exact
 * recorded name, and the duplicate TEMPLATE repos its own import created (the
 * caller supplies only those no other classroom in the org still references).
 * Nothing is pattern-matched or discovered live: if the DB doesn't name it, it
 * is not in the plan.
 *
 * Template repos are listed LAST among repos, and any name already claimed by
 * the content repo or an assignment repo is dropped rather than listed twice —
 * one repo must appear once, or the modal double-counts and the executor issues
 * a pointless second DELETE.
 */
export function classroomGitHubArtifactPlan({
  orgLogin,
  slug,
  contentRepo,
  gitRepoNames,
  teamSlugs,
  templateRepoNames = [],
}: {
  orgLogin: string;
  slug: string;
  contentRepo: string | null;
  gitRepoNames: string[];
  teamSlugs: string[];
  /** Import-created duplicate templates nothing else references (see exclusiveImportedTemplateNames). */
  templateRepoNames?: string[];
}): GitHubArtifact[] {
  const plan: GitHubArtifact[] = [];
  const claimed = new Set<string>();
  const pushRepo = (name: string, label: string) => {
    const key = name.toLowerCase();
    if (claimed.has(key)) return;
    claimed.add(key);
    plan.push({ kind: 'repo', org: orgLogin, name, label });
  };

  if (contentRepo) {
    pushRepo(contentRepo, 'content repo');
  }
  for (const name of gitRepoNames) {
    pushRepo(name, 'assignment repo');
  }
  for (const name of templateRepoNames) {
    pushRepo(name, 'template repo');
  }
  for (const suffix of ['students', 'assistants']) {
    plan.push({ kind: 'team', org: orgLogin, name: `${slug}-${suffix}`, label: 'classroom team' });
  }
  for (const teamSlug of [...new Set(teamSlugs)]) {
    plan.push({ kind: 'team', org: orgLogin, name: teamSlug, label: 'project team' });
  }
  return plan;
}

/** A classroom's GitHub cleanup plan, loaded from the DB. */
export interface ClassroomGitHubPlan {
  /** Exactly the artifacts that would be deleted, in deletion order. */
  artifacts: GitHubArtifact[];
  /** Content repo held back because a sibling classroom resolves to the same repo. */
  withheld: { name: string; sharedWithSlug: string } | null;
  /** Reason no plan exists at all; reported verbatim as the executor's only failure. */
  unavailable: string | null;
}

/**
 * Load a classroom's GitHub cleanup plan from the DB. Single source of truth
 * for BOTH the danger-zone preview and the executor below, so what the user is
 * shown before confirming is exactly what gets deleted. DB reads only — never
 * calls GitHub, so it is safe in a loader.
 *
 * The content repo is held back (`withheld`, and excluded from `artifacts`)
 * when another classroom in the same org names the SAME content repo — deleting
 * it would take out live content. A DB unique constraint on
 * [git_org_id, content_repo] now prevents new collisions; this guard covers
 * rows that predate it. Teams and assignment repos are per-classroom and never
 * shared.
 *
 * @param {string} classroomId - Classroom whose artifacts to enumerate
 */
export const getClassroomGitHubArtifactPlan = async (
  classroomId: string
): Promise<ClassroomGitHubPlan> => {
  const classroom = await getPrisma().classroom.findUnique({
    where: { id: classroomId },
    include: {
      git_organization: true,
      git_repos: { select: { name: true } },
      // Provenance for the template-repo artifacts: the duplicates THIS
      // classroom's import created. The row survives until the delete cascade,
      // and this plan always runs before it.
      import_job: { select: { progress: true } },
      teams: {
        where: { provider: 'GITHUB', provider_id: { not: null } },
        select: { slug: true },
      },
    },
  });
  if (!classroom?.git_organization?.login) {
    return { artifacts: [], withheld: null, unavailable: 'no git organization' };
  }
  if (classroom.git_organization.provider !== 'GITHUB') {
    return {
      artifacts: [],
      withheld: null,
      unavailable: 'provider not supported for cleanup — artifacts left in place',
    };
  }

  // Template duplicates this classroom's import created, minus any a DIFFERENT
  // classroom in the org has since been relinked to. The `otherRefs` query is
  // skipped entirely when the import created no templates — the common case.
  const orgLogin = classroom.git_organization.login;
  const createdTemplateNames = importedTemplateRepoNames(classroom.import_job?.progress);
  const templateRepoNames = createdTemplateNames.length
    ? exclusiveImportedTemplateNames({
        createdNames: createdTemplateNames,
        otherClassroomTemplateRefs: (
          await getPrisma().repository.findMany({
            where: {
              classroom_id: { not: classroom.id },
              classroom: { git_org_id: classroom.git_org_id },
            },
            select: { template: true },
          })
        ).map(row => row.template),
        orgLogin,
      })
    : [];

  const artifacts = classroomGitHubArtifactPlan({
    orgLogin,
    slug: classroom.slug,
    contentRepo: classroom.content_repo,
    gitRepoNames: classroom.git_repos.map(r => r.name),
    teamSlugs: classroom.teams.map(t => t.slug),
    templateRepoNames,
  });

  if (!classroom.content_repo) {
    return { artifacts, withheld: null, unavailable: null };
  }
  const sharer = await getPrisma().classroom.findFirst({
    where: {
      git_org_id: classroom.git_org_id,
      content_repo: classroom.content_repo,
      id: { not: classroom.id },
    },
    select: { slug: true },
  });
  if (!sharer) {
    return { artifacts, withheld: null, unavailable: null };
  }

  const contentRepo = artifacts.find(a => a.label === 'content repo');
  return {
    artifacts: artifacts.filter(a => a.label !== 'content repo'),
    withheld: contentRepo ? { name: contentRepo.name, sharedWithSlug: sharer.slug } : null,
    unavailable: null,
  };
};

/** Result of the optional GitHub cleanup that precedes a classroom delete. */
export interface GitHubCleanupSummary {
  deleted_repos: number;
  deleted_teams: number;
  /** Artifacts that no longer existed on GitHub (already gone — not an error). */
  skipped: number;
  /** 'label name: reason' entries for artifacts that could not be deleted. */
  failures: string[];
}

/**
 * Best-effort deletion of a classroom's GitHub artifacts (content repo,
 * classroom + project teams, student assignment repos), for the danger-zone
 * "also delete from GitHub" option. MUST run BEFORE the DB delete — the
 * cascade destroys the rows that name these artifacts.
 *
 * Deletions run with the REQUESTING USER's token, never the app installation
 * token — deliberately. Classmoji user tokens are GitHub App user-to-server
 * tokens, so GitHub enforces the intersection of the app's permissions AND the
 * human's own: anything the requesting owner couldn't delete on GitHub
 * themselves fails with a 403 here, regardless of what the app installation
 * could do. There is no app-token fallback.
 *
 * Every deletion is independent and best-effort: a 404 counts as skipped
 * (already gone), any other failure (incl. permission 403s) is recorded and
 * the rest proceed. The classroom rows are never touched here.
 *
 * What gets deleted comes from getClassroomGitHubArtifactPlan — the same plan
 * the danger-zone modal previews. A withheld (shared-namespace) content repo is
 * recorded as a failure: the cleanup did not fully complete.
 *
 * @param {string} classroomId - Classroom whose artifacts to delete
 * @param {string} userToken - The requesting user's GitHub token (required)
 */
export const deleteGitHubArtifacts = async (
  classroomId: string,
  userToken: string
): Promise<GitHubCleanupSummary> => {
  if (!userToken) {
    return {
      deleted_repos: 0,
      deleted_teams: 0,
      skipped: 0,
      failures: ['no GitHub user token — nothing deleted'],
    };
  }

  const { artifacts, withheld, unavailable } = await getClassroomGitHubArtifactPlan(classroomId);
  if (unavailable) {
    return { deleted_repos: 0, deleted_teams: 0, skipped: 0, failures: [unavailable] };
  }

  // User-to-server octokit: GitHub checks the HUMAN's authority per call.
  const octokit = GitHubProvider.getUserOctokit(userToken);
  const summary: GitHubCleanupSummary = {
    deleted_repos: 0,
    deleted_teams: 0,
    skipped: 0,
    failures: [],
  };

  // Recorded before the loop so it leads the failure list.
  if (withheld) {
    summary.failures.push(
      `content repo ${withheld.name}: shared with classroom '${withheld.sharedWithSlug}' — not deleted`
    );
  }

  for (const artifact of artifacts) {
    try {
      if (artifact.kind === 'repo') {
        await octokit.request('DELETE /repos/{owner}/{repo}', {
          owner: artifact.org,
          repo: artifact.name,
        });
        summary.deleted_repos += 1;
      } else {
        await octokit.request('DELETE /orgs/{org}/teams/{team_slug}', {
          org: artifact.org,
          team_slug: artifact.name,
        });
        summary.deleted_teams += 1;
      }
    } catch (error: unknown) {
      if ((error as { status?: number })?.status === 404) {
        summary.skipped += 1;
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      summary.failures.push(`${artifact.label} ${artifact.name}: ${message}`);
    }
  }

  return summary;
};

/**
 * Delete a Classroom by slug
 * @param {string} slug - Classroom slug
 * @returns {Promise<Object>}
 */
export const deleteBySlug = async (slug: string) => {
  const classroom = await getPrisma().classroom.findFirst({
    where: { slug },
    select: { id: true },
  });
  if (!classroom) {
    throw new Error(`Classroom with slug "${slug}" not found`);
  }
  return getPrisma().classroom.delete({
    where: { id: classroom.id },
  });
};

/**
 * Count Classrooms in a GitOrganization
 * @param {string} gitOrgId - UUID of the GitOrganization
 * @returns {Promise<number>}
 */
export const countByGitOrg = async (gitOrgId: string) => {
  return getPrisma().classroom.count({
    where: { git_org_id: gitOrgId },
  });
};

/**
 * Get Classroom with settings SAFE for client consumption.
 * This sanitizes settings to remove API keys and other secrets.
 * NEVER use this for server-side operations that need API keys.
 *
 * @param {Object} classroom - Classroom object (with settings included)
 * @returns {Object} - Classroom with sanitized settings
 */
export const getClassroomForUI = <
  T extends {
    settings?: {
      anthropic_api_key?: string | null;
      openai_api_key?: string | null;
      [key: string]: unknown;
    } | null;
    [key: string]: unknown;
  } | null,
>(
  classroom: T
) => {
  if (!classroom) return null;

  const { settings, ...safeClassroom } = classroom;

  if (!settings) {
    return { ...safeClassroom, settings: null };
  }

  // Only include whitelisted fields in settings
  const safeSettings: Record<string, unknown> = {};
  for (const field of SAFE_SETTINGS_FIELDS) {
    if (settings[field] !== undefined) {
      safeSettings[field] = settings[field];
    }
  }

  // Add computed flags for UI
  safeSettings.has_anthropic_key = Boolean(settings.anthropic_api_key);
  safeSettings.has_openai_key = Boolean(settings.openai_api_key);

  return {
    ...safeClassroom,
    settings: safeSettings,
  };
};

/**
 * Get API key for server-side use only.
 * Call this from actions/loaders for LLM operations.
 * NEVER return this result to the client!
 *
 * @param {string} classroomId - Classroom UUID
 * @returns {Promise<string|null>} - API key or null if not set
 */
export const getClassroomApiKey = async (classroomId: string) => {
  const settings = await getPrisma().classroomSettings.findUnique({
    where: { classroom_id: classroomId },
    select: { anthropic_api_key: true, openai_api_key: true },
  });
  return settings?.anthropic_api_key || settings?.openai_api_key || null;
};

/**
 * Get full Classroom settings for server-side operations.
 * Use this when you need access to API keys for LLM calls.
 * NEVER return this result to the client!
 *
 * @param {string} classroomId - Classroom UUID
 * @returns {Promise<Object|null>} - Full settings object including secrets
 */
export const getClassroomSettingsForServer = async (classroomId: string) => {
  return getPrisma().classroomSettings.findUnique({
    where: { classroom_id: classroomId },
  });
};

/**
 * Update Classroom settings
 * @param {string} classroomId - Classroom UUID
 * @param {Object} updates - Settings to update
 * @returns {Promise<Object>}
 */
export const updateSettings = async (
  classroomId: string,
  updates: Prisma.ClassroomSettingsUncheckedCreateWithoutClassroomInput
) => {
  return getPrisma().classroomSettings.upsert({
    where: { classroom_id: classroomId },
    create: {
      classroom_id: classroomId,
      ...updates,
    },
    update: updates,
  });
};
