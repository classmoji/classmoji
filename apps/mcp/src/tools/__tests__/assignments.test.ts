/**
 * Unit tests for assignment_create / assignment_delete (Phase: assignment
 * lifecycle). Both fire ZERO external effects (pure DB — no GitHub, no
 * Trigger.dev, no email), so only the service boundary is mocked.
 *
 * The security-critical assertions: create re-verifies BOTH the module and the
 * repository's classroom (S1) and NEVER trusts a request classroom_id; delete re-verifies
 * the assignment's own classroom; both refuse cross-classroom targets with the
 * uniform scopedNotFound.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  moduleFindById: vi.fn(),
  repositoryFindById: vi.fn(),
  assignmentFindById: vi.fn(),
  assignmentCreate: vi.fn(),
  assignmentDeleteById: vi.fn(),
  assignmentUpdate: vi.fn(),
  membershipFindByClassroomAndUser: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    module: { findById: (...a: unknown[]) => mocks.moduleFindById(...a) },
    repository: { findById: (...a: unknown[]) => mocks.repositoryFindById(...a) },
    assignment: {
      findById: (...a: unknown[]) => mocks.assignmentFindById(...a),
      create: (...a: unknown[]) => mocks.assignmentCreate(...a),
      deleteById: (...a: unknown[]) => mocks.assignmentDeleteById(...a),
      update: (...a: unknown[]) => mocks.assignmentUpdate(...a),
    },
    classroomMembership: {
      findByClassroomAndUser: (...a: unknown[]) => mocks.membershipFindByClassroomAndUser(...a),
    },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
  },
}));

const { assignmentCreateTool, assignmentDeleteTool, assignmentUpdateTool } =
  await import('../assignments.ts');

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

// A TEACHER whose gate resolved as TEACHER; holdsRole(['OWNER']) then asks
// classroomMembership, which the tests answer per case.
const TEACHER_CTX: ToolContext = {
  ...CTX,
  viewer: { userId: 'teacher-1', clientId: 'c', scopes: new Set(['read', 'write']) },
  classroom: {
    ...(CTX.classroom as object),
    role: 'TEACHER',
    membership: { id: 'm-2', role: 'TEACHER' },
  },
} as unknown as ToolContext;

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.auditCreate.mockResolvedValue(undefined);
  mocks.moduleFindById.mockResolvedValue({ id: 'mod-1', classroom_id: 'class-1' });
});

describe('assignment_create', () => {
  const ARGS = {
    classroom: 'org/winter-2025',
    module_id: 'mod-1',
    repository_id: 'repo-1',
    title: 'Lab 3',
    weight: 50,
    student_deadline: '2026-07-20T23:59:00-04:00',
  };

  it('creates in a verified module through a verified repository and audits CREATE', async () => {
    mocks.repositoryFindById.mockResolvedValue({ id: 'repo-1', classroom_id: 'class-1' });
    mocks.assignmentCreate.mockResolvedValue({
      id: 'asg-new',
      title: 'Lab 3',
      module_id: 'mod-1',
      type: 'REPO',
      repository_id: 'repo-1',
      weight: 50,
      is_extra_credit: false,
      is_published: false,
      student_deadline: new Date('2026-07-20T23:59:00-04:00'),
    });

    const payload = parse(await assignmentCreateTool.handler(ARGS, CTX));
    expect(payload.success).toBe(true);
    expect(payload.assignment.id).toBe('asg-new');

    // repository_id and module_id passed to create are the VERIFIED ids, and
    // the assignment is a REPO assignment.
    const data = mocks.assignmentCreate.mock.calls[0][0] as {
      repository_id: string;
      module_id: string;
      type: string;
      title: string;
    };
    expect(data.repository_id).toBe('repo-1');
    expect(data.module_id).toBe('mod-1');
    expect(data.type).toBe('REPO');
    // A push is the submission unless the caller asks for issues.
    expect((data as { submission_mode?: string }).submission_mode).toBe('REPO');
    expect(data.title).toBe('Lab 3');
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect((mocks.auditCreate.mock.calls[0][0] as { action: string }).action).toBe('CREATE');
  });

  it('passes an explicit ISSUE submission mode through', async () => {
    mocks.repositoryFindById.mockResolvedValue({ id: 'repo-1', classroom_id: 'class-1' });
    mocks.assignmentCreate.mockResolvedValue({
      id: 'asg-2',
      title: 'Lab 3',
      submission_mode: 'ISSUE',
    });

    const payload = parse(
      await assignmentCreateTool.handler({ ...ARGS, submission_mode: 'ISSUE' }, CTX)
    );
    expect(payload.assignment.submission_mode).toBe('ISSUE');
    expect(
      (mocks.assignmentCreate.mock.calls[0][0] as { submission_mode?: string }).submission_mode
    ).toBe('ISSUE');
  });

  it('refuses a module that belongs to another classroom (S1)', async () => {
    mocks.moduleFindById.mockResolvedValue({ id: 'mod-1', classroom_id: 'OTHER-class' });
    mocks.repositoryFindById.mockResolvedValue({ id: 'repo-1', classroom_id: 'class-1' });
    await expect(assignmentCreateTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(mocks.assignmentCreate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
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

describe('assignment_update: grader_deadline and release_at', () => {
  const ARGS = { classroom: 'org/winter-2025', assignment_id: 'asg-1' };
  const GRADER = '2026-07-27T23:59:00-04:00';
  const RELEASE = '2026-07-06T09:00:00-04:00';

  beforeEach(() => {
    mocks.assignmentFindById.mockResolvedValue({
      id: 'asg-1',
      title: 'Lab 3',
      repository: { classroom_id: 'class-1' },
    });
    // Echo the write back the way Prisma would.
    mocks.assignmentUpdate.mockImplementation(
      async (id: string, data: Record<string, unknown>) => ({
        id,
        title: 'Lab 3',
        student_deadline: new Date('2026-07-20T23:59:00-04:00'),
        weight: 50,
        grades_released: false,
        grader_deadline: null,
        release_at: null,
        ...data,
      })
    );
    // Not an OWNER unless a case says so.
    mocks.membershipFindByClassroomAndUser.mockResolvedValue(null);
  });

  it.each([
    ['grader_deadline', GRADER],
    ['release_at', RELEASE],
  ] as const)('OWNER sets %s through the notifying update path', async (field, value) => {
    const payload = parse(await assignmentUpdateTool.handler({ ...ARGS, [field]: value }, CTX));

    // The same service call the other fields use (notifyAfterUpdate runs there),
    // with an explicit Date and nothing else from the request.
    expect(mocks.assignmentUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.assignmentUpdate).toHaveBeenCalledWith('asg-1', { [field]: new Date(value) });
    expect(payload.success).toBe(true);
    expect(payload.assignment[field]).toBe(new Date(value).toISOString());

    const audit = mocks.auditCreate.mock.calls[0][0] as {
      resource_type: string;
      resource_id: string;
      action: string;
      data: { tool: string; fields: string[] };
    };
    expect(audit).toMatchObject({
      resource_type: 'ASSIGNMENT',
      resource_id: 'asg-1',
      action: 'UPDATE',
      data: {
        tool: 'assignment_update',
        fields: [field],
        values: { [field]: new Date(value).toISOString() },
      },
    });
  });

  it('sets both together, audits both fields, and returns the full shape', async () => {
    const payload = parse(
      await assignmentUpdateTool.handler(
        { ...ARGS, grader_deadline: GRADER, release_at: RELEASE },
        CTX
      )
    );

    expect(mocks.assignmentUpdate).toHaveBeenCalledWith('asg-1', {
      grader_deadline: new Date(GRADER),
      release_at: new Date(RELEASE),
    });
    expect(payload).toEqual({
      success: true,
      assignment: {
        id: 'asg-1',
        title: 'Lab 3',
        student_deadline: new Date('2026-07-20T23:59:00-04:00').toISOString(),
        weight: 50,
        grades_released: false,
        grader_deadline: new Date(GRADER).toISOString(),
        release_at: new Date(RELEASE).toISOString(),
      },
    });
    const audit = mocks.auditCreate.mock.calls[0][0] as { data: unknown };
    expect(audit.data).toEqual({
      tool: 'assignment_update',
      fields: ['grader_deadline', 'release_at'],
      values: {
        grader_deadline: new Date(GRADER).toISOString(),
        release_at: new Date(RELEASE).toISOString(),
      },
    });
  });

  it('clears both dates with null, as the web edit form does', async () => {
    const payload = parse(
      await assignmentUpdateTool.handler({ ...ARGS, grader_deadline: null, release_at: null }, CTX)
    );

    expect(mocks.assignmentUpdate).toHaveBeenCalledWith('asg-1', {
      grader_deadline: null,
      release_at: null,
    });
    expect(payload.assignment.grader_deadline).toBeNull();
    expect(payload.assignment.release_at).toBeNull();
    const audit = mocks.auditCreate.mock.calls[0][0] as { data: unknown };
    expect(audit.data).toEqual({
      tool: 'assignment_update',
      fields: ['grader_deadline', 'release_at'],
      values: { grader_deadline: null, release_at: null },
    });
  });

  it('records the new value of every changed field, not only the dates', async () => {
    await assignmentUpdateTool.handler(
      {
        ...ARGS,
        student_deadline: '2026-07-21T23:59:00-04:00',
        weight: 40,
        grades_released: true,
        release_at: RELEASE,
      },
      CTX
    );
    const audit = mocks.auditCreate.mock.calls[0][0] as { data: unknown };
    expect(audit.data).toEqual({
      tool: 'assignment_update',
      fields: ['student_deadline', 'weight', 'grades_released', 'release_at'],
      values: {
        student_deadline: new Date('2026-07-21T23:59:00-04:00').toISOString(),
        weight: 40,
        grades_released: true,
        release_at: new Date(RELEASE).toISOString(),
      },
    });
  });

  it.each([
    ['grader_deadline', GRADER],
    ['release_at', RELEASE],
    ['grader_deadline', null],
    ['release_at', null],
  ] as const)(
    'refuses a TEACHER setting %s (%s): the web route is OWNER only',
    async (field, value) => {
      await expect(
        assignmentUpdateTool.handler({ ...ARGS, [field]: value }, TEACHER_CTX)
      ).rejects.toMatchObject({ kind: 'forbidden' });

      expect(mocks.membershipFindByClassroomAndUser).toHaveBeenCalledWith('class-1', 'teacher-1', [
        'OWNER',
      ]);
      expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
      expect(mocks.auditCreate).not.toHaveBeenCalled();
    }
  );

  it('refuses a mixed TEACHER update without applying the teacher-tier field', async () => {
    await expect(
      assignmentUpdateTool.handler(
        { ...ARGS, student_deadline: '2026-07-21T23:59:00-04:00', release_at: RELEASE },
        TEACHER_CTX
      )
    ).rejects.toMatchObject({ kind: 'forbidden', message: expect.stringMatching(/release_at/) });
    expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
  });

  it('lets a TEACHER who also holds OWNER set the dates', async () => {
    mocks.membershipFindByClassroomAndUser.mockResolvedValue({ id: 'm-3', role: 'OWNER' });
    await assignmentUpdateTool.handler({ ...ARGS, release_at: RELEASE }, TEACHER_CTX);
    expect(mocks.assignmentUpdate).toHaveBeenCalledWith('asg-1', { release_at: new Date(RELEASE) });
  });

  it('refuses an assignment in another classroom before any write', async () => {
    mocks.assignmentFindById.mockResolvedValue({
      id: 'asg-1',
      title: 'Lab 3',
      repository: { classroom_id: 'OTHER-class' },
    });
    await expect(
      assignmentUpdateTool.handler({ ...ARGS, release_at: RELEASE }, CTX)
    ).rejects.toMatchObject({ kind: 'not_found' });
    expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
  });

  it('names the new fields when nothing is provided', async () => {
    await expect(assignmentUpdateTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
      message: expect.stringMatching(/grader_deadline, release_at/),
    });
  });

  it('accepts an offset datetime or null and rejects anything else in the schema', () => {
    const schema = z.object(assignmentUpdateTool.inputSchema);
    const base = { classroom: 'org/w26', assignment_id: '00000000-0000-4000-8000-000000000001' };
    for (const field of ['grader_deadline', 'release_at']) {
      expect(schema.safeParse({ ...base, [field]: GRADER }).success).toBe(true);
      expect(schema.safeParse({ ...base, [field]: '2026-07-27T23:59:00Z' }).success).toBe(true);
      expect(schema.safeParse({ ...base, [field]: null }).success).toBe(true);
      expect(schema.safeParse({ ...base, [field]: 'next friday' }).success).toBe(false);
      expect(schema.safeParse({ ...base, [field]: '2026-07-27' }).success).toBe(false);
      expect(schema.safeParse({ ...base, [field]: 1785196740000 }).success).toBe(false);
    }
  });

  it('keeps the description under the 1,500-byte connector limit', () => {
    expect(new TextEncoder().encode(assignmentUpdateTool.description).length).toBeLessThan(1500);
  });
});
