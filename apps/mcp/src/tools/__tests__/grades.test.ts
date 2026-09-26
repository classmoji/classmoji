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
import type { z } from 'zod';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  findByClassroomId: vi.fn(),
  findByAssignmentId: vi.fn(),
  gradeFindById: vi.fn(),
  addGradeToGitRepoAssignment: vi.fn(),
  removeGradeFromGitRepoAssignment: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    gitRepoAssignment: { findById: (...a: unknown[]) => mocks.findById(...a) },
    emojiMapping: { findByClassroomId: (...a: unknown[]) => mocks.findByClassroomId(...a) },
    assignmentGrade: {
      findByAssignmentId: (...a: unknown[]) => mocks.findByAssignmentId(...a),
      findById: (...a: unknown[]) => mocks.gradeFindById(...a),
    },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
  },
  HelperService: {
    addGradeToGitRepoAssignment: (...a: unknown[]) => mocks.addGradeToGitRepoAssignment(...a),
    removeGradeFromGitRepoAssignment: (...a: unknown[]) =>
      mocks.removeGradeFromGitRepoAssignment(...a),
  },
}));

const { gradeAddTool, gradeRemoveTool, gradeRemoveAllTool } = await import('../grades.ts');

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

// ─── ISSUE-mode submissions: the id is the numeric GitHub issue id ──────────

describe('numeric submission ids (ISSUE mode: id == GitHub issue id)', () => {
  const NUMERIC_ID = '5482151816';
  const GRADE_ID = '33333333-3333-4333-8333-333333333333';

  function numericGra(grades: Array<{ id: string; emoji: string }>) {
    return { ...gra(grades), id: NUMERIC_ID };
  }

  it('every grade tool accepts a numeric submission id at the schema; grade_id stays a uuid', () => {
    for (const tool of [gradeAddTool, gradeRemoveTool, gradeRemoveAllTool]) {
      const field = tool.inputSchema.git_repo_assignment_id as z.ZodTypeAny;
      expect(field.safeParse(NUMERIC_ID).success, tool.name).toBe(true);
      expect(field.safeParse('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').success, tool.name).toBe(true);
      expect(field.safeParse('gra-1').success, tool.name).toBe(false);
    }
    const gradeId = gradeRemoveTool.inputSchema.grade_id as z.ZodTypeAny;
    expect(gradeId.safeParse(NUMERIC_ID).success).toBe(false);
  });

  it('grade_add loads, grades and audits the numeric id unchanged', async () => {
    mocks.findById.mockResolvedValue(numericGra([]));
    mocks.findByAssignmentId.mockResolvedValue([
      { id: 'g-new', emoji: '🟢', grader: { login: 'ta' } },
    ]);

    const payload = parse(
      await gradeAddTool.handler({ ...ARGS, git_repo_assignment_id: NUMERIC_ID }, CTX)
    );
    expect(payload).toMatchObject({ success: true, git_repo_assignment_id: NUMERIC_ID });
    expect(mocks.findById).toHaveBeenCalledWith(NUMERIC_ID);
    expect(mocks.addGradeToGitRepoAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ gitRepoAssignment: { id: NUMERIC_ID } })
    );
    expect(mocks.auditCreate.mock.calls[0][0]).toMatchObject({ resource_id: NUMERIC_ID });
  });

  it('grade_remove matches the grade to the numeric submission', async () => {
    mocks.findById.mockResolvedValue(numericGra([]));
    mocks.gradeFindById.mockResolvedValue({
      id: GRADE_ID,
      emoji: '🟢',
      git_repo_assignment_id: NUMERIC_ID,
    });
    mocks.removeGradeFromGitRepoAssignment.mockResolvedValue(undefined);

    const payload = parse(
      await gradeRemoveTool.handler(
        { classroom: 'org/winter-2025', git_repo_assignment_id: NUMERIC_ID, grade_id: GRADE_ID },
        CTX
      )
    );
    expect(payload).toMatchObject({ success: true, removed: { id: GRADE_ID } });
    expect(mocks.auditCreate.mock.calls[0][0]).toMatchObject({ resource_id: NUMERIC_ID });
  });

  it('grade_remove_all clears the numeric submission', async () => {
    mocks.findById.mockResolvedValue(numericGra([]));
    mocks.findByAssignmentId.mockResolvedValue([{ id: 'g1', emoji: '🟢' }]);
    mocks.removeGradeFromGitRepoAssignment.mockResolvedValue(undefined);

    const payload = parse(
      await gradeRemoveAllTool.handler(
        { classroom: 'org/winter-2025', git_repo_assignment_id: NUMERIC_ID },
        CTX
      )
    );
    expect(payload.removed_count).toBe(1);
    expect(mocks.findByAssignmentId).toHaveBeenCalledWith(NUMERIC_ID);
  });

  it('a numeric id from another classroom is the uniform not_found', async () => {
    mocks.findById.mockResolvedValue({
      ...numericGra([]),
      git_repo: { classroom_id: 'class-2', student_id: 'student-1', team_id: null },
    });

    await expect(
      gradeAddTool.handler({ ...ARGS, git_repo_assignment_id: NUMERIC_ID }, CTX)
    ).rejects.toMatchObject({
      kind: 'not_found',
      message: 'Submission not found in this classroom',
    });
    expect(mocks.addGradeToGitRepoAssignment).not.toHaveBeenCalled();
  });
});
