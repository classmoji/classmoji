/**
 * The class-level Assignments actions when the write fails: create, update and
 * delete each answer with fixed copy, and the service's own message (or a
 * GitHub or database one) stays in the server log, tagged with the route.
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
const RAW = 'Assignment not found in classroom';

const post = (name: string, body: Record<string, unknown>) =>
  route.action({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/admin/${CLASS_SLUG}/assignments?/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as unknown as Parameters<typeof route.action>[0]);

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.requireClassroomAdmin.mockResolvedValue({
    userId: 'owner-1',
    classroom: CLASSROOM,
    membership: { role: 'OWNER' },
  });
  mocks.loadQuizzesVisible.mockResolvedValue(true);
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

const FORM_BODY = { module_id: 'm-1', type: 'FORM', form_id: 'f-1', title: 'Exit ticket' };

describe('assignments action — a failed write answers with fixed copy', () => {
  it.each([
    {
      name: 'create',
      body: FORM_BODY,
      fail: () => mocks.createInClassroom.mockRejectedValue(new Error(RAW)),
      copy: 'Failed to create assignment. Please try again.',
      tag: '[admin.assignments] Assignment create error:',
    },
    {
      name: 'update',
      body: { id: 'a-1', title: 'Lab 1' },
      fail: () => mocks.updateInClassroom.mockRejectedValue(new Error(RAW)),
      copy: 'Failed to update assignment. Please try again.',
      tag: '[admin.assignments] Assignment update error:',
    },
    {
      name: 'delete',
      body: { id: 'a-1' },
      fail: () => mocks.deleteInClassroom.mockRejectedValue(new Error(RAW)),
      copy: 'Failed to delete assignment. Please try again.',
      tag: '[admin.assignments] Assignment delete error:',
    },
  ])('$name keeps the service message in the log', async ({ name, body, fail, copy, tag }) => {
    fail();

    const result = await post(name, body);

    expect(result).toEqual({ error: copy });
    expect(JSON.stringify(result)).not.toContain(RAW);
    expect(consoleError).toHaveBeenCalledWith(tag, expect.objectContaining({ message: RAW }));
  });
});

describe('assignments action — writes that go through', () => {
  it('create, update and delete still report success', async () => {
    mocks.createInClassroom.mockResolvedValue({ id: 'a-new', title: 'Exit ticket' });
    mocks.updateInClassroom.mockResolvedValue({ id: 'a-1', title: 'Lab 1' });
    mocks.deleteInClassroom.mockResolvedValue({ id: 'a-1' });

    expect(await post('create', FORM_BODY)).toEqual({
      success: 'Assignment "Exit ticket" created',
    });
    expect(await post('update', { id: 'a-1', title: 'Lab 1' })).toEqual({
      success: 'Assignment "Lab 1" updated',
    });
    expect(await post('delete', { id: 'a-1' })).toEqual({ success: 'Assignment deleted' });
    expect(mocks.deleteInClassroom).toHaveBeenCalledWith('a-1', 'class-1');
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe('assignments action — deleting an assignment', () => {
  it('records the delete in the audit log', async () => {
    mocks.findByIdInClassroom.mockResolvedValue({ id: 'a-1', title: 'Lab 1', repository_id: null });
    mocks.deleteInClassroom.mockResolvedValue({ id: 'a-1' });

    await post('delete', { id: 'a-1' });

    expect(mocks.addClassroomAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        classroomId: 'class-1',
        userId: 'owner-1',
        role: 'OWNER',
        action: 'DELETE',
        resourceType: 'ASSIGNMENTS',
        resourceId: 'a-1',
        metadata: expect.objectContaining({ tool: 'web:assignments.delete', title: 'Lab 1' }),
      })
    );
  });

  it('reports a published repository left with no assignments', async () => {
    mocks.findByIdInClassroom.mockResolvedValue({
      id: 'a-1',
      title: 'Lab 1',
      repository_id: 'r-1',
    });
    mocks.deleteInClassroom.mockResolvedValue({ id: 'a-1' });
    mocks.findRepositoryById.mockResolvedValue({
      id: 'r-1',
      title: 'hw3-heaps',
      classroom_id: 'class-1',
      is_published: true,
      assignments: [],
    });

    expect(await post('delete', { id: 'a-1' })).toEqual({
      success: 'Assignment deleted',
      orphanedRepository: { id: 'r-1', title: 'hw3-heaps' },
    });
  });

  it('says nothing when the repository keeps other assignments or is unpublished', async () => {
    mocks.findByIdInClassroom.mockResolvedValue({
      id: 'a-1',
      title: 'Lab 1',
      repository_id: 'r-1',
    });
    mocks.deleteInClassroom.mockResolvedValue({ id: 'a-1' });

    mocks.findRepositoryById.mockResolvedValue({
      id: 'r-1',
      title: 'hw3-heaps',
      classroom_id: 'class-1',
      is_published: true,
      assignments: [{ id: 'a-2' }],
    });
    expect(await post('delete', { id: 'a-1' })).toEqual({ success: 'Assignment deleted' });

    mocks.findRepositoryById.mockResolvedValue({
      id: 'r-1',
      title: 'hw3-heaps',
      classroom_id: 'class-1',
      is_published: false,
      assignments: [],
    });
    expect(await post('delete', { id: 'a-1' })).toEqual({ success: 'Assignment deleted' });
  });
});
