/**
 * Unit tests for grade_add's `deduplicated` flag (finding U4).
 *
 * HelperService.addGradeToGitRepoAssignment returns void and silently either
 * (a) no-ops when the same emoji already exists (true dedup) or (b) on an
 * open regrade request CLEARS the stale grade and mints a FRESH row for the
 * same emoji (regrade-replace — a real mutation). The tool used to report
 * `deduplicated: true` for both, misreporting (b) as a no-op. It must compare
 * the grade-row id before/after: dedup only when the pre-existing row itself
 * survived.
 *
 * `@classmoji/services` is mocked (factory idiom); the orchestrator's effect
 * is simulated through the post-call findByAssignmentId snapshot.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  findByClassroomId: vi.fn(),
  findByAssignmentId: vi.fn(),
  addGradeToGitRepoAssignment: vi.fn(),
  removeGradeFromGitRepoAssignment: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    gitRepoAssignment: { findById: (...a: unknown[]) => mocks.findById(...a) },
    emojiMapping: { findByClassroomId: (...a: unknown[]) => mocks.findByClassroomId(...a) },
    assignmentGrade: { findByAssignmentId: (...a: unknown[]) => mocks.findByAssignmentId(...a) },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
  },
  HelperService: {
    addGradeToGitRepoAssignment: (...a: unknown[]) => mocks.addGradeToGitRepoAssignment(...a),
    removeGradeFromGitRepoAssignment: (...a: unknown[]) =>
      mocks.removeGradeFromGitRepoAssignment(...a),
  },
}));

const { gradeAddTool, gradeRemoveAllTool } = await import('../grades.ts');

const CTX: ToolContext = {
  viewer: { userId: 'ta-1', clientId: 'c', scopes: new Set(['read', 'write']) },
  classroom: {
    classroomId: 'class-1',
    role: 'ASSISTANT',
    status: 'ACTIVE',
    membership: { id: 'm-1', role: 'ASSISTANT' },
    classroom: { settings: {} },
  },
} as unknown as ToolContext;

const ARGS = { classroom: 'org/winter-2025', git_repo_assignment_id: 'gra-1', emoji: '🟢' };

function gra(grades: Array<{ id: string; emoji: string }>) {
  return {
    id: 'gra-1',
    git_repo: { classroom_id: 'class-1', student_id: 'student-1', team_id: null },
    grades,
  };
}

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.findByClassroomId.mockResolvedValue([{ emoji: '🟢' }, { emoji: '🔴' }]);
  mocks.addGradeToGitRepoAssignment.mockResolvedValue(undefined);
  mocks.auditCreate.mockResolvedValue(undefined);
});

describe('grade_add deduplicated flag (U4)', () => {
  it('reports deduplicated:true only when the pre-existing grade row survived (true no-op)', async () => {
    mocks.findById.mockResolvedValue(gra([{ id: 'g-old', emoji: '🟢' }]));
    // Orchestrator no-oped: the SAME row is still there afterwards.
    mocks.findByAssignmentId.mockResolvedValue([
      { id: 'g-old', emoji: '🟢', grader: { login: 'ta' } },
    ]);

    const payload = parse(await gradeAddTool.handler(ARGS, CTX));
    expect(payload.success).toBe(true);
    expect(payload.deduplicated).toBe(true);
  });

  it('reports deduplicated:false on the regrade-replace path (stale row cleared, fresh row minted)', async () => {
    mocks.findById.mockResolvedValue(gra([{ id: 'g-old', emoji: '🟢' }]));
    // Open regrade request: the orchestrator cleared g-old and minted g-new
    // for the same emoji — a real mutation, not a dedup.
    mocks.findByAssignmentId.mockResolvedValue([
      { id: 'g-new', emoji: '🟢', grader: { login: 'ta' } },
    ]);

    const payload = parse(await gradeAddTool.handler(ARGS, CTX));
    expect(payload.success).toBe(true);
    expect(payload.deduplicated).toBe(false);
  });

  it('reports deduplicated:false on a plain first-time grade', async () => {
    mocks.findById.mockResolvedValue(gra([]));
    mocks.findByAssignmentId.mockResolvedValue([
      { id: 'g-new', emoji: '🟢', grader: { login: 'ta' } },
    ]);

    const payload = parse(await gradeAddTool.handler(ARGS, CTX));
    expect(payload.deduplicated).toBe(false);
  });
});

// ─── U9: grade_remove_all audits every completed removal ─────────────────────

describe('grade_remove_all per-grade audit (U9)', () => {
  const REMOVE_ARGS = { classroom: 'org/winter-2025', git_repo_assignment_id: 'gra-1' };

  beforeEach(() => {
    mocks.findById.mockResolvedValue(gra([]));
  });

  it('writes one audit row per grade and returns the removed count', async () => {
    mocks.findByAssignmentId.mockResolvedValue([
      { id: 'g1', emoji: '🟢' },
      { id: 'g2', emoji: '🔴' },
      { id: 'g3', emoji: '🟡' },
    ]);
    mocks.removeGradeFromGitRepoAssignment.mockResolvedValue(undefined);

    const payload = parse(await gradeRemoveAllTool.handler(REMOVE_ARGS, CTX));
    expect(payload.removed_count).toBe(3);
    expect(mocks.auditCreate).toHaveBeenCalledTimes(3);
    // Each audit row carries the specific grade id it removed.
    const auditedGradeIds = mocks.auditCreate.mock.calls.map(
      c => (c[0] as { data: { grade_id: string } }).data.grade_id
    );
    expect(auditedGradeIds).toEqual(['g1', 'g2', 'g3']);
  });

  it('still audits the completed removals when the loop throws partway', async () => {
    mocks.findByAssignmentId.mockResolvedValue([
      { id: 'g1', emoji: '🟢' },
      { id: 'g2', emoji: '🔴' },
    ]);
    // First removal succeeds and is audited; the second throws.
    mocks.removeGradeFromGitRepoAssignment
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('boom'));

    await expect(gradeRemoveAllTool.handler(REMOVE_ARGS, CTX)).rejects.toThrow('boom');
    // The completed first removal was audited before the failure — not stranded.
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(
      (mocks.auditCreate.mock.calls[0][0] as { data: { grade_id: string } }).data.grade_id
    ).toBe('g1');
  });
});
