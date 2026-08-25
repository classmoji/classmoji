/**
 * Team administration service.
 *
 * Create / delete / rename a classroom team, manage its members and its tags.
 * Shared by the web admin.$class.teams* actions and (later) the MCP team tools
 * so both take one code path — same precedent as roster.service.ts and
 * assistant.service.ts.
 *
 * Two rules run through every function here:
 *
 * 1. RESOLVE FIRST. The team is always looked up by (classroom_id, slug|id)
 *    before anything is sent to the git provider. The routes used to hand a
 *    client-supplied slug/teamId straight to GitHub — so an unknown team was
 *    deleted on GitHub before the local delete failed, and a tag could be
 *    attached to a team in another classroom. Resolving first scopes every
 *    mutation to the classroom the caller was authorized for, and it means the
 *    classroom's own `-students` / `-assistants` GitHub teams (which have no
 *    local Team row) can never be reached from here.
 *
 * 2. PARTIAL WORK IS REPORTED, NOT SWALLOWED. Bulk operations (members, tags,
 *    the repo-rename cascade) collect per-item successes and failures and hand
 *    both back; callers must surface `failed`.
 *
 * Authorization is NOT re-checked here. Callers (route auth gates / MCP tool
 * scopes) own that, exactly as in roster.service.ts and assistant.service.ts.
 */
import { queue } from 'async';

import getPrisma from '@classmoji/database';
import type { GitProvider as GitProviderEnum } from '@prisma/client';

import { getGitProvider } from '../git/index.ts';
import { sleep } from './sleep.ts';
import * as classroomService from './classroom.service.ts';
import * as teamService from './team.service.ts';
import * as teamMembershipService from './teamMembership.service.ts';
import * as teamTagService from './teamTag.service.ts';

/** Throttle between provider calls in the sequential queues (ms). */
const PROVIDER_THROTTLE_MS = 250;

/** Thrown for every caller-fixable failure so routes/tools can map it to a message. */
export class TeamServiceError extends Error {
  code:
    | 'classroom_not_found'
    | 'no_org_configured'
    | 'provider_unsupported'
    | 'team_not_found'
    | 'invalid_name'
    | 'reserved_name'
    | 'name_collision'
    | 'tag_not_found'
    | 'user_not_found';

  constructor(code: TeamServiceError['code'], message: string) {
    super(message);
    this.name = 'TeamServiceError';
    this.code = code;
  }
}

export interface TeamSummary {
  id: string;
  name: string;
  slug: string;
  isVisible: boolean;
}

/**
 * Closed vocabulary for per-item failures in the bulk operations.
 *
 * The raw provider/database message is logged server-side and never handed
 * back: it carries organization internals, octokit request details and Prisma
 * query text, none of which a caller needs (or should read) to understand that
 * one item of a batch did not go through.
 */
export type TeamFailureReason = 'provider_error' | 'not_found' | 'db_error' | 'invalid';

export interface TagFailure {
  tagId: string;
  error: TeamFailureReason;
}

export interface MemberFailure {
  login: string;
  error: TeamFailureReason;
}

export interface RepoRenameFailure {
  name: string;
  error: TeamFailureReason;
}

export interface CreateTeamResult {
  team: TeamSummary;
  /** Tag ids now attached to the team (includes tags that were already attached). */
  tagsAdded: string[];
  tagsFailed: TagFailure[];
}

export interface DeleteTeamResult {
  id: string;
  name: string;
  slug: string;
  /** false when the team was already gone on the provider side (404 tolerated). */
  removedFromProvider: boolean;
  /** How many linked repository records went with the team. */
  reposDeleted: number;
  /** Names of those repositories, capped at MAX_REPORTED_REPO_NAMES. */
  deletedRepoNames: string[];
}

export interface RenameTeamResult {
  teamId: string;
  newName: string;
  newSlug: string;
  /** New names of the repositories that were successfully renamed. */
  renamedRepos: string[];
  failed: RepoRenameFailure[];
}

export interface AddTeamMembersResult {
  succeeded: { login: string }[];
  failed: MemberFailure[];
}

export interface RemoveTeamMemberResult {
  teamId: string;
  login: string;
  /** false when no membership row existed (the removal is idempotent). */
  removed: boolean;
}

export interface AddTeamTagsResult {
  added: string[];
  failed: TagFailure[];
}

