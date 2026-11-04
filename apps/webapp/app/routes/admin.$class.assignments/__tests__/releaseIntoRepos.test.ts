/**
 * The edit form's create and update (#385): a write that publishes a REPO
 * assignment, or moves its release date, puts it into the student repos that
 * already exist through the shared operation the module card's Publish and the
 * MCP tools run. Weight, deadline and text edits never do: the form sends
 * release_at on every save, so only a changed date counts. Scope is the
 * classroom the owner was authorized for, never one from the body.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomAdmin: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  loadQuizzesVisible: vi.fn(),
  quizzesVisibleOrThrow: vi.fn(),
  findByIdInClassroom: vi.fn(),
  createInClassroom: vi.fn(),
  updateInClassroom: vi.fn(),
  deleteInClassroom: vi.fn(),
  addClassroomAuditLog: vi.fn(),
  findRepositoryById: vi.fn(),
  openInRepos: vi.fn(),
}));

vi.mock('@classmoji/tasks/assignment-release', () => ({
  openAssignmentInExistingRepos: (...a: unknown[]) => mocks.openInRepos(...a),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomAdmin: (...a: unknown[]) => mocks.requireClassroomAdmin(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
}));

vi.mock('~/utils/classroomProFlag.server', () => ({
  loadQuizzesVisible: (...a: unknown[]) => mocks.loadQuizzesVisible(...a),
  quizzesVisibleOrThrow: (...a: unknown[]) => mocks.quizzesVisibleOrThrow(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    assignment: {
      findByIdInClassroom: (...a: unknown[]) => mocks.findByIdInClassroom(...a),
      createInClassroom: (...a: unknown[]) => mocks.createInClassroom(...a),
      updateInClassroom: (...a: unknown[]) => mocks.updateInClassroom(...a),
      deleteInClassroom: (...a: unknown[]) => mocks.deleteInClassroom(...a),
    },
    repository: { findById: (...a: unknown[]) => mocks.findRepositoryById(...a) },
  },
}));

// The action is what is under test; the view layer only needs to be importable.
vi.mock('~/utils/helpers', () => ({
  addClassroomAuditLog: (...a: unknown[]) => mocks.addClassroomAuditLog(...a),
}));
vi.mock('~/components', () => ({ SearchInput: () => null }));
vi.mock('~/components/features/assignments/AssignmentsTable', () => ({ default: () => null }));
vi.mock('~/components/features/assignments/AssignmentFormModal', () => ({ default: () => null }));

const route = await import('../route.tsx');

const CLASS_SLUG = 'cs52-26f';
const CLASSROOM = { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE', name: 'CS 52' };
const RELEASE = '2026-11-04T14:00:00.000Z';

const post = (name: string, body: Record<string, unknown>) =>
  route.action({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/admin/${CLASS_SLUG}/assignments?/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as unknown as Parameters<typeof route.action>[0]);

const target = (overrides: Record<string, unknown> = {}) => ({
  id: 'a-1',
  title: 'Lab 1',
  type: 'REPO',
  is_published: true,
  release_at: new Date(RELEASE),
  repository_id: 'r-1',
  ...overrides,
});

// What the edit form posts on every save (AssignmentFormModal submit).
const FORM_SAVE = {
  id: 'a-1',
  title: 'Lab 1',
  weight: 50,
  release_at: RELEASE,
  student_deadline: '2026-11-10T04:59:00.000Z',
  grader_deadline: null,
  tokens_per_hour: null,
  description: '',
  page_ids: [],
  slide_ids: [],
};

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.requireClassroomAdmin.mockResolvedValue({
    userId: 'owner-1',
    classroom: CLASSROOM,
    membership: { role: 'OWNER' },
  });
  mocks.loadQuizzesVisible.mockResolvedValue(true);
  mocks.updateInClassroom.mockResolvedValue({ id: 'a-1', title: 'Lab 1' });
  mocks.openInRepos.mockResolvedValue({ queued: 3, sessionId: 's-1' });
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('assignments update: when it opens the assignment in existing repos', () => {
  it('not on a weight or deadline edit, though the form re-sends the same release_at', async () => {
    mocks.findByIdInClassroom.mockResolvedValue(target());

    const result = await post('update', { ...FORM_SAVE, weight: 40 });

    expect(result).toEqual({ success: 'Assignment "Lab 1" updated' });
    expect(mocks.openInRepos).not.toHaveBeenCalled();
  });

  it('when release_at moved, scoped to the authorized classroom', async () => {
    mocks.findByIdInClassroom.mockResolvedValue(
      target({ is_published: false, release_at: new Date('2026-11-20T14:00:00.000Z') })
    );

    const result = await post('update', { ...FORM_SAVE, classroom_id: 'class-other' });

    expect(result).toEqual({ success: 'Assignment "Lab 1" updated' });
    expect(mocks.findByIdInClassroom).toHaveBeenCalledWith('a-1', 'class-1');
    expect(mocks.openInRepos).toHaveBeenCalledWith({ classroomId: 'class-1', assignmentId: 'a-1' });
    expect(mocks.updateInClassroom.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.openInRepos.mock.invocationCallOrder[0]
    );
  });

  it('when a release date is set where there was none', async () => {
    mocks.findByIdInClassroom.mockResolvedValue(target({ release_at: null }));

    await post('update', FORM_SAVE);

    expect(mocks.openInRepos).toHaveBeenCalledTimes(1);
  });

  it('when it publishes, and never when it unpublishes', async () => {
    mocks.findByIdInClassroom.mockResolvedValue(target({ is_published: false }));
    await post('update', { id: 'a-1', is_published: true });
    expect(mocks.openInRepos).toHaveBeenCalledTimes(1);

    mocks.openInRepos.mockClear();
    mocks.findByIdInClassroom.mockResolvedValue(target({ release_at: null }));
    await post('update', { ...FORM_SAVE, is_published: false });
    expect(mocks.openInRepos).not.toHaveBeenCalled();
  });

  it('not on a quiz or form assignment', async () => {
    for (const type of ['QUIZ', 'FORM']) {
      mocks.findByIdInClassroom.mockResolvedValue(target({ type, release_at: null }));
      await post('update', FORM_SAVE);
    }
    expect(mocks.openInRepos).not.toHaveBeenCalled();
  });

  it('keeps the success toast and adds a note when it could not be started', async () => {
    mocks.findByIdInClassroom.mockResolvedValue(target({ release_at: null }));
    mocks.openInRepos.mockRejectedValue(new Error('trigger down'));

    const result = (await post('update', FORM_SAVE)) as { success?: string; info?: string };

    expect(result.success).toBe('Assignment "Lab 1" updated');
    expect(result.info).toMatch(/Use Sync/);
    expect(result.info).not.toMatch(/trigger down/);
  });
});

describe('assignments create: when it opens the assignment in existing repos', () => {
  const REPO_BODY = {
    module_id: 'm-1',
    type: 'REPO',
    repository_id: 'r-1',
    title: 'Lab 2',
    submission_mode: 'ISSUE',
  };

  it('when created published into an existing repository', async () => {
    mocks.createInClassroom.mockResolvedValue({
      id: 'a-new',
      title: 'Lab 2',
      type: 'REPO',
      is_published: true,
    });

    const result = await post('create', { ...REPO_BODY, is_published: true });

    expect(result).toEqual({ success: 'Assignment "Lab 2" created' });
    expect(mocks.openInRepos).toHaveBeenCalledWith({
      classroomId: 'class-1',
      assignmentId: 'a-new',
    });
  });

  it('not when created as a draft', async () => {
    mocks.createInClassroom.mockResolvedValue({
      id: 'a-new',
      title: 'Lab 2',
      type: 'REPO',
      is_published: false,
    });

    await post('create', REPO_BODY);

    expect(mocks.openInRepos).not.toHaveBeenCalled();
  });
});
