/**
 * Unit tests for grader_assign_bulk.
 *
 * Security focus (S1): the assignment — and the EXISTING template assignment —
 * are resolved through repository.classroom_id BEFORE the service runs. This is
 * load-bearing rather than defensive: the service fetches submissions by
 * (assignmentId, classroomSlug), so a foreign or unknown assignment would
 * silently yield zero submissions and report "success, 0 assigned" instead of
 * not_found. Missing and cross-classroom therefore throw the SAME uniform
 * not_found, with zero service calls and no audit row.
 *
 * (graders.github.test.ts covers the single-submission tools' GitHub-first
 * failure mode against a mocked git layer; this file mocks @classmoji/services
 * with the factory idiom instead, so no Trigger.dev batch ever fires.)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  assignmentFindById: vi.fn(),
  assignGraders: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('@classmoji/services', () => {
  // Same shape as the real service error; the tool branches on `instanceof`.
  class AssignGradersError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'AssignGradersError';
      this.code = code;
    }
  }
  return {
    AssignGradersError,
    HelperService: {},
    ClassmojiService: {
      assignment: { findById: (...a: unknown[]) => mocks.assignmentFindById(...a) },
      gitRepoAssignmentGrader: {
        assignGradersToAssignment: (...a: unknown[]) => mocks.assignGraders(...a),
      },
      audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
    },
  };
});

const { AssignGradersError } = await import('@classmoji/services');
const { graderAssignBulkTool } = await import('../graders.ts');

const ASSIGNMENT_ID = '11111111-1111-4111-8111-111111111111';
const TEMPLATE_ID = '22222222-2222-4222-8222-222222222222';

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

/** An assignment row as loadAssignmentInClassroom sees it (repository chain). */
function assignmentIn(classroomId: string, id: string) {
  return { id, title: 'PS1', repository: { classroom_id: classroomId } };
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.auditCreate.mockResolvedValue(undefined);
  mocks.assignmentFindById.mockImplementation(async (id: string) => assignmentIn('class-1', id));
  mocks.assignGraders.mockResolvedValue({ numAssignmentsToAddGradersTo: 12 });
});

describe('grader_assign_bulk — RANDOM', () => {
  const ARGS = { classroom: 'org/w26', assignment_id: ASSIGNMENT_ID, method: 'RANDOM' as const };

  it('distributes graders via the service using ctx classroomId and audits the run', async () => {
    const payload = parse(await graderAssignBulkTool.handler(ARGS, CTX));
    expect(payload).toMatchObject({
      success: true,
      queued: true,
      submissions_assigned: 12,
      method: 'RANDOM',
    });

    // classroomId comes from ctx, never args; sessionId is omitted (it only
    // exists to tag runs for the web route's progress stream).
    expect(mocks.assignGraders).toHaveBeenCalledWith({
      classroomId: 'class-1',
      assignmentId: ASSIGNMENT_ID,
      method: 'RANDOM',
      templateAssignmentId: null,
    });
    expect(mocks.assignGraders.mock.calls[0][0]).not.toHaveProperty('sessionId');

    const audit = mocks.auditCreate.mock.calls[0][0] as {
      action: string;
      classroom_id: string;
      data: Record<string, unknown>;
    };
    expect(audit.action).toBe('CREATE');
    expect(audit.classroom_id).toBe('class-1');
    expect(audit.data).toMatchObject({
      tool: 'grader_assign_bulk',
      method: 'RANDOM',
      submissions_assigned: 12,
    });
  });

  it('maps no_graders to invalid_params and audits nothing', async () => {
    mocks.assignGraders.mockRejectedValue(
      new AssignGradersError('no_graders', '[assign-graders] no assistants with is_grader set')
    );

    await expect(graderAssignBulkTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('lets an unexpected service failure through for the generic wrapper', async () => {
    mocks.assignGraders.mockRejectedValue(new Error('boom'));
    await expect(graderAssignBulkTool.handler(ARGS, CTX)).rejects.toThrow('boom');
  });
});

describe('grader_assign_bulk — EXISTING', () => {
  const ARGS = {
    classroom: 'org/w26',
    assignment_id: ASSIGNMENT_ID,
    method: 'EXISTING' as const,
    template_assignment_id: TEMPLATE_ID,
  };

  it('passes the template through after classroom-verifying BOTH assignments', async () => {
    const payload = parse(await graderAssignBulkTool.handler(ARGS, CTX));
    expect(payload).toMatchObject({ success: true, method: 'EXISTING' });

    expect(mocks.assignmentFindById).toHaveBeenCalledWith(ASSIGNMENT_ID);
    expect(mocks.assignmentFindById).toHaveBeenCalledWith(TEMPLATE_ID);
    expect(mocks.assignGraders).toHaveBeenCalledWith({
      classroomId: 'class-1',
      assignmentId: ASSIGNMENT_ID,
      method: 'EXISTING',
      templateAssignmentId: TEMPLATE_ID,
    });
  });

  it('rejects a missing template up front — before any lookup or service call', async () => {
    const { template_assignment_id: _omitted, ...withoutTemplate } = ARGS;

    await expect(graderAssignBulkTool.handler(withoutTemplate, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
    });
    expect(mocks.assignmentFindById).not.toHaveBeenCalled();
    expect(mocks.assignGraders).not.toHaveBeenCalled();
  });

  it('rejects an assignment used as its own template — before any lookup', async () => {
    await expect(
      graderAssignBulkTool.handler({ ...ARGS, template_assignment_id: ASSIGNMENT_ID }, CTX)
    ).rejects.toMatchObject({
      kind: 'invalid_params',
      message: 'template_assignment_id must be a different assignment than assignment_id',
    });
    expect(mocks.assignmentFindById).not.toHaveBeenCalled();
    expect(mocks.assignGraders).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('maps the service template_required backstop to invalid_params', async () => {
    mocks.assignGraders.mockRejectedValue(
      new AssignGradersError('template_required', '[assign-graders] EXISTING requires a template')
    );

    await expect(graderAssignBulkTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
    });
  });

  it('refuses a template from ANOTHER classroom with the uniform not_found', async () => {
    mocks.assignmentFindById.mockImplementation(async (id: string) =>
      assignmentIn(id === TEMPLATE_ID ? 'class-2' : 'class-1', id)
    );

    await expect(graderAssignBulkTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
      message: 'Assignment not found in this classroom',
    });
    expect(mocks.assignGraders).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});

describe('grader_assign_bulk — S1 assignment scoping', () => {
  const ARGS = { classroom: 'org/w26', assignment_id: ASSIGNMENT_ID, method: 'RANDOM' as const };

  it('refuses an unknown assignment with zero service calls', async () => {
    mocks.assignmentFindById.mockResolvedValue(null);

    await expect(graderAssignBulkTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
      message: 'Assignment not found in this classroom',
    });
    expect(mocks.assignGraders).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("refuses another classroom's assignment with the SAME error (no existence leak)", async () => {
    mocks.assignmentFindById.mockImplementation(async (id: string) => assignmentIn('class-2', id));

    await expect(graderAssignBulkTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
      message: 'Assignment not found in this classroom',
    });
    expect(mocks.assignGraders).not.toHaveBeenCalled();
  });
});
