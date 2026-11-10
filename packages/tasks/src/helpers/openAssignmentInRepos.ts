/**
 * Put one REPO assignment into the student repos that already exist.
 *
 * Publishing a REPO assignment whose repository is already published cuts no
 * repos, so nothing chains into opening the assignment there: only the first
 * assignment on a repository arrives with its repos. This queues, for every
 * existing repo of the assignment's repository that has no submission row for
 * it yet, the same `gh-create_git_repo_assignment` run Sync queues (an issue in
 * ISSUE mode, the submission row alone in REPO mode), then marks the
 * assignment published, as Sync does.
 *
 * Every publishing surface calls this one function: the module card's Publish
 * (admin.$class.repos `publishAssignmentAndRepository`), the assignment edit
 * form (admin.$class.assignments create/update) and MCP assignment_create /
 * assignment_update, and the hourly release for an assignment published ahead
 * of its date. It never publishes the repository (that is repo_publish / the
 * repos page). It creates student repos in one case only: the repository has
 * none at all, because they were waiting for its first release
 * (`studentReposDue`) and this assignment is that release. Then it hands over
 * to Sync, which makes the repos with the assignment in them. A repository
 * that has repos keeps the old rule: a student still without one is Sync's.
 *
 * Scope comes from `classroomId`, the classroom the caller was authorized for:
 * the assignment is loaded through its module's classroom and the repository
 * through its own, so an id from another classroom queues nothing.
 *
 * Not a task: Trigger discovers tasks only under `src/workflows` (trigger.config
 * `dirs`), and this is called from the webapp and the MCP server, which import
 * it through the `@classmoji/tasks/assignment-release` subpath.
 */

import { nanoid } from 'nanoid';
import { ClassmojiService } from '@classmoji/services';
import { releasedToRepos } from '@classmoji/utils';
import { syncRepository } from './syncRepository.ts';
import {
  createGithubRepositoryAssignmentTask,
  type CreateGithubRepositoryAssignmentTaskPayload,
} from '../workflows/gitRepoAssignment.ts';

/** Why nothing was queued. */
export type OpenAssignmentSkipReason =
  /** Not a REPO assignment of this classroom with a repository. */
  | 'not_repo'
  /** Its repository is a draft: no student repo exists to put it in. */
  | 'repo_unpublished'
  /** A future `release_at`, or an undated draft: it opens later. */
  | 'not_released'
  /** Every existing repo already has it (or none exist yet). */
  | 'none_missing';

export interface OpenAssignmentResult {
  /**
   * Runs queued, one per student or team repo; or, where the repository had
   * no repos yet, the repos queued for creation (each arrives with the
   * assignment).
   */
  queued: number;
  sessionId: string;
  reason?: OpenAssignmentSkipReason;
}

type BatchItems = Parameters<typeof createGithubRepositoryAssignmentTask.batchTrigger>[0];
type BatchOptions = Parameters<typeof createGithubRepositoryAssignmentTask.batchTrigger>[1];

/**
 * Queue the assignment into every existing repo that lacks it. A trigger
 * failure is thrown, after nothing was written; the caller decides how to
 * report it.
 */
export const openAssignmentInExistingRepos = async ({
  classroomId,
  assignmentId,
  sessionId = nanoid(),
  now = new Date(),
}: {
  classroomId: string;
  assignmentId: string;
  /** Tags the runs `session_<id>` so a progress view can follow them. */
  sessionId?: string;
  /**
   * The release clock: an assignment counts as released once its
   * `release_at` is at or before this. The hourly release passes the clock
   * its queries ran on, so one run reads one time; every other caller keeps
   * the default.
   */
  now?: Date;
}): Promise<OpenAssignmentResult> => {
  const skip = (reason: OpenAssignmentSkipReason): OpenAssignmentResult => ({
    queued: 0,
    sessionId,
    reason,
  });

  const found = await ClassmojiService.assignment.findByIdInClassroom(assignmentId, classroomId);
  if (!found || found.type !== 'REPO' || !found.repository_id) return skip('not_repo');

  const repository = await ClassmojiService.repository.findByIdInClassroom(
    found.repository_id,
    classroomId
  );
  if (!repository) return skip('not_repo');
  if (!repository.is_published) return skip('repo_unpublished');

  // The repository's own row for the assignment: the shape Sync has always put
  // in the run's payload (no includes).
  const assignment = repository.assignments.find(a => a.id === assignmentId);
  if (!assignment) return skip('not_repo');
  if (!releasedToRepos(assignment, now)) return skip('not_released');

  const classroom = await ClassmojiService.classroom.findById(classroomId);
  if (!classroom) return skip('not_repo');

  const repos = await ClassmojiService.gitRepo.findByRepository(classroom.slug, repository.id);
  // No repo at all: they were waiting for this, the repository's first
  // release. Sync makes them, each with its released assignments, and marks
  // those published; a repository nobody can own a repo of yet (a self-formed
  // one before its first team) queues nothing.
  if (repos.length === 0) {
    const synced = await syncRepository({ classroomId, repositoryId: repository.id, sessionId });
    if (synced.reposToCreate === 0) return skip('none_missing');
    await ClassmojiService.assignment.update(assignmentId, { is_published: true });
    return { queued: synced.reposToCreate, sessionId };
  }
  const missing = repos.filter(
    repo => !repo.assignments?.some(row => row.assignment_id === assignmentId)
  );
  if (missing.length === 0) return skip('none_missing');

  const items = missing.map(repo => ({
    payload: {
      repoName: repo.name,
      assignment,
      organization: classroom.git_organization,
      studentRepo: repo,
    } as unknown as CreateGithubRepositoryAssignmentTaskPayload,
    // `standalone`: this run is one repo's whole job here, not a step of a
    // repo being created, so the progress callout counts it as a unit.
    options: { tags: [`session_${sessionId}`, 'standalone'] },
  }));

  await createGithubRepositoryAssignmentTask.batchTrigger(
    items as unknown as BatchItems,
    { concurrencyKey: classroom.slug } as BatchOptions
  );

  // As Sync does: an assignment out on student repos is published (a draft
  // whose release date has passed is released by this).
  await ClassmojiService.assignment.update(assignmentId, { is_published: true });

  return { queued: items.length, sessionId };
};
