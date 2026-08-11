import getPrisma from '@classmoji/database';
import { classroomContentRepoName } from '@classmoji/utils';
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
 * @param {string} data.content_namespace - Identifier embedded in content repo name
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
 * Pure helper: enumerate the GitHub artifacts a classroom owns, from DB-known
 * facts ONLY — the content repo (derived from org login + content namespace),
 * the two conventional classroom teams ({slug}-students / {slug}-assistants),
 * any provider-backed project-team slugs, and the classroom's git repos by
 * exact recorded name. Nothing is pattern-matched or discovered live: if the
 * DB doesn't name it, it is not in the plan.
 */
export function classroomGitHubArtifactPlan({
  orgLogin,
  slug,
  contentNamespace,
  gitRepoNames,
  teamSlugs,
}: {
  orgLogin: string;
  slug: string;
  contentNamespace: string | null;
  gitRepoNames: string[];
  teamSlugs: string[];
}): GitHubArtifact[] {
  const plan: GitHubArtifact[] = [];
  if (contentNamespace) {
    plan.push({
      kind: 'repo',
      org: orgLogin,
      name: classroomContentRepoName({ login: orgLogin, namespace: contentNamespace }),
      label: 'content repo',
    });
  }
  for (const name of [...new Set(gitRepoNames)]) {
    plan.push({ kind: 'repo', org: orgLogin, name, label: 'assignment repo' });
  }
  for (const suffix of ['students', 'assistants']) {
    plan.push({ kind: 'team', org: orgLogin, name: `${slug}-${suffix}`, label: 'classroom team' });
  }
  for (const teamSlug of [...new Set(teamSlugs)]) {
    plan.push({ kind: 'team', org: orgLogin, name: teamSlug, label: 'project team' });
  }
  return plan;
}

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
 * The content repo is held back (and recorded as a failure) when another
 * classroom in the same org shares this classroom's content namespace — they
 * resolve to the SAME repo, so deleting it would take out live content.
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

  const classroom = await getPrisma().classroom.findUnique({
    where: { id: classroomId },
    include: {
      git_organization: true,
      git_repos: { select: { name: true } },
      teams: {
        where: { provider: 'GITHUB', provider_id: { not: null } },
        select: { slug: true },
      },
    },
  });
  if (!classroom?.git_organization?.login) {
    return { deleted_repos: 0, deleted_teams: 0, skipped: 0, failures: ['no git organization'] };
  }
  if (classroom.git_organization.provider !== 'GITHUB') {
    return {
      deleted_repos: 0,
      deleted_teams: 0,
      skipped: 0,
      failures: ['provider not supported for cleanup — artifacts left in place'],
    };
  }

  let plan = classroomGitHubArtifactPlan({
    orgLogin: classroom.git_organization.login,
    slug: classroom.slug,
    contentNamespace: classroom.content_namespace,
    gitRepoNames: classroom.git_repos.map(r => r.name),
    teamSlugs: classroom.teams.map(t => t.slug),
  });

  // User-to-server octokit: GitHub checks the HUMAN's authority per call.
  const octokit = GitHubProvider.getUserOctokit(userToken);
  const summary: GitHubCleanupSummary = {
    deleted_repos: 0,
    deleted_teams: 0,
    skipped: 0,
    failures: [],
  };

  // The content repo name is derived from [org login, content namespace], so a
  // sibling classroom sharing that pair OWNS THE SAME REPO — deleting it would
  // destroy live content of a classroom nobody asked to remove. A DB unique
  // constraint on [git_org_id, content_namespace] now prevents new collisions;
  // this guard covers rows that predate it. Teams and assignment repos are
  // per-classroom and never shared, so only the content repo is held back.
  if (classroom.content_namespace) {
    const sharer = await getPrisma().classroom.findFirst({
      where: {
        git_org_id: classroom.git_org_id,
        content_namespace: classroom.content_namespace,
        id: { not: classroom.id },
      },
      select: { slug: true },
    });
    if (sharer) {
      const contentRepo = plan.find(a => a.label === 'content repo');
      plan = plan.filter(a => a.label !== 'content repo');
      if (contentRepo) {
        summary.failures.push(
          `content repo ${contentRepo.name}: shared with classroom '${sharer.slug}' — not deleted`
        );
      }
    }
  }

  for (const artifact of plan) {
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
