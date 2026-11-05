/**
 * The repositories page's actions each write one audit row (CLAUDE.md rule 2):
 * publish, unpublish, sync and delete on a repository, and publishing one
 * assignment from the module card. Rows are bound to the classroom the caller
 * was authorized for, never the body, and a refused publish writes none. A
 * sync is never deduplicated, and one that fails after queuing part of its
 * work still writes a `partial` row with what was queued.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomAdmin: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  repositoryFindByIdInClassroom: vi.fn(),
  repositoryDeleteById: vi.fn(),
  repositorySetPublished: vi.fn(),
  publishAssignment: vi.fn(),
  publishAssignmentAndRepository: vi.fn(),
  syncAssignment: vi.fn(),
  addClassroomAuditLog: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomAdmin: (...a: unknown[]) => mocks.requireClassroomAdmin(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
}));

vi.mock('~/utils/gitlabGuard.server', () => ({ isGitLabClassroom: () => false }));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    repository: {
      findByIdInClassroom: (...a: unknown[]) => mocks.repositoryFindByIdInClassroom(...a),
      deleteById: (...a: unknown[]) => mocks.repositoryDeleteById(...a),
      setPublished: (...a: unknown[]) => mocks.repositorySetPublished(...a),
    },
  },
}));

vi.mock('../helpers', () => ({
  publishAssignment: (...a: unknown[]) => mocks.publishAssignment(...a),
  publishAssignmentAndRepository: (...a: unknown[]) => mocks.publishAssignmentAndRepository(...a),
  syncAssignment: (...a: unknown[]) => mocks.syncAssignment(...a),
}));

vi.mock('@classmoji/tasks/repo-sync', () => ({
  RepositorySyncNotFoundError: class RepositorySyncNotFoundError extends Error {},
  RepositorySyncPartialError: class RepositorySyncPartialError extends Error {
    readonly sessionId: string;
    readonly reposToCreate: number;
    readonly assignmentsToAdd: number;
    constructor(queued: { sessionId: string; reposToCreate: number; assignmentsToAdd: number }) {
      super('partly queued');
      this.sessionId = queued.sessionId;
      this.reposToCreate = queued.reposToCreate;
      this.assignmentsToAdd = queued.assignmentsToAdd;
    }
  },
}));

vi.mock('../contributions', () => ({ calculateContributions: vi.fn() }));

vi.mock('~/utils/helpers', () => ({
  addClassroomAuditLog: (...a: unknown[]) => mocks.addClassroomAuditLog(...a),
}));

const { action } = await import('../action.ts');
const { RepositorySyncNotFoundError, RepositorySyncPartialError } =
  await import('@classmoji/tasks/repo-sync');

const run = (name: string, body: Record<string, unknown>) =>
  (action as unknown as (args: { params: object; request: Request }) => Promise<unknown>)({
    params: { class: 'cs-1' },
    request: new Request(`http://localhost/admin/cs-1/repos?/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });

const row = () => mocks.addClassroomAuditLog.mock.calls[0]?.[0];

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.requireClassroomAdmin.mockResolvedValue({
    userId: 'owner-1',
    classroom: { id: 'class-1', slug: 'cs-1', status: 'ACTIVE' },
    membership: { role: 'OWNER' },
  });
  mocks.repositoryFindByIdInClassroom.mockResolvedValue({ id: 'repo-1', title: 'lab-1' });
});

describe('repositories page audit rows', () => {
  it('publish: one row with the repos it provisions, in the authorized classroom', async () => {
    mocks.publishAssignment.mockResolvedValue({
      triggerSession: { accessToken: 't', id: 's', numReposToCreate: 50, numIssuesToCreate: 0 },
    });

    await run('publish', { assignment_id: 'repo-1', classroom_id: 'class-other' });

    expect(mocks.addClassroomAuditLog).toHaveBeenCalledTimes(1);
    expect(row()).toMatchObject({
      classroomId: 'class-1',
      userId: 'owner-1',
      role: 'OWNER',
      action: 'UPDATE',
      resourceType: 'REPOSITORIES',
      resourceId: 'repo-1',
      metadata: { tool: 'web:repos.publish', is_published: true, repos_to_create: 25 },
    });
  });

  it('publish refused (missing template): no row', async () => {
    mocks.publishAssignment.mockResolvedValue({ error: 'Template not found' });

    await run('publish', { assignment_id: 'repo-1' });

    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('unpublish: one row', async () => {
    await run('unpublish', { assignment_id: 'repo-1' });

    expect(mocks.repositorySetPublished).toHaveBeenCalledWith('repo-1', false, 'class-1');
    expect(row()).toMatchObject({
      action: 'UPDATE',
      resourceId: 'repo-1',
      metadata: { tool: 'web:repos.unpublish', is_published: false },
    });
  });

  it('sync: one row with what it queued, counted per repo and per assignment', async () => {
    mocks.syncAssignment.mockResolvedValue({
      triggerSession: { accessToken: 't', id: 's', numReposToCreate: 4, numIssuesToCreate: 6 },
    });

    await run('sync', { assignment_id: 'repo-1' });

    expect(row()).toMatchObject({
      metadata: { tool: 'web:repos.sync', repos_to_create: 2, assignments_to_add: 3 },
      // Two syncs a few seconds apart are two rows.
      dedupe: false,
    });
    expect(row().metadata).not.toHaveProperty('partial');
  });

  it('sync partly queued: a partial row with what was queued, and a plain error', async () => {
    mocks.syncAssignment.mockRejectedValue(
      new RepositorySyncPartialError(
        { sessionId: 's', reposToCreate: 4, assignmentsToAdd: 0 },
        new Error('batch down')
      )
    );

    const result = await run('sync', { assignment_id: 'repo-1' });

    expect(result).toEqual({ error: 'Sync could not finish. Try again in a minute.' });
    expect(mocks.addClassroomAuditLog).toHaveBeenCalledTimes(1);
    expect(row()).toMatchObject({
      classroomId: 'class-1',
      action: 'UPDATE',
      resourceType: 'REPOSITORIES',
      resourceId: 'repo-1',
      metadata: {
        tool: 'web:repos.sync',
        partial: true,
        repos_to_create: 4,
        assignments_to_add: 0,
      },
      dedupe: false,
    });
  });

  it('sync failing with nothing queued: the same plain error, no row', async () => {
    mocks.syncAssignment.mockRejectedValue(new Error('Trigger.dev unavailable'));

    const result = await run('sync', { assignment_id: 'repo-1' });

    expect(result).toEqual({ error: 'Sync could not finish. Try again in a minute.' });
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('sync of a repository outside the classroom: not found, no row', async () => {
    mocks.syncAssignment.mockRejectedValue(new RepositorySyncNotFoundError());

    const result = await run('sync', { assignment_id: 'repo-other' });

    expect(result).toEqual({ error: 'Repository not found.' });
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('delete: one DELETE row naming the repository it removed', async () => {
    await run('delete', { assignment_id: 'repo-1' });

    expect(mocks.repositoryFindByIdInClassroom).toHaveBeenCalledWith('repo-1', 'class-1');
    expect(mocks.repositoryDeleteById).toHaveBeenCalledWith('repo-1', 'class-1');
    expect(row()).toMatchObject({
      action: 'DELETE',
      resourceType: 'REPOSITORIES',
      resourceId: 'repo-1',
      metadata: { tool: 'web:repos.delete', title: 'lab-1' },
    });
  });

  it('publishAssignment provisioning repos: counts each repo once', async () => {
    mocks.publishAssignmentAndRepository.mockResolvedValue({
      triggerSession: { accessToken: 't', id: 's', numReposToCreate: 50, numIssuesToCreate: 0 },
    });

    await run('publishAssignment', { assignment_id: 'asg-1' });

    expect(row()).toMatchObject({
      resourceType: 'ASSIGNMENTS',
      resourceId: 'asg-1',
      metadata: { tool: 'web:repos.publish_assignment', repos_to_create: 25 },
    });
    expect(row().metadata).not.toHaveProperty('opened_in_repos');
  });

  it('publishAssignment: one ASSIGNMENTS row with the repos it reached', async () => {
    mocks.publishAssignmentAndRepository.mockResolvedValue({
      triggerSession: { accessToken: 't', id: 's', numReposToCreate: 0, numIssuesToCreate: 76 },
    });

    await run('publishAssignment', { assignment_id: 'asg-1' });

    expect(row()).toMatchObject({
      resourceType: 'ASSIGNMENTS',
      resourceId: 'asg-1',
      metadata: { tool: 'web:repos.publish_assignment', opened_in_repos: 38 },
    });
  });
});
