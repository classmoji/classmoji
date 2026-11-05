/**
 * Sync one published repository (an assignment container) with its class.
 *
 * Two things a repository can be missing after it was published:
 *   - student or team repos: students who joined (and accepted) since, teams
 *     tagged or formed since. These are created through `create_git_repos`.
 *   - assignments: a released assignment (published, or a draft whose
 *     `release_at` has passed) that an existing repo has no submission row for.
 *     Each is queued as one `gh-create_git_repo_assignment` run (an issue in
 *     ISSUE mode, the submission row alone in REPO mode), and every released
 *     assignment is then marked published.
 *
 * Who counts, by repository kind:
 *   - INDIVIDUAL: students of the classroom with an accepted invite and a git
 *     username on the classroom's provider (a Gitlab classroom's student with
 *     no Gitlab account connected yet cannot have a project).
 *   - GROUP, self-formed: teams carrying the tag named after the repository's
 *     slug; none until the first team forms.
 *   - GROUP, instructor-assigned: teams carrying the repository's tag.
 *
 * Every surface that syncs calls this: the Sync button (admin.$class.repos
 * `syncAssignment`) and MCP `repo_sync`.
 *
 * Scope comes from `classroomId`, the classroom the caller was authorized for:
 * the repository is loaded through it, so an id from another classroom throws
 * `RepositorySyncNotFoundError` before anything is queued. A failure before
 * anything was queued is thrown as it comes and leaves nothing written. A
 * failure after something was queued (repo creation queued, then the
 * assignment runs fail; or the runs queued, then marking them published fails)
 * is thrown as `RepositorySyncPartialError`, carrying the counts queued so far
 * so the caller can audit them; a second sync adds only what is still missing.
 *
 * Not a task: Trigger discovers tasks only under `src/workflows`. The webapp and
 * the MCP server import it through the `@classmoji/tasks/repo-sync` subpath.
 */

import { nanoid } from 'nanoid';
import { ClassmojiService } from '@classmoji/services';
import { releasedToRepos } from '@classmoji/utils';
import { createRepositoriesTask } from '../workflows/gitRepo.ts';
import {
  createGithubRepositoryAssignmentTask,
  type CreateGithubRepositoryAssignmentTaskPayload,
} from '../workflows/gitRepoAssignment.ts';

/** The repository is not in the classroom (or does not exist). */
export class RepositorySyncNotFoundError extends Error {
  constructor() {
    super('Repository not found in classroom');
    this.name = 'RepositorySyncNotFoundError';
  }
}

/**
 * A trigger failed after part of the sync was queued. The counts say what was
 * queued before it (the same fields as a successful result); `cause` is the
 * original failure.
 */
export class RepositorySyncPartialError extends Error {
  readonly sessionId: string;
  readonly reposToCreate: number;
  readonly assignmentsToAdd: number;

  constructor(queued: SyncRepositoryResult, cause: unknown) {
    super('Repository sync was only partly queued', { cause });
    this.name = 'RepositorySyncPartialError';
    this.sessionId = queued.sessionId;
    this.reposToCreate = queued.reposToCreate;
    this.assignmentsToAdd = queued.assignmentsToAdd;
  }
}

export interface SyncRepositoryResult {
  /** Tags every queued run `session_<id>` so a progress view can follow them. */
  sessionId: string;
  /** Student or team repos queued for creation. */
  reposToCreate: number;
  /** Assignment runs queued, one per (existing repo, missing assignment). */
  assignmentsToAdd: number;
}

type Repository = NonNullable<
  Awaited<ReturnType<typeof ClassmojiService.repository.findByIdInClassroom>>
>;
type Classroom = NonNullable<Awaited<ReturnType<typeof ClassmojiService.classroom.findById>>>;
type GitRepo = Awaited<ReturnType<typeof ClassmojiService.gitRepo.findByRepository>>[number];

type BatchItems = Parameters<typeof createGithubRepositoryAssignmentTask.batchTrigger>[0];
type BatchOptions = Parameters<typeof createGithubRepositoryAssignmentTask.batchTrigger>[1];

/**
 * The logins (student git usernames or team slugs) that have no repo yet, or
 * null when nobody can have one yet (a self-formed repository before any team).
 */