export interface RemoveTeamTagResult {
  teamTagId: string;
  teamId: string;
  tagId: string;
}

/** A git provider 404 — the resource genuinely is not there. */
const isProviderNotFound = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 404;

/** A Prisma unique-constraint violation (e.g. the tag is already on the team). */
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';

/**
 * Classify a thrown error into the closed failure vocabulary and log the raw
 * one with context, so the detail stays in the server logs rather than in a
 * response body. Octokit errors carry a numeric `.status`; Prisma errors carry
 * a string `.code`; anything else falls back to the caller's default.
 */
const failureReason = (
  context: string,
  error: unknown,
  fallback: TeamFailureReason
): TeamFailureReason => {
  console.error(`[team] ${context}`, error);
  if (typeof error === 'object' && error !== null) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') return status === 404 ? 'not_found' : 'provider_error';
    if (typeof (error as { code?: unknown }).code === 'string') return 'db_error';
  }
  return fallback;
};

const FAILURE_PHRASES: Record<TeamFailureReason, string> = {
  provider_error: 'the git provider rejected the change',
  not_found: 'not found',
  db_error: 'the change could not be saved',
  invalid: 'not valid for this classroom',
};

/**
 * Turn a failure reason into a short phrase for a UI or tool response. Callers
 * render the reason at their own boundary, so the vocabulary stays closed here
 * and the wording stays in one place.
 */
export const describeTeamFailureReason = (reason: TeamFailureReason): string =>
  FAILURE_PHRASES[reason] ?? 'the change could not be completed';

/**
 * The slug GitHub will derive from a team name: lowercased, whitespace runs
 * collapsed to single hyphens. GitHub remains authoritative — it also strips
 * and folds punctuation, which this prediction deliberately does not model.
 * The prediction exists so collisions and reserved names can be caught BEFORE
 * a provider write; every check it feeds is repeated against the slug the
 * provider actually returns.
 */
export const predictTeamSlug = (name: string): string =>
  name.trim().toLowerCase().replace(/\s+/g, '-');

/**
 * Classroom teams are named `{classroom-slug}-students` / `-assistants` (see
 * getTeamNameForClassroom). A user-created team must never land on one of those
 * slugs, or managing it would manage the classroom's own membership team.
 *
 * Exported because the student self-service team form creates teams on its own
 * path and has to apply the same rule.
 */
export const isReservedSlug = (slug: string): boolean =>
  slug.endsWith('-students') || slug.endsWith('-assistants');

/** How many repository names a delete result lists before it stops. */
const MAX_REPORTED_REPO_NAMES = 20;

/**
 * Undo a provider team that failed the authoritative-slug checks.
 *
 * Best effort: the refusal is reported either way, and a cleanup that itself
 * fails is logged so the stray provider team can be removed by hand.
 */
const rollbackProviderTeam = async (
  gitProvider: { deleteTeam: (org: string, slug: string) => Promise<unknown> },
  orgLogin: string,
  slug: string
): Promise<void> => {
  try {
    await gitProvider.deleteTeam(orgLogin, slug);
  } catch (error: unknown) {
    console.error(`[team] could not roll back provider team ${orgLogin}/${slug}`, error);
  }
};

const requireName = (name: string | null | undefined): string => {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) {
    throw new TeamServiceError('invalid_name', '[team] a team name is required');
  }
  return trimmed;
};

/**
 * Load the classroom and narrow its git organization in one step, so callers
 * get a non-null `orgLogin` instead of asserting one at every provider call.
 */
const loadClassroomOrg = async (classroomId: string) => {
  const classroom = await classroomService.findById(classroomId);
  if (!classroom) {
    throw new TeamServiceError('classroom_not_found', `[team] classroom ${classroomId} not found`);
  }
  const gitOrganization = classroom.git_organization;
  if (!gitOrganization?.login) {
    throw new TeamServiceError(
      'no_org_configured',
      `[team] classroom ${classroomId} has no git organization`
    );
  }
  return { classroom, gitOrganization, orgLogin: gitOrganization.login };
};

/**
 * Resolve a team by slug OR id, ALWAYS scoped to the classroom. Every mutation
 * starts here, which is what keeps a caller from naming a team in a classroom
 * they were not authorized for (or a classroom team with no local row).
 */
