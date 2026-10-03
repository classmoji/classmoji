/**
 * Unit tests for assignment_create / assignment_delete / assignment_update
 * (Phase: assignment lifecycle). All fire ZERO external effects (pure DB — no
 * GitHub, no Trigger.dev, no email), so only the service boundary is mocked.
 *
 * The security-critical assertions: create re-verifies BOTH the module and the
 * repository's classroom (S1) and NEVER trusts a request classroom_id; delete re-verifies
 * the assignment's own classroom; both refuse cross-classroom targets with the
 * uniform scopedNotFound. update resolves the assignment through its MODULE
 * (any type, quiz and form included) and, for a move, the target module too,
 * before anything is written.
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
  assignmentMoveToModuleEnd: vi.fn(),
  quizzesVisible: vi.fn(),
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
      moveToModuleEnd: (...a: unknown[]) => mocks.assignmentMoveToModuleEnd(...a),
    },
    entitlement: { quizzesVisible: (...a: unknown[]) => mocks.quizzesVisible(...a) },
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
      type: 'REPO',
      module_id: 'mod-1',
      module: { id: 'mod-1', title: 'Week 1', classroom_id: 'class-1' },
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
        module_id: 'mod-1',
        module_title: 'Week 1',
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
      value: expect.any(String),
    });
    // The dedup key: a digest of what was written, so two different edits
    // inside audit's 5s window stay two rows.
    const data = audit.data as { values: unknown; value: string };
    expect(data.value).toBe(JSON.stringify(data.values));
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
      value: expect.any(String),
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
      value: expect.any(String),
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
      type: 'REPO',
      module_id: 'mod-9',
      module: { id: 'mod-9', title: 'Elsewhere', classroom_id: 'OTHER-class' },
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

describe('assignment_update: module_id (moving an assignment to another module)', () => {
  const ARGS = { classroom: 'org/winter-2025', assignment_id: 'asg-1' };
  const NOW = {
    id: 'asg-1',
    title: 'Lab 3',
    type: 'REPO',
    module_id: 'mod-1',
    module: { id: 'mod-1', title: 'Week 1', classroom_id: 'class-1' },
    repository: { classroom_id: 'class-1' },
    student_deadline: new Date('2026-07-20T23:59:00-04:00'),
    weight: 50,
    grades_released: false,
    grader_deadline: null,
    release_at: null,
  };
  const TARGET = { id: 'mod-2', title: 'Week 2', classroom_id: 'class-1' };
  const auditData = (call = 0) =>
    (mocks.auditCreate.mock.calls[call][0] as { data: Record<string, unknown> }).data;

  beforeEach(() => {
    mocks.assignmentFindById.mockResolvedValue(NOW);
    mocks.moduleFindById.mockResolvedValue(TARGET);
    mocks.assignmentMoveToModuleEnd.mockResolvedValue({ moved: true, fromModuleId: 'mod-1' });
    mocks.assignmentUpdate.mockImplementation(
      async (id: string, data: Record<string, unknown>) => ({ ...NOW, id, ...data })
    );
    mocks.quizzesVisible.mockResolvedValue(true);
    mocks.membershipFindByClassroomAndUser.mockResolvedValue(null);
  });

  it('moves through assignment.moveToModuleEnd, scoped to the authorized classroom', async () => {
    const payload = parse(await assignmentUpdateTool.handler({ ...ARGS, module_id: 'mod-2' }, CTX));

    // The transactional move service with the AUTHORIZED classroom id. Never a
    // bare column write: that would leave `position` stale in both modules.
    expect(mocks.moduleFindById).toHaveBeenCalledWith('mod-2');
    expect(mocks.assignmentMoveToModuleEnd).toHaveBeenCalledTimes(1);
    expect(mocks.assignmentMoveToModuleEnd).toHaveBeenCalledWith('asg-1', 'mod-2', 'class-1');
    expect(mocks.assignmentUpdate).not.toHaveBeenCalled();

    expect(payload).toEqual({
      success: true,
      assignment: {
        id: 'asg-1',
        title: 'Lab 3',
        module_id: 'mod-2',
        module_title: 'Week 2',
        student_deadline: NOW.student_deadline.toISOString(),
        weight: 50,
        grades_released: false,
        grader_deadline: null,
        release_at: null,
      },
      moved_from_module_id: 'mod-1',
    });
  });

  it('audits the move with where it came from and where it went', async () => {
    await assignmentUpdateTool.handler({ ...ARGS, module_id: 'mod-2' }, CTX);

    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate.mock.calls[0][0]).toMatchObject({
      resource_type: 'ASSIGNMENT',
      resource_id: 'asg-1',
      action: 'UPDATE',
      data: {
        tool: 'assignment_update',
        fields: ['module_id'],
        values: { module_id: 'mod-2' },
        from_module_id: 'mod-1',
        // Both ends are in the dedup key: a move here from somewhere else
        // inside audit's 5s window is a different row.
        value: JSON.stringify({ module_id: 'mod-2', from_module_id: 'mod-1' }),
      },
    });
  });

  it('moves and edits in one call, auditing each write as soon as it lands', async () => {
    const payload = parse(
      await assignmentUpdateTool.handler({ ...ARGS, module_id: 'mod-2', weight: 40 }, CTX)
    );

    // module_id never reaches the column write.
    expect(mocks.assignmentUpdate).toHaveBeenCalledWith('asg-1', { weight: 40 });
    expect(payload.assignment).toMatchObject({ module_id: 'mod-2', weight: 40 });

    // move → its audit row → field update → its audit row.
    const order = (mock: { mock: { invocationCallOrder: number[] } }, call = 0) =>
      mock.mock.invocationCallOrder[call];
    expect(order(mocks.assignmentMoveToModuleEnd)).toBeLessThan(order(mocks.auditCreate, 0));
    expect(order(mocks.auditCreate, 0)).toBeLessThan(order(mocks.assignmentUpdate));
    expect(order(mocks.assignmentUpdate)).toBeLessThan(order(mocks.auditCreate, 1));
    expect(auditData(0)).toMatchObject({ fields: ['module_id'], from_module_id: 'mod-1' });
    expect(auditData(1)).toEqual({
      tool: 'assignment_update',
      fields: ['weight'],
      values: { weight: 40 },
      value: JSON.stringify({ weight: 40 }),
    });
  });

  it('leaves the move on record when the field edit after it fails', async () => {
    mocks.assignmentUpdate.mockRejectedValue(new Error('connection lost'));

    await expect(
      assignmentUpdateTool.handler({ ...ARGS, module_id: 'mod-2', weight: 40 }, CTX)
    ).rejects.toThrow('connection lost');

    // The move committed, so its row is already written: a retry (which finds
    // the assignment in mod-2 and moves nothing) leaves no unaudited change.
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(auditData(0)).toMatchObject({ fields: ['module_id'], from_module_id: 'mod-1' });
  });

  it.each([
    ['in another classroom', { ...TARGET, classroom_id: 'OTHER-class' }],
    ['that does not exist', null],
  ])('refuses a target module %s (S1) before any write', async (_label, module) => {
    mocks.moduleFindById.mockResolvedValue(module);

    const error = await assignmentUpdateTool
      .handler({ ...ARGS, module_id: 'mod-2', weight: 40 }, CTX)
      .catch(e => e);

    // The same uniform refusal either way, naming nothing about the module.
    expect(error).toMatchObject({
      kind: 'not_found',
      message: 'Module not found in this classroom',
    });
    expect(mocks.assignmentMoveToModuleEnd).not.toHaveBeenCalled();
    expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('refuses a TEACHER: moving is the OWNER-only Modules page action', async () => {
    await expect(
      assignmentUpdateTool.handler({ ...ARGS, module_id: 'mod-2' }, TEACHER_CTX)
    ).rejects.toMatchObject({ kind: 'forbidden', message: expect.stringMatching(/module_id/) });

    // The assignment is read (its type decides the tier); the target module
    // is not, and nothing is written.
    expect(mocks.moduleFindById).not.toHaveBeenCalled();
    expect(mocks.assignmentMoveToModuleEnd).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('refuses a TEACHER naming even the module it is already in', async () => {
    await expect(
      assignmentUpdateTool.handler({ ...ARGS, module_id: 'mod-1' }, TEACHER_CTX)
    ).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('refuses a TEACHER’s mixed call without applying the teacher-tier field', async () => {
    await expect(
      assignmentUpdateTool.handler(
        { ...ARGS, student_deadline: '2026-07-21T23:59:00-04:00', module_id: 'mod-2' },
        TEACHER_CTX
      )
    ).rejects.toMatchObject({ kind: 'forbidden' });
    expect(mocks.assignmentMoveToModuleEnd).not.toHaveBeenCalled();
    expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
  });

  it('treats the module it is already in as no move: nothing written, nothing audited', async () => {
    const payload = parse(await assignmentUpdateTool.handler({ ...ARGS, module_id: 'mod-1' }, CTX));

    // A retried move is a success, and its position in the module is left alone.
    expect(payload.success).toBe(true);
    expect(payload.assignment).toMatchObject({ module_id: 'mod-1', module_title: 'Week 1' });
    expect(payload).not.toHaveProperty('moved_from_module_id');
    expect(mocks.moduleFindById).not.toHaveBeenCalled();
    expect(mocks.assignmentMoveToModuleEnd).not.toHaveBeenCalled();
    expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('audits only what changed when the module is the current one and a field is not', async () => {
    await assignmentUpdateTool.handler({ ...ARGS, module_id: 'mod-1', weight: 40 }, CTX);

    expect(mocks.assignmentMoveToModuleEnd).not.toHaveBeenCalled();
    expect(mocks.assignmentUpdate).toHaveBeenCalledWith('asg-1', { weight: 40 });
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(auditData()).toMatchObject({ fields: ['weight'], values: { weight: 40 } });
    expect(auditData()).not.toHaveProperty('from_module_id');
  });

  it('records nothing when another request moved it there first', async () => {
    mocks.assignmentMoveToModuleEnd.mockResolvedValue({ moved: false, fromModuleId: 'mod-1' });

    const payload = parse(await assignmentUpdateTool.handler({ ...ARGS, module_id: 'mod-2' }, CTX));

    expect(payload.assignment.module_id).toBe('mod-2');
    expect(payload).not.toHaveProperty('moved_from_module_id');
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('moves a FORM assignment, which has no repository to resolve it through', async () => {
    mocks.assignmentFindById.mockResolvedValue({ ...NOW, type: 'FORM', repository: null });

    const payload = parse(await assignmentUpdateTool.handler({ ...ARGS, module_id: 'mod-2' }, CTX));

    expect(payload.assignment.module_id).toBe('mod-2');
    expect(mocks.assignmentMoveToModuleEnd).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['OWNER', CTX],
    ['TEACHER', TEACHER_CTX],
  ] as const)(
    'refuses to move a QUIZ assignment for the %s and points at quiz_update',
    async (_role, ctx) => {
      mocks.assignmentFindById.mockResolvedValue({ ...NOW, type: 'QUIZ', repository: null });

      const error = await assignmentUpdateTool
        .handler({ ...ARGS, module_id: 'mod-2' }, ctx)
        .catch(e => e);

      expect(error).toMatchObject({ kind: 'invalid_params' });
      expect(error.message).toMatch(/quiz_update module_id/);
      expect(mocks.assignmentMoveToModuleEnd).not.toHaveBeenCalled();
      expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
      expect(mocks.auditCreate).not.toHaveBeenCalled();
    }
  );

  it.each(['QUIZ', 'FORM'])(
    'refuses a %s assignment whose MODULE is in another classroom (its only scope chain)',
    async type => {
      // No repository to fall back on: the module check is the whole boundary.
      mocks.assignmentFindById.mockResolvedValue({
        ...NOW,
        type,
        repository: null,
        module_id: 'mod-9',
        module: { id: 'mod-9', title: 'Elsewhere', classroom_id: 'OTHER-class' },
      });

      for (const args of [{ module_id: 'mod-2' }, { weight: 40 }]) {
        await expect(assignmentUpdateTool.handler({ ...ARGS, ...args }, CTX)).rejects.toMatchObject(
          {
            kind: 'not_found',
            message: 'Assignment not found in this classroom',
          }
        );
      }
      expect(mocks.assignmentMoveToModuleEnd).not.toHaveBeenCalled();
      expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
      expect(mocks.auditCreate).not.toHaveBeenCalled();
    }
  );

  it('does not name a quiz assignment where the classroom shows no quizzes', async () => {
    mocks.assignmentFindById.mockResolvedValue({ ...NOW, type: 'QUIZ', repository: null });
    mocks.quizzesVisible.mockResolvedValue(false);

    const error = await assignmentUpdateTool
      .handler({ ...ARGS, module_id: 'mod-2' }, CTX)
      .catch(e => e);

    // Indistinguishable from an id that does not exist: list_modules lists no
    // quiz row there, so no tool may confirm one.
    expect(error).toMatchObject({
      kind: 'not_found',
      message: 'Assignment not found in this classroom',
    });
    expect(mocks.quizzesVisible).toHaveBeenCalledWith('class-1');
    expect(mocks.assignmentMoveToModuleEnd).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('asks about quizzes for a QUIZ assignment only', async () => {
    await assignmentUpdateTool.handler({ ...ARGS, module_id: 'mod-2' }, CTX);
    expect(mocks.quizzesVisible).not.toHaveBeenCalled();
  });

  it('refuses an assignment whose repository is in another classroom than its module', async () => {
    mocks.assignmentFindById.mockResolvedValue({
      ...NOW,
      repository: { classroom_id: 'OTHER-class' },
    });

    await expect(
      assignmentUpdateTool.handler({ ...ARGS, module_id: 'mod-2' }, CTX)
    ).rejects.toMatchObject({ kind: 'not_found' });
    expect(mocks.assignmentMoveToModuleEnd).not.toHaveBeenCalled();
  });

  it.each([
    ['Module not found in classroom', 'not_found', 'Module not found in this classroom'],
    ['Assignment not found in classroom', 'not_found', 'Assignment not found in this classroom'],
  ])(
    'translates the service’s own re-check (%s) into the uniform refusal',
    async (thrown, kind, message) => {
      // Deleted between the handler's check and the transaction's.
      mocks.assignmentMoveToModuleEnd.mockRejectedValue(new Error(thrown));

      await expect(
        assignmentUpdateTool.handler({ ...ARGS, module_id: 'mod-2', weight: 40 }, CTX)
      ).rejects.toMatchObject({ kind, message });
      expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
      expect(mocks.auditCreate).not.toHaveBeenCalled();
    }
  );

  it('reports the same assignment moved elsewhere at the same instant as a retry', async () => {
    // The service throws this BEFORE writing anything, so there is nothing to
    // audit and a retry sees the real state.
    mocks.assignmentMoveToModuleEnd.mockRejectedValue(new Error('Assignment moved concurrently'));

    const error = await assignmentUpdateTool
      .handler({ ...ARGS, module_id: 'mod-2', weight: 40 }, CTX)
      .catch(e => e);

    expect(error).toMatchObject({ kind: 'internal', message: expect.stringMatching(/retry/) });
    expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('does not swallow an unexpected move failure', async () => {
    mocks.assignmentMoveToModuleEnd.mockRejectedValue(new Error('connection lost'));

    await expect(
      assignmentUpdateTool.handler({ ...ARGS, module_id: 'mod-2' }, CTX)
    ).rejects.toThrow('connection lost');
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('declares module_id as an optional uuid and names it when nothing is provided', async () => {
    const schema = z.object(assignmentUpdateTool.inputSchema);
    const base = { classroom: 'org/w26', assignment_id: '00000000-0000-4000-8000-000000000001' };
    expect(schema.safeParse(base).success).toBe(true);
    expect(
      schema.safeParse({ ...base, module_id: '00000000-0000-4000-8000-000000000002' }).success
    ).toBe(true);
    expect(schema.safeParse({ ...base, module_id: 'week-2' }).success).toBe(false);
    // An assignment always has a module: there is no clearing it.
    expect(schema.safeParse({ ...base, module_id: null }).success).toBe(false);

    await expect(assignmentUpdateTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
      message: expect.stringMatching(/module_id/),
    });
  });

  it('says in the description that module_id is how an assignment is placed in a module', () => {
    expect(assignmentUpdateTool.description).toMatch(/module_id MOVES the assignment/);
    expect(assignmentUpdateTool.description).toMatch(/list_modules/);
  });
});

describe('assignment_update: grades_released on a quiz or form assignment', () => {
  const ARGS = { classroom: 'org/winter-2025', assignment_id: 'asg-q', grades_released: true };
  const QUIZ_ASSIGNMENT = {
    id: 'asg-q',
    title: 'Quiz 1',
    type: 'QUIZ',
    module_id: 'mod-1',
    module: { id: 'mod-1', title: 'Week 1', classroom_id: 'class-1' },
    repository: null,
    student_deadline: null,
    weight: 100,
    grades_released: false,
    grader_deadline: null,
    release_at: null,
  };

  beforeEach(() => {
    mocks.assignmentFindById.mockResolvedValue(QUIZ_ASSIGNMENT);
    mocks.quizzesVisible.mockResolvedValue(true);
    mocks.membershipFindByClassroomAndUser.mockResolvedValue(null);
    mocks.assignmentUpdate.mockImplementation(
      async (id: string, data: Record<string, unknown>) => ({ ...QUIZ_ASSIGNMENT, id, ...data })
    );
  });

  it('refuses it on a QUIZ assignment for every role: a quiz shows its score at once', async () => {
    for (const ctx of [CTX, TEACHER_CTX]) {
      await expect(assignmentUpdateTool.handler(ARGS, ctx)).rejects.toMatchObject({
        kind: 'invalid_params',
        message:
          'A quiz shows its score as soon as an attempt completes: grades_released does not apply',
      });
    }
    expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('refuses a TEACHER on a FORM assignment: the web’s teacher route only reaches repository assignments', async () => {
    mocks.assignmentFindById.mockResolvedValue({ ...QUIZ_ASSIGNMENT, type: 'FORM' });
    await expect(assignmentUpdateTool.handler(ARGS, TEACHER_CTX)).rejects.toMatchObject({
      kind: 'forbidden',
      message: 'Only the classroom owner can update grades_released on a form assignment',
    });
    expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
  });

  it('still lets a TEACHER flip it on a REPO assignment', async () => {
    mocks.assignmentFindById.mockResolvedValue({
      ...QUIZ_ASSIGNMENT,
      type: 'REPO',
      repository: { classroom_id: 'class-1' },
    });
    const payload = parse(await assignmentUpdateTool.handler(ARGS, TEACHER_CTX));
    expect(payload.assignment.grades_released).toBe(true);
  });

  it('lets the OWNER set it on a FORM assignment, as the owner’s web edit form does', async () => {
    mocks.assignmentFindById.mockResolvedValue({ ...QUIZ_ASSIGNMENT, type: 'FORM' });
    const payload = parse(await assignmentUpdateTool.handler(ARGS, CTX));
    expect(payload.assignment.grades_released).toBe(true);
    expect(mocks.assignmentUpdate).toHaveBeenCalledWith('asg-q', { grades_released: true });
  });

  it('lets a TEACHER move a quiz assignment’s deadline, as the web calendar does', async () => {
    const payload = parse(
      await assignmentUpdateTool.handler(
        {
          classroom: ARGS.classroom,
          assignment_id: 'asg-q',
          student_deadline: '2026-07-21T23:59:00-04:00',
        },
        TEACHER_CTX
      )
    );
    expect(payload.assignment.student_deadline).toBe(
      new Date('2026-07-21T23:59:00-04:00').toISOString()
    );
  });
});

describe('assignment_update: the teacher tier depends on the assignment type', () => {
  const ARGS = { classroom: 'org/winter-2025', assignment_id: 'asg-1' };
  const RELEASE = '2026-07-06T09:00:00-04:00';
  const ROW = {
    id: 'asg-1',
    title: 'Row',
    module_id: 'mod-1',
    module: { id: 'mod-1', title: 'Week 1', classroom_id: 'class-1' },
    student_deadline: null,
    weight: 100,
    grades_released: false,
    grader_deadline: null,
    release_at: null,
  };
  const QUIZ_ROW = { ...ROW, type: 'QUIZ', repository: null };
  const REPO_ROW = { ...ROW, type: 'REPO', repository: { classroom_id: 'class-1' } };
  const FORM_ROW = { ...ROW, type: 'FORM', repository: null };

  beforeEach(() => {
    mocks.quizzesVisible.mockResolvedValue(true);
    mocks.moduleFindById.mockResolvedValue({
      id: 'mod-2',
      title: 'Week 2',
      classroom_id: 'class-1',
    });
    mocks.assignmentMoveToModuleEnd.mockResolvedValue({ moved: true, fromModuleId: 'mod-1' });
    // Not an OWNER unless a case says so.
    mocks.membershipFindByClassroomAndUser.mockResolvedValue(null);
    mocks.assignmentUpdate.mockImplementation(
      async (id: string, data: Record<string, unknown>) => ({ ...ROW, id, ...data })
    );
  });

  it.each([
    ['weight', 40, 40],
    ['weight', 0, 0],
    ['release_at', RELEASE, new Date(RELEASE)],
    ['release_at', null, null],
    ['closes_at', '2026-07-28T23:59:00-04:00', new Date('2026-07-28T23:59:00-04:00')],
    ['closes_at', null, null],
    ['tokens_per_hour', 3, 3],
  ] as const)('lets a TEACHER set %s (%s) on a QUIZ assignment', async (field, value, written) => {
    mocks.assignmentFindById.mockResolvedValue(QUIZ_ROW);

    const payload = parse(
      await assignmentUpdateTool.handler({ ...ARGS, [field]: value }, TEACHER_CTX)
    );

    expect(payload.success).toBe(true);
    expect(mocks.assignmentUpdate).toHaveBeenCalledWith('asg-1', { [field]: written });
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
  });

  it('lets a TEACHER set a QUIZ assignment’s deadline, weight and opening together', async () => {
    mocks.assignmentFindById.mockResolvedValue(QUIZ_ROW);

    await assignmentUpdateTool.handler(
      { ...ARGS, student_deadline: '2026-07-21T23:59:00-04:00', weight: 15, release_at: RELEASE },
      TEACHER_CTX
    );
    expect(mocks.assignmentUpdate).toHaveBeenCalledWith('asg-1', {
      student_deadline: new Date('2026-07-21T23:59:00-04:00'),
      weight: 15,
      release_at: new Date(RELEASE),
    });
  });

  it.each([
    ['REPO', REPO_ROW],
    ['FORM', FORM_ROW],
  ] as const)(
    'refuses a TEACHER weight, release_at and tokens_per_hour on a %s assignment',
    async (_type, row) => {
      mocks.assignmentFindById.mockResolvedValue(row);

      for (const args of [{ weight: 40 }, { release_at: RELEASE }, { tokens_per_hour: 2 }]) {
        await expect(
          assignmentUpdateTool.handler({ ...ARGS, ...args }, TEACHER_CTX)
        ).rejects.toMatchObject({
          kind: 'forbidden',
          code: 'INSUFFICIENT_ROLE',
          message: `Only the classroom owner can update: ${Object.keys(args)[0]}`,
        });
      }
      expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
      expect(mocks.auditCreate).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['REPO', REPO_ROW],
    ['FORM', FORM_ROW],
  ] as const)('keeps module_id OWNER only on a %s assignment', async (_type, row) => {
    mocks.assignmentFindById.mockResolvedValue(row);

    await expect(
      assignmentUpdateTool.handler({ ...ARGS, module_id: 'mod-2', weight: 40 }, TEACHER_CTX)
    ).rejects.toMatchObject({ kind: 'forbidden', message: expect.stringMatching(/module_id/) });
    expect(mocks.assignmentMoveToModuleEnd).not.toHaveBeenCalled();
    expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
  });

  it('sends a TEACHER moving a QUIZ assignment to quiz_update, which a teacher may use', async () => {
    mocks.assignmentFindById.mockResolvedValue(QUIZ_ROW);

    await expect(
      assignmentUpdateTool.handler({ ...ARGS, module_id: 'mod-2', weight: 40 }, TEACHER_CTX)
    ).rejects.toMatchObject({
      kind: 'invalid_params',
      message: expect.stringMatching(/quiz_update module_id/),
    });
    expect(mocks.assignmentMoveToModuleEnd).not.toHaveBeenCalled();
    expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
  });

  it('keeps grader_deadline OWNER only on a QUIZ assignment', async () => {
    mocks.assignmentFindById.mockResolvedValue(QUIZ_ROW);

    await expect(
      assignmentUpdateTool.handler(
        { ...ARGS, grader_deadline: '2026-07-27T23:59:00-04:00' },
        TEACHER_CTX
      )
    ).rejects.toMatchObject({
      kind: 'forbidden',
      message: expect.stringMatching(/grader_deadline/),
    });
    expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
  });

  it('refuses a TEACHER on an assignment that is not in this classroom with not_found', async () => {
    mocks.assignmentFindById.mockResolvedValue({
      ...QUIZ_ROW,
      module: { id: 'mod-9', title: 'Elsewhere', classroom_id: 'OTHER-class' },
    });

    await expect(
      assignmentUpdateTool.handler({ ...ARGS, weight: 40 }, TEACHER_CTX)
    ).rejects.toMatchObject({ kind: 'not_found' });
    expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
  });

  it('accepts a weight of 0 on update and create, and refuses a negative one', () => {
    const update = z.object(assignmentUpdateTool.inputSchema);
    const create = z.object(assignmentCreateTool.inputSchema);
    const updateBase = {
      classroom: 'org/w26',
      assignment_id: '00000000-0000-4000-8000-000000000001',
    };
    const createBase = {
      classroom: 'org/w26',
      module_id: '00000000-0000-4000-8000-000000000002',
      repository_id: '00000000-0000-4000-8000-000000000003',
      title: 'Check-in',
    };
    expect(update.safeParse({ ...updateBase, weight: 0 }).success).toBe(true);
    expect(update.safeParse({ ...updateBase, weight: -1 }).success).toBe(false);
    expect(create.safeParse({ ...createBase, weight: 0 }).success).toBe(true);
    expect(create.safeParse({ ...createBase, weight: -1 }).success).toBe(false);
  });

  it('creates an assignment with a weight of 0 and keeps it 0', async () => {
    mocks.moduleFindById.mockResolvedValue({ id: 'mod-1', classroom_id: 'class-1' });
    mocks.repositoryFindById.mockResolvedValue({ id: 'repo-1', classroom_id: 'class-1' });
    mocks.assignmentCreate.mockImplementation(async (data: Record<string, unknown>) => ({
      id: 'asg-0',
      ...data,
    }));

    const payload = parse(
      await assignmentCreateTool.handler(
        {
          classroom: 'org/w26',
          module_id: 'mod-1',
          repository_id: 'repo-1',
          title: 'Check-in',
          weight: 0,
        },
        CTX
      )
    );
    expect((mocks.assignmentCreate.mock.calls[0][0] as { weight: number }).weight).toBe(0);
    expect(payload.assignment.weight).toBe(0);
  });

  it.each([
    ['REPO', REPO_ROW, 'closes_at is for quiz assignments: repos ignore a close date'],
    [
      'FORM',
      FORM_ROW,
      'closes_at is for quiz assignments: a form closes with form_update closes_at',
    ],
  ] as const)(
    'refuses closes_at on a %s assignment, for the owner too',
    async (_type, row, message) => {
      mocks.assignmentFindById.mockResolvedValue(row);

      await expect(
        assignmentUpdateTool.handler({ ...ARGS, closes_at: '2026-07-28T23:59:00-04:00' }, CTX)
      ).rejects.toMatchObject({ kind: 'invalid_params', message });
      expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
    }
  );

  it('lets the OWNER set tokens_per_hour on a REPO assignment and returns it', async () => {
    mocks.assignmentFindById.mockResolvedValue(REPO_ROW);

    const payload = parse(await assignmentUpdateTool.handler({ ...ARGS, tokens_per_hour: 2 }, CTX));
    expect(mocks.assignmentUpdate).toHaveBeenCalledWith('asg-1', { tokens_per_hour: 2 });
    expect(payload.assignment.tokens_per_hour).toBe(2);
    // A REPO row has no close date to report.
    expect(payload.assignment).not.toHaveProperty('closes_at');
  });

  it("lets the OWNER clear tokens_per_hour so the assignment follows the classroom's price", async () => {
    mocks.assignmentFindById.mockResolvedValue({ ...REPO_ROW, tokens_per_hour: 4 });

    const payload = parse(
      await assignmentUpdateTool.handler({ ...ARGS, tokens_per_hour: null }, CTX)
    );
    expect(mocks.assignmentUpdate).toHaveBeenCalledWith('asg-1', { tokens_per_hour: null });
    expect(payload.assignment.tokens_per_hour).toBeNull();
  });

  it('accepts null for tokens_per_hour in the update schema, and still refuses a negative', () => {
    const schema = z.object(assignmentUpdateTool.inputSchema);
    const args = {
      classroom: 'org/winter-2025',
      assignment_id: '11111111-1111-4111-8111-111111111111',
    };
    expect(schema.safeParse({ ...args, tokens_per_hour: null }).success).toBe(true);
    expect(schema.safeParse({ ...args, tokens_per_hour: 0 }).success).toBe(true);
    expect(schema.safeParse({ ...args, tokens_per_hour: -1 }).success).toBe(false);
  });

  it('returns a QUIZ assignment’s close date', async () => {
    mocks.assignmentFindById.mockResolvedValue(QUIZ_ROW);

    const payload = parse(
      await assignmentUpdateTool.handler(
        { ...ARGS, closes_at: '2026-07-28T23:59:00-04:00' },
        TEACHER_CTX
      )
    );
    expect(payload.assignment.closes_at).toBe(new Date('2026-07-28T23:59:00-04:00').toISOString());
  });

  it('says in the description what a teacher may set on a quiz assignment', () => {
    expect(assignmentUpdateTool.description).toContain(
      'on a quiz assignment student_deadline, weight, release_at, closes_at and tokens_per_hour'
    );
    expect(new TextEncoder().encode(assignmentUpdateTool.description).length).toBeLessThan(1500);
  });
});

describe('assignment_create and assignment_delete descriptions', () => {
  it('keep under the 1,500-byte connector limit', () => {
    for (const tool of [assignmentCreateTool, assignmentDeleteTool]) {
      expect(new TextEncoder().encode(tool.description).length, tool.name).toBeLessThan(1500);
    }
  });

  it('says a quiz assignment is not deleted here', () => {
    expect(assignmentDeleteTool.description).toContain('A quiz assignment is refused');
  });
});

describe('assignment_delete and a quiz assignment', () => {
  const QUIZ_ASSIGNMENT = {
    id: 'asg-q',
    title: 'Quiz 1',
    type: 'QUIZ',
    module: { id: 'mod-1', title: 'Week 1', classroom_id: 'class-1' },
    repository: null,
    git_repo_assignments: [],
  };
  const ARGS = { classroom: 'org/winter-2025', assignment_id: 'asg-q' };

  it('refuses it by name: it goes with its quiz, or moves with it', async () => {
    mocks.assignmentFindById.mockResolvedValue(QUIZ_ASSIGNMENT);
    mocks.quizzesVisible.mockResolvedValue(true);

    await expect(assignmentDeleteTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
      message:
        'A quiz’s assignment goes with the quiz: delete the quiz (quiz_delete), or move it to ' +
        'another module (quiz_update module_id).',
    });
    expect(mocks.assignmentDeleteById).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('answers not_found where the classroom shows no quizzes, or the row is elsewhere', async () => {
    mocks.assignmentFindById.mockResolvedValue(QUIZ_ASSIGNMENT);
    mocks.quizzesVisible.mockResolvedValue(false);
    await expect(assignmentDeleteTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
    });

    mocks.assignmentFindById.mockResolvedValue({
      ...QUIZ_ASSIGNMENT,
      module: { id: 'mod-9', title: 'Elsewhere', classroom_id: 'OTHER-class' },
    });
    mocks.quizzesVisible.mockResolvedValue(true);
    await expect(assignmentDeleteTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(mocks.assignmentDeleteById).not.toHaveBeenCalled();
  });
});
