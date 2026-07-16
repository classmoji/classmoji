/**
 * Unit tests for assignment_create / assignment_delete (Phase: assignment
 * lifecycle). Both fire ZERO external effects (pure DB — no GitHub, no
 * Trigger.dev, no email), so only the service boundary is mocked.
 *
 * The security-critical assertions: create re-verifies the PARENT container's
 * classroom (S1) and NEVER trusts a request classroom_id; delete re-verifies
 * the assignment's own classroom; both refuse cross-classroom targets with the
 * uniform scopedNotFound.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  repositoryFindById: vi.fn(),
  assignmentFindById: vi.fn(),
  assignmentCreate: vi.fn(),
  assignmentDeleteById: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    repository: { findById: (...a: unknown[]) => mocks.repositoryFindById(...a) },
    assignment: {
      findById: (...a: unknown[]) => mocks.assignmentFindById(...a),
      create: (...a: unknown[]) => mocks.assignmentCreate(...a),
      deleteById: (...a: unknown[]) => mocks.assignmentDeleteById(...a),
    },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
  },
}));

const { assignmentCreateTool, assignmentDeleteTool } = await import('../assignments.ts');

const CTX: ToolContext = {
  viewer: { userId: 'owner-1', clientId: 'c', scopes: new Set(['read', 'write']) },
  classroom: {
    classroomId: 'class-1',
    role: 'OWNER',
    status: 'ACTIVE',
    membership: { id: 'm-1', role: 'OWNER' },
    classroom: { settings: {} },
  },
} as unknown as ToolContext;

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.auditCreate.mockResolvedValue(undefined);
});

describe('assignment_create', () => {
  const ARGS = {
    classroom: 'org/winter-2025',
    repository_id: 'repo-1',
    title: 'Lab 3',
    weight: 50,
    student_deadline: '2026-07-20T23:59:00-04:00',
  };

  it('creates under a verified parent container and audits CREATE', async () => {
    mocks.repositoryFindById.mockResolvedValue({ id: 'repo-1', classroom_id: 'class-1' });
    mocks.assignmentCreate.mockResolvedValue({
      id: 'asg-new',
      title: 'Lab 3',
      repository_id: 'repo-1',
      weight: 50,
      is_published: false,
      student_deadline: new Date('2026-07-20T23:59:00-04:00'),
    });

    const payload = parse(await assignmentCreateTool.handler(ARGS, CTX));
    expect(payload.success).toBe(true);
    expect(payload.assignment.id).toBe('asg-new');

    // repository_id passed to create is the VERIFIED parent's id.
    const data = mocks.assignmentCreate.mock.calls[0][0] as {
      repository_id: string;
      title: string;
    };
    expect(data.repository_id).toBe('repo-1');
    expect(data.title).toBe('Lab 3');
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect((mocks.auditCreate.mock.calls[0][0] as { action: string }).action).toBe('CREATE');
  });

  it('refuses a parent container in another classroom (S1) and never creates', async () => {
    mocks.repositoryFindById.mockResolvedValue({ id: 'repo-1', classroom_id: 'OTHER-class' });

    await expect(assignmentCreateTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(mocks.assignmentCreate).not.toHaveBeenCalled();
  });

  it('refuses an unknown parent container (S1)', async () => {
    mocks.repositoryFindById.mockResolvedValue(null);
    await expect(assignmentCreateTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(mocks.assignmentCreate).not.toHaveBeenCalled();
  });

  it('maps a duplicate-title P2002 to invalid_params', async () => {
    mocks.repositoryFindById.mockResolvedValue({ id: 'repo-1', classroom_id: 'class-1' });
    mocks.assignmentCreate.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

    await expect(assignmentCreateTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});

describe('assignment_delete', () => {
  const ARGS = { classroom: 'org/winter-2025', assignment_id: 'asg-1' };

  it('deletes an in-classroom assignment and audits DELETE with a blast count', async () => {
    mocks.assignmentFindById.mockResolvedValue({
      id: 'asg-1',
      title: 'Lab 3',
      repository: { classroom_id: 'class-1' },
      git_repo_assignments: [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
    });

    const payload = parse(await assignmentDeleteTool.handler(ARGS, CTX));
    expect(payload.success).toBe(true);
    expect(payload.submissions_deleted).toBe(3);
    expect(mocks.assignmentDeleteById).toHaveBeenCalledWith('asg-1');
    const audit = mocks.auditCreate.mock.calls[0][0] as {
      action: string;
      data: { submissions_deleted: number };
    };
    expect(audit.action).toBe('DELETE');
    expect(audit.data.submissions_deleted).toBe(3);
  });

  it('refuses an assignment in another classroom (S1) and never deletes', async () => {
    mocks.assignmentFindById.mockResolvedValue({
      id: 'asg-1',
      title: 'Lab 3',
      repository: { classroom_id: 'OTHER-class' },
      git_repo_assignments: [],
    });

    await expect(assignmentDeleteTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(mocks.assignmentDeleteById).not.toHaveBeenCalled();
  });
});