const resolveTeam = async (classroomId: string, slugOrId: string) => {
  const team = await getPrisma().team.findFirst({
    where: {
      classroom_id: classroomId,
      OR: [{ slug: slugOrId }, { id: slugOrId }],
    },
  });
  if (!team) {
    throw new TeamServiceError(
      'team_not_found',
      `[team] no team "${slugOrId}" in classroom ${classroomId}`
    );
  }
  return team;
};

/**
 * Split the requested tag ids into ones that really are Tags of this classroom
 * and ones that are not. Tag is classroom-scoped, so an id from another
 * classroom is reported as a failure rather than silently attached.
 */
const partitionClassroomTags = async (classroomId: string, tagIds: string[]) => {
  const unique = [...new Set(tagIds)];
  if (unique.length === 0) return { valid: [] as string[], failed: [] as TagFailure[] };

  const tags = await getPrisma().tag.findMany({
    where: { id: { in: unique }, classroom_id: classroomId },
    select: { id: true },
  });
  const found = new Set(tags.map((t: { id: string }) => t.id));

  return {
    valid: unique.filter(id => found.has(id)),
    failed: unique
      .filter(id => !found.has(id))
      .map(id => ({ tagId: id, error: 'invalid' as const })),
  };
};

/**
 * Attach tags one at a time so a single bad id cannot abort the rest (the
 * routes used to Promise.all these and lose every result on the first reject).
 * A unique-constraint violation means the tag is already on the team — that is
 * the desired end state, so it counts as added.
 */
const attachTags = async (teamId: string, tagIds: string[]) => {
  const added: string[] = [];
  const failed: TagFailure[] = [];

  for (const tagId of tagIds) {
    try {
      await teamTagService.create(teamId, tagId);
      added.push(tagId);
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        added.push(tagId);
        continue;
      }
      failed.push({
        tagId,
        error: failureReason(`attach tag ${tagId} to team ${teamId}`, error, 'db_error'),
      });
    }
  }

  return { added, failed };
};

const toSummary = (team: { id: string; name: string; slug: string; is_visible: boolean }) => ({
  id: team.id,
  name: team.name,
  slug: team.slug,
  isVisible: team.is_visible,
});

/**
 * Create a team on the git provider and mirror it locally.
 *
 * Order matters: the name is validated and the predicted slug is checked
 * against the reserved classroom-team suffixes and against the provider BEFORE
 * anything is created, so a rejected request usually never reaches the
 * provider at all. Tag ids are resolved in the same pre-flight pass.
 *
 * The prediction is not the last word, though — the provider derives the real
 * slug and folds punctuation the prediction leaves alone, so both checks run
 * again on the slug it returns. If the real slug fails one of them the
 * provider team is deleted again and the call is refused, so no local row is
 * ever created on a slug that the pre-flight checks would have rejected.
 *
 * `isVisible` maps to Team.is_visible, which decides whether students who are
 * not members can see the team. It defaults to false (the schema default, and
 * what the "Secret" option in the web form has always meant — the form's choice
 * previously had no effect and every team was stored visible).
 *
 * Tags are attached individually and reported per tag: creating the team
 * succeeds even if some tags could not be attached.
 */
