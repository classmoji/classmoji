/**
 * Unit tests for regrade_create idempotency (finding F1).
 *
 * A slow `request_regrade` run can materialize its RegradeRequest only AFTER
 * the 60s client poll times out; a client retry would then enqueue a second
 * run → duplicate IN_REVIEW rows + duplicate grader emails. The tool now checks
 * regradeRequest.findOpenByAssignmentId for THIS student before triggering: an
 * existing open request is returned idempotently WITHOUT a second trigger.
 *
 * `@classmoji/services` and `@trigger.dev/sdk` are mocked (factory idiom); the
 * trigger spy asserts zero enqueues on the idempotent path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  findOpenByAssignmentId: vi.fn(),
  findMany: vi.fn(),
  auditCreate: vi.fn(),
  trigger: vi.fn(),
  retrieve: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    gitRepoAssignment: { findById: (...a: unknown[]) => mocks.findById(...a) },
    regradeRequest: {
      findOpenByAssignmentId: (...a: unknown[]) => mocks.findOpenByAssignmentId(...a),
      findMany: (...a: unknown[]) => mocks.findMany(...a),
    },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
  },
}));

vi.mock('@trigger.dev/sdk', () => ({
  tasks: { trigger: (...a: unknown[]) => mocks.trigger(...a) },
  runs: { retrieve: (...a: unknown[]) => mocks.retrieve(...a) },
}));

const { regradeCreateTool } = await import('../regrades.ts');

const CTX: ToolContext = {
  viewer: { userId: 'student-1', clientId: 'c', scopes: new Set(['read', 'write']) },
  classroom: {
    classroomId: 'class-1',
    role: 'STUDENT',
    status: 'ACTIVE',
    membership: { id: 'm-1', role: 'STUDENT' },
    classroom: { settings: {} },
  },
} as unknown as ToolContext;

const ARGS = {
  classroom: 'org/winter-2025',
  git_repo_assignment_id: 'gra-1',
  comment: 'please regrade',
};

/** GitRepoAssignment record for an individual submission owned by student-1. */
const GRA = {
  id: 'gra-1',
  git_repo: { classroom_id: 'class-1', student_id: 'student-1' },
  grades: [{ emoji: '🎯' }, { emoji: '✅' }],
};

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.findById.mockResolvedValue(GRA);
  mocks.auditCreate.mockResolvedValue(undefined);
});

describe('regrade_create idempotency (F1)', () => {
  it('returns an existing IN_REVIEW request WITHOUT triggering a second run', async () => {
    mocks.findOpenByAssignmentId.mockResolvedValue({
      id: 'rr-existing',
      status: 'IN_REVIEW',
      previous_grade: ['🎯', '✅'],
      student_id: 'student-1',
    });

    const result = await regradeCreateTool.handler(ARGS, CTX);
    const payload = parse(result);

    expect(payload.success).toBe(true);
    expect(payload.regrade_request.id).toBe('rr-existing');
    expect(payload.regrade_request.status).toBe('IN_REVIEW');
    // The whole point of F1: no second enqueue (and thus no duplicate email).
    expect(mocks.trigger).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('triggers exactly one run when no open request exists yet', async () => {
    mocks.findOpenByAssignmentId.mockResolvedValue(null);
    mocks.trigger.mockResolvedValue({ id: 'run-1' });
    mocks.retrieve.mockResolvedValue({
      status: 'COMPLETED',
      output: { id: 'rr-new', status: 'IN_REVIEW', previous_grade: ['🎯', '✅'] },
    });

    const result = await regradeCreateTool.handler(ARGS, CTX);
    const payload = parse(result);

    expect(mocks.trigger).toHaveBeenCalledTimes(1);
    expect(mocks.trigger).toHaveBeenCalledWith(
      'request_regrade',
      expect.objectContaining({
        classroom_id: 'class-1',
        student_id: 'student-1',
        previous_grade: ['🎯', '✅'],
      })
    );
    expect(payload.regrade_request.id).toBe('rr-new');
  });
});