const missingOwners = async (
  classroom: Classroom,
  repository: Repository,
  existingRepos: GitRepo[]
): Promise<string[] | null> => {
  if (repository.type === 'INDIVIDUAL') {
    const students = await ClassmojiService.classroomMembership.findUsersByRole(
      classroom.id,
      'STUDENT'
    );
    return students
      .filter(
        student =>
          student.has_accepted_invite && !existingRepos.some(repo => repo.student_id === student.id)
      )
      .map(student => student.login || '')
      .filter(login => login !== '');
  }

  let teams: { id: string; slug: string }[];
  if (repository.team_formation_mode === 'SELF_FORMED') {
    // Self-formed teams carry the tag named after the repository's slug.
    const tag = await ClassmojiService.organizationTag.findByClassroomIdAndName(
      classroom.id,
      repository.slug!
    );
    if (!tag) return null;
    teams = await ClassmojiService.team.findByTagId(classroom.id, tag.id);
  } else {
    teams = await ClassmojiService.organizationTag.findTeamsByTag(repository.tag_id!);
  }

  return teams
    .filter(team => !existingRepos.some(repo => repo.team_id === team.id))
    .map(team => team.slug);
};

export const syncRepository = async ({
  classroomId,
  repositoryId,
  sessionId = nanoid(),
}: {
  classroomId: string;
  repositoryId: string;
  sessionId?: string;
}): Promise<SyncRepositoryResult> => {
  const repository = await ClassmojiService.repository.findByIdInClassroom(
    repositoryId,
    classroomId
  );
  if (!repository) throw new RepositorySyncNotFoundError();
  const classroom = await ClassmojiService.classroom.findById(classroomId);
  if (!classroom) throw new RepositorySyncNotFoundError();

  const existingRepos = await ClassmojiService.gitRepo.findByRepository(
    classroom.slug,
    repository.id
  );

  // 1. Repos nobody has yet.
  const logins = await missingOwners(classroom, repository, existingRepos);
  // A self-formed repository before its first team has nothing to sync: no
  // team can own a repo yet, and no repo exists to open an assignment in.
  if (logins === null) return { sessionId, reposToCreate: 0, assignmentsToAdd: 0 };
  if (logins.length > 0) {
    // Nothing is queued yet, so a failure here is thrown as it comes.
    await createRepositoriesTask.trigger(
      {
        logins,
        assignmentTitle: repository.title,
        org: classroom.slug,
        sessionId,
      },
      { concurrencyKey: classroom.slug }
    );
  }

  // 2. Released assignments the existing repos lack. The payload carries the
  // repository's own assignment row, the shape these runs have always taken.
  const releasedAssignments = repository.assignments.filter(assignment =>
    releasedToRepos(assignment, new Date())
  );
  const items = releasedAssignments.flatMap(assignment =>
    existingRepos
      .filter(repo => !repo.assignments?.some(row => row.assignment_id === assignment.id))
      .map(repo => ({
        payload: {
          repoName: repo.name,
          assignment,
          organization: classroom.git_organization,
          studentRepo: repo,
        } as unknown as CreateGithubRepositoryAssignmentTaskPayload,
        // `standalone`: this run is one repo's whole job here, not a step of a
        // repo being created, so the progress callout counts it as a unit.
        options: { tags: [`session_${sessionId}`, 'standalone'] },
      }))
  );

  // From here a failure leaves earlier steps queued: report what was.
  let queued: SyncRepositoryResult = {
    sessionId,
    reposToCreate: logins.length,
    assignmentsToAdd: 0,
  };
  const partly = (error: unknown) =>
    queued.reposToCreate + queued.assignmentsToAdd > 0
      ? new RepositorySyncPartialError(queued, error)
      : error;

  if (items.length > 0) {
    try {
      await createGithubRepositoryAssignmentTask.batchTrigger(
        items as unknown as BatchItems,
        { concurrencyKey: classroom.slug } as BatchOptions
      );
    } catch (error) {
      throw partly(error);
    }
    queued = { ...queued, assignmentsToAdd: items.length };

    // An assignment out on student repos is published (a draft whose release
    // date has passed is released by this).
    try {
      await Promise.all(
        releasedAssignments.map(assignment =>
          ClassmojiService.assignment.update(assignment.id, { is_published: true })
        )
      );
    } catch (error) {
      throw partly(error);
    }
  }

  return queued;
};