export const createTeam = async ({
  classroomId,
  name,
  isVisible = false,
  tagIds = [],
}: {
  classroomId: string;
  name: string;
  isVisible?: boolean;
  tagIds?: string[];
}): Promise<CreateTeamResult> => {
  const trimmedName = requireName(name);
  const { gitOrganization, orgLogin } = await loadClassroomOrg(classroomId);

  const predictedSlug = predictTeamSlug(trimmedName);
  if (isReservedSlug(predictedSlug)) {
    throw new TeamServiceError(
      'reserved_name',
      `[team] "${trimmedName}" is reserved for classroom teams`
    );
  }

  const { valid: validTagIds, failed: tagsFailed } = await partitionClassroomTags(
    classroomId,
    tagIds
  );

  const gitProvider = getGitProvider(gitOrganization);

  // A team already sitting on the predicted slug would be silently adopted by
  // the create call, so refuse. Only a 404 means the slug is free — a rate
  // limit or a bad token must surface as itself, not as "name taken".
  try {
    await gitProvider.getTeam(orgLogin, predictedSlug);
    throw new TeamServiceError(
      'name_collision',
      `[team] a team named "${trimmedName}" already exists in ${orgLogin}`
    );
  } catch (error: unknown) {
    if (error instanceof TeamServiceError) throw error;
    if (!isProviderNotFound(error)) throw error;
  }

  const providerTeam = await gitProvider.createTeam(orgLogin, trimmedName);

  // The provider is authoritative for the slug and derives it from more than
  // whitespace, so both pre-flight checks are repeated against the slug it
  // actually returned. A team that lands on a slug those checks refuse is
  // removed again before anything is stored locally.
  const authoritativeSlug = providerTeam.slug;
  if (isReservedSlug(authoritativeSlug)) {
    await rollbackProviderTeam(gitProvider, orgLogin, authoritativeSlug);
    throw new TeamServiceError(
      'reserved_name',
      `[team] "${trimmedName}" resolves to a reserved team slug`
    );
  }
  const localCollision = await teamService.findBySlugAndClassroomId(authoritativeSlug, classroomId);
  if (localCollision) {
    await rollbackProviderTeam(gitProvider, orgLogin, authoritativeSlug);
    throw new TeamServiceError(
      'name_collision',
      `[team] a team with slug "${authoritativeSlug}" already exists in this classroom`
    );
  }

  const team = await teamService.create({
    providerId: providerTeam.id,
    provider: gitOrganization.provider as GitProviderEnum,
    name: providerTeam.name,
    slug: providerTeam.slug,
    classroomId,
    isVisible,
  });

  const { added, failed } = await attachTags(team.id, validTagIds);

  return {
    team: toSummary(team),
    tagsAdded: added,
    tagsFailed: [...tagsFailed, ...failed],
  };
};

/**
 * Delete a team from the git provider and locally.
 *
 * The local row is resolved first: an unknown slug is rejected before anything
 * reaches the provider (the route used to delete the provider team on a
 * client-supplied slug and only then discover there was no local row to
 * delete). A provider 404 is tolerated — the team already being gone there is
 * the desired end state, and the local row still needs removing.
 *
 * The linked repository records go with the team (and take their submissions,
 * grades and analytics with them), so they are counted BEFORE the delete and
 * reported back: callers cannot describe what a delete cost afterwards.
 */
export const deleteTeam = async ({
  classroomId,
  slugOrId,
}: {
  classroomId: string;
  slugOrId: string;
}): Promise<DeleteTeamResult> => {
  const { gitOrganization, orgLogin } = await loadClassroomOrg(classroomId);
  const team = await resolveTeam(classroomId, slugOrId);
  const gitProvider = getGitProvider(gitOrganization);

  const teamWithRepos = await teamService.findByIdWithRepositories(team.id);
  const repositories = teamWithRepos?.git_repos ?? [];
  const deletedRepoNames = repositories
    .slice(0, MAX_REPORTED_REPO_NAMES)
    .map((repo: { name: string }) => repo.name);

  let removedFromProvider = true;
  try {
    await gitProvider.deleteTeam(orgLogin, team.slug);
  } catch (error: unknown) {
    if (!isProviderNotFound(error)) throw error;
    removedFromProvider = false;
  }

  await teamService.deleteBySlug(classroomId, team.slug);

  return {
    id: team.id,
    name: team.name,
    slug: team.slug,
    removedFromProvider,
    reposDeleted: repositories.length,
    deletedRepoNames,
  };
};

/**
 * Rename a team and cascade the new slug onto every linked repository.
 *
 * The local collision check runs against the PREDICTED slug before the provider
 * rename, so a name already taken in this classroom is refused while the
 * provider team is still untouched. GitHub derives the real slug, so the check
 * is repeated against the slug it returns.
 *
 * Repositories are renamed one at a time, throttled, and each failure is
 * isolated: only successful renames are persisted (in one transaction with the
 * team rename).
 *
 * IMPORTANT: a repository in `failed` CANNOT be recovered by running the rename
 * again. The team already carries the new slug, so the old `-{oldSlug}` suffix
 * no longer matches anything on a second pass — those repositories have to be
 * renamed by hand on the provider. Callers must surface `failed`.
 */
export const renameTeam = async ({
  classroomId,
  slugOrId,
  newName,
}: {
  classroomId: string;
  slugOrId: string;
  newName: string;
}): Promise<RenameTeamResult> => {
  const trimmedName = requireName(newName);
  const { gitOrganization, orgLogin } = await loadClassroomOrg(classroomId);

  if (gitOrganization.provider !== 'GITHUB') {
    throw new TeamServiceError(
      'provider_unsupported',
      '[team] renaming a team is only supported for GitHub organizations'
    );
  }

  const team = await resolveTeam(classroomId, slugOrId);

  const predictedSlug = predictTeamSlug(trimmedName);
  if (isReservedSlug(predictedSlug)) {
    throw new TeamServiceError(
      'reserved_name',
      `[team] "${trimmedName}" is reserved for classroom teams`
    );
  }

  // Pre-flight collision check against the predicted slug. The provider rename
  // has no rollback, so the local conflict has to be caught before it runs.
  await assertSlugFree({
    classroomId,
    slug: predictedSlug,
    teamId: team.id,
    currentSlug: team.slug,
  });

  const teamWithRepos = await teamService.findByIdWithRepositories(team.id);
  const repositories = teamWithRepos?.git_repos ?? [];

  const gitProvider = getGitProvider(gitOrganization);
  const updated = await gitProvider.updateTeam(orgLogin, team.slug, { name: trimmedName });
  const newSlug = updated.slug;

  // GitHub is authoritative for the slug and may not produce the predicted one
  // (it folds punctuation the prediction leaves alone), so BOTH pre-flight
  // checks are repeated here. This runs before the repository cascade and
  // before anything local is written, so a refusal leaves Classmoji untouched
  // — but the provider rename has already happened, so the previous name is
  // put back best-effort first.
  if (isReservedSlug(newSlug)) {
    try {
      await gitProvider.updateTeam(orgLogin, newSlug, { name: team.name });
    } catch (error: unknown) {
      console.error(`[team] could not restore the provider name for ${orgLogin}/${newSlug}`, error);
    }
    throw new TeamServiceError(
      'reserved_name',
      `[team] "${trimmedName}" resolves to a reserved team slug`
    );
  }
  await assertSlugFree({ classroomId, slug: newSlug, teamId: team.id, currentSlug: team.slug });

  const oldSuffix = `-${team.slug}`;
  const failed: RepoRenameFailure[] = [];
  const succeeded: { id: string; name: string }[] = [];

  const renameQueue = queue<(typeof repositories)[number]>(async repo => {
    if (!repo.name.includes(oldSuffix)) {
      return;
    }
    const newRepoName = repo.name.split(oldSuffix).join(`-${newSlug}`);
    try {
      await gitProvider.updateRepo(orgLogin, repo.name, { name: newRepoName });
      succeeded.push({ id: repo.id, name: newRepoName });
    } catch (error: unknown) {
      failed.push({
        name: repo.name,
        error: failureReason(`rename repo ${orgLogin}/${repo.name}`, error, 'provider_error'),
      });
    }
    await sleep(PROVIDER_THROTTLE_MS);
  }, 1);

  if (repositories.length > 0) {
    renameQueue.push(repositories);
    await renameQueue.drain();
  }

  await teamService.renameAndRepos({
    teamId: team.id,
    newName: updated.name,
    newSlug,
    repoRenames: succeeded,
  });

  return {
    teamId: team.id,
    newName: updated.name,
    newSlug,
    renamedRepos: succeeded.map(r => r.name),
    failed,
  };
};

const assertSlugFree = async ({
  classroomId,
  slug,
  teamId,
  currentSlug,
}: {
  classroomId: string;
  slug: string;
  teamId: string;
  currentSlug: string;
}) => {
  if (slug === currentSlug) return;
  const existing = await teamService.findBySlugAndClassroomId(slug, classroomId);
  if (existing && existing.id !== teamId) {
    throw new TeamServiceError(
      'name_collision',
      `[team] a team with slug "${slug}" already exists in this classroom`
    );
  }
};

/**
 * Add members to a team by login, sequentially and throttled.
 *
 * Every login is reported: an unknown user, a provider rejection or a failed
 * membership write lands in `failed` with its reason and the remaining logins
 * still run. The route used to let the whole queue die on the first bad login
 * and still report success. The local write is an upsert, so re-adding an
 * existing member is a no-op rather than an error.
 */
export const addTeamMembers = async ({
  classroomId,
  slugOrId,
  logins,
}: {
  classroomId: string;
  slugOrId: string;
  logins: string[];
}): Promise<AddTeamMembersResult> => {
  const { gitOrganization, orgLogin } = await loadClassroomOrg(classroomId);
  const team = await resolveTeam(classroomId, slugOrId);
  const gitProvider = getGitProvider(gitOrganization);

  const succeeded: { login: string }[] = [];
  const failed: MemberFailure[] = [];

  const membersQueue = queue<string>(async login => {
    try {
      const user = await findUserByLogin(login);
      if (!user) {
        failed.push({ login, error: 'not_found' });
        return;
      }
      const canonicalLogin = user.login ?? login;
      await gitProvider.addTeamMember(orgLogin, team.slug, canonicalLogin);
      await teamMembershipService.addMemberToTeam(team.id, user.id);
      succeeded.push({ login: canonicalLogin });
    } catch (error: unknown) {
      failed.push({
        login,
        error: failureReason(`add ${login} to team ${team.slug}`, error, 'provider_error'),
      });
    }
    await sleep(PROVIDER_THROTTLE_MS);
  }, 1);

  if (logins.length > 0) {
    membersQueue.push(logins);
    await membersQueue.drain();
  }

  return { succeeded, failed };
};

/**
 * Remove one member from a team.
 *
 * Both the team AND the user are resolved before the provider call — the route
 * used to fire the provider removal and only then blow up on a login that named
 * nobody. The local removal is a deleteMany, so a membership row that is already
 * gone is not an error.
 */
export const removeTeamMember = async ({
  classroomId,
  slugOrId,
  login,
}: {
  classroomId: string;
  slugOrId: string;
  login: string;
}): Promise<RemoveTeamMemberResult> => {
  const { gitOrganization, orgLogin } = await loadClassroomOrg(classroomId);
  const team = await resolveTeam(classroomId, slugOrId);

  const user = await findUserByLogin(login);
  if (!user) {
    throw new TeamServiceError('user_not_found', `[team] no user with login ${login}`);
  }
  const canonicalLogin = user.login ?? login;

  const gitProvider = getGitProvider(gitOrganization);
  await gitProvider.removeTeamMember(orgLogin, team.slug, canonicalLogin);

  const { count } = await teamMembershipService.removeMemberFromTeam(team.id, user.id);

  return { teamId: team.id, login: canonicalLogin, removed: count > 0 };
};

/**
 * Attach tags to a team.
 *
 * The team is resolved through the classroom (the route trusted a client-sent
 * teamId with no classroom check) and every tag id is checked against this
 * classroom's tags before anything is written. Results are per tag.
 */
export const addTeamTags = async ({
  classroomId,
  slugOrId,
  tagIds,
}: {
  classroomId: string;
  slugOrId: string;
  tagIds: string[];
}): Promise<AddTeamTagsResult> => {
  const team = await resolveTeam(classroomId, slugOrId);
  const { valid, failed: invalid } = await partitionClassroomTags(classroomId, tagIds);
  const { added, failed } = await attachTags(team.id, valid);

  return { added, failed: [...invalid, ...failed] };
};

/**
 * Detach a tag from a team.
 *
 * The TeamTag row is resolved THROUGH its team's classroom, so an id that
 * belongs to another classroom simply does not resolve (the plain delete it
 * replaces took any id at all).
 */
export const removeTeamTag = async ({
  classroomId,
  teamTagId,
}: {
  classroomId: string;
  teamTagId: string;
}): Promise<RemoveTeamTagResult> => {
  const teamTag = await getPrisma().teamTag.findFirst({
    where: { id: teamTagId, team: { classroom_id: classroomId } },
    select: { id: true, team_id: true, tag_id: true },
  });
  if (!teamTag) {
    throw new TeamServiceError(
      'tag_not_found',
      `[team] no team tag ${teamTagId} in classroom ${classroomId}`
    );
  }

  await teamTagService.delete(teamTag.id);

  return { teamTagId: teamTag.id, teamId: teamTag.team_id, tagId: teamTag.tag_id };
};

/**
 * Git logins are case-insensitive while Postgres is not, so match the stored
 * login insensitively — 'Ada' and 'ada' are the same person. Only id/login are
 * needed here, unlike user.service.findByLogin which pulls the whole graph.
 */
const findUserByLogin = async (login: string) =>
  getPrisma().user.findFirst({
    where: { login: { equals: login.replace('@', '').trim(), mode: 'insensitive' } },
    select: { id: true, login: true },
  });
