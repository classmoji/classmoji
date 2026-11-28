/**
 * Unit tests for the grade tools.
 *
 * grade_add reads what it changed from HelperService.addGradeToGitRepoAssignment,
 * which answers, from inside its transaction, the grade rows it removed and
 * the one it created. The tool records a row only when the call created or
 * removed something (a repeat, or the second of two identical calls racing on
 * the submission lock, changed nothing), names the caller's own removed grades
 * as `replaced`, and reports `deduplicated` when no new row was made.
 *
 * `@classmoji/services` is mocked (factory idiom).
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
    audit: {
      create: (...a: unknown[]) => mocks.auditCreate(...a),
      record: (row: unknown) =>
        import('../../__tests__/support/auditRecord.ts').then(m =>
          m.recordThrough(r => mocks.auditCreate(r))(row)
        ),
    },
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

function gra(grades: Array<{ id: string; emoji: string; grader_id?: string }>) {
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
  mocks.addGradeToGitRepoAssignment.mockResolvedValue({
    removed: [],
    created: { id: 'g-new', emoji: '🟢' },
  });
  mocks.auditCreate.mockResolvedValue(undefined);
});

describe('grade_add', () => {
  it('reports deduplicated:true and writes no row when the call changed nothing', async () => {
    mocks.findById.mockResolvedValue(gra([{ id: 'g-old', emoji: '🟢' }]));
    mocks.addGradeToGitRepoAssignment.mockResolvedValue({ removed: [], created: null });
    mocks.findByAssignmentId.mockResolvedValue([
      { id: 'g-old', emoji: '🟢', grader: { login: 'ta' } },
    ]);

    const payload = parse(await gradeAddTool.handler(ARGS, CTX));
    expect(payload.success).toBe(true);
    expect(payload.deduplicated).toBe(true);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('writes no row for the second of two racing identical calls, whatever it read before', async () => {
    // Both calls read the submission before either committed; the second
    // waited for the submission lock, found the grade already there and
    // changed nothing.
    mocks.findByClassroomId.mockResolvedValue(['score-70', 'score-80'].map(emoji => ({ emoji })));
    mocks.findById.mockResolvedValue(gra([{ id: 'g-mine', emoji: 'score-70', grader_id: 'ta-1' }]));
    mocks.addGradeToGitRepoAssignment.mockResolvedValue({ removed: [], created: null });
    mocks.findByAssignmentId.mockResolvedValue([
      { id: 'g-first', emoji: 'score-80', grader_id: 'ta-1' },
    ]);

    const payload = parse(await gradeAddTool.handler({ ...ARGS, emoji: 'score-80' }, CTX));
    expect(payload.deduplicated).toBe(true);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('reports deduplicated:false on the regrade-replace path (stale row cleared, fresh row minted)', async () => {
    mocks.findById.mockResolvedValue(gra([{ id: 'g-old', emoji: '🟢', grader_id: 'ta-2' }]));
    mocks.addGradeToGitRepoAssignment.mockResolvedValue({
      removed: [{ id: 'g-old', emoji: '🟢', grader_id: 'ta-2' }],
      created: { id: 'g-new', emoji: '🟢' },
    });
    mocks.findByAssignmentId.mockResolvedValue([
      { id: 'g-new', emoji: '🟢', grader: { login: 'ta' } },
    ]);

    const payload = parse(await gradeAddTool.handler(ARGS, CTX));
    expect(payload.success).toBe(true);
    expect(payload.deduplicated).toBe(false);
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    // Another grader's cleared grade is not the caller's to have replaced.
    const { data } = mocks.auditCreate.mock.calls[0][0];
    expect(data).toMatchObject({ tool: 'grade_add', emoji: '🟢' });
    expect(data).not.toHaveProperty('replaced');
  });

  it('reports deduplicated:false on a plain first-time grade', async () => {
    mocks.findById.mockResolvedValue(gra([]));
    mocks.addGradeToGitRepoAssignment.mockResolvedValue({
      removed: [],
      created: { id: 'g-new', emoji: '🟢' },
    });
    mocks.findByAssignmentId.mockResolvedValue([
      { id: 'g-new', emoji: '🟢', grader: { login: 'ta' } },
    ]);

    const payload = parse(await gradeAddTool.handler(ARGS, CTX));
    expect(payload.deduplicated).toBe(false);
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate.mock.calls[0][0].data).not.toHaveProperty('replaced');
  });

  it('records a change when a grade went although the emoji was already there', async () => {
    // The caller's pre-regrade grade was cleared while another grader's equal
    // grade stayed: `deduplicated`, but the grades changed, so it is recorded.
    mocks.findById.mockResolvedValue(
      gra([
        { id: 'g-other', emoji: '🟢', grader_id: 'ta-2' },
        { id: 'g-mine', emoji: '🔴', grader_id: 'ta-1' },
      ])
    );
    mocks.addGradeToGitRepoAssignment.mockResolvedValue({
      removed: [{ id: 'g-mine', emoji: '🔴', grader_id: 'ta-1' }],
      created: null,
    });
    mocks.findByAssignmentId.mockResolvedValue([
      { id: 'g-other', emoji: '🟢', grader: { login: 'ta2' } },
    ]);

    const payload = parse(await gradeAddTool.handler(ARGS, CTX));
    expect(payload.deduplicated).toBe(true);
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate.mock.calls[0][0].data).toMatchObject({
      tool: 'grade_add',
      emoji: '🟢',
      replaced: ['🔴'],
    });
  });

  it('records the score a numeric re-grade replaced, as an array', async () => {
    const scale = ['score-70', 'score-80', 'score-90'].map(emoji => ({ emoji }));
    mocks.findByClassroomId.mockResolvedValue(scale);
    mocks.findById.mockResolvedValue(
      gra([
        { id: 'g-mine', emoji: 'score-70', grader_id: 'ta-1' },
        { id: 'g-other', emoji: 'score-90', grader_id: 'ta-2' },
      ])
    );
    mocks.addGradeToGitRepoAssignment.mockResolvedValue({
      removed: [{ id: 'g-mine', emoji: 'score-70', grader_id: 'ta-1' }],
      created: { id: 'g-new', emoji: 'score-80' },
    });
    mocks.findByAssignmentId.mockResolvedValue([
      { id: 'g-other', emoji: 'score-90', grader_id: 'ta-2' },
      { id: 'g-new', emoji: 'score-80', grader_id: 'ta-1' },
    ]);

    await gradeAddTool.handler({ ...ARGS, emoji: 'score-80' }, CTX);

    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate.mock.calls[0][0]).toMatchObject({
      resource_type: 'GIT_REPO_ASSIGNMENT',
      resource_id: 'gra-1',
      action: 'CREATE',
      data: { tool: 'grade_add', emoji: 'score-80', replaced: ['score-70'] },
    });
  });

  it('records the grade before reading the grades back, so a failed read leaves it recorded', async () => {
    mocks.findById.mockResolvedValue(gra([]));
    mocks.addGradeToGitRepoAssignment.mockResolvedValue({
      removed: [],
      created: { id: 'g-new', emoji: '🟢' },
    });
    mocks.findByAssignmentId.mockRejectedValue(new Error('db down'));

    await expect(gradeAddTool.handler(ARGS, CTX)).rejects.toThrow('db down');
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
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
    mocks.removeGradeFromGitRepoAssignment.mockResolvedValue(true);

    const payload = parse(await gradeRemoveAllTool.handler(REMOVE_ARGS, CTX));
    expect(payload.removed_count).toBe(3);
    expect(mocks.auditCreate).toHaveBeenCalledTimes(3);
    // Each audit row carries the specific grade id it removed.
    const auditedGradeIds = mocks.auditCreate.mock.calls.map(
      c => (c[0] as { data: { grade_id: string } }).data.grade_id
    );
    expect(auditedGradeIds).toEqual(['g1', 'g2', 'g3']);
  });

  it('counts and audits only the grades this call removed', async () => {
    mocks.findByAssignmentId.mockResolvedValue([
      { id: 'g1', emoji: '🟢' },
      { id: 'g2', emoji: '🔴' },
      { id: 'g3', emoji: '🟡' },
    ]);
    // g2 was already gone when its removal ran: nothing changed for it.
    mocks.removeGradeFromGitRepoAssignment
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const payload = parse(await gradeRemoveAllTool.handler(REMOVE_ARGS, CTX));
    expect(payload.removed_count).toBe(2);
    const auditedGradeIds = mocks.auditCreate.mock.calls.map(
      c => (c[0] as { data: { grade_id: string } }).data.grade_id
    );
    expect(auditedGradeIds).toEqual(['g1', 'g3']);
  });

  it('still audits the completed removals when the loop throws partway', async () => {
    mocks.findByAssignmentId.mockResolvedValue([
      { id: 'g1', emoji: '🟢' },
      { id: 'g2', emoji: '🔴' },
    ]);
    // First removal succeeds and is audited; the second throws.
    mocks.removeGradeFromGitRepoAssignment
      .mockResolvedValueOnce(true)
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
    mocks.removeGradeFromGitRepoAssignment.mockResolvedValue(true);

    const payload = parse(
      await gradeRemoveTool.handler(
        { classroom: 'org/winter-2025', git_repo_assignment_id: NUMERIC_ID, grade_id: GRADE_ID },
        CTX
      )
    );
    expect(payload).toMatchObject({
      success: true,
      removed: { id: GRADE_ID },
      already_removed: false,
    });
    expect(mocks.auditCreate.mock.calls[0][0]).toMatchObject({ resource_id: NUMERIC_ID });
  });

  it('grade_remove writes no audit row when the grade was already removed', async () => {
    mocks.findById.mockResolvedValue(numericGra([]));
    mocks.gradeFindById.mockResolvedValue({
      id: GRADE_ID,
      emoji: '🟢',
      git_repo_assignment_id: NUMERIC_ID,
    });
    mocks.removeGradeFromGitRepoAssignment.mockResolvedValue(false);

    const payload = parse(
      await gradeRemoveTool.handler(
        { classroom: 'org/winter-2025', git_repo_assignment_id: NUMERIC_ID, grade_id: GRADE_ID },
        CTX
      )
    );
    expect(payload).toMatchObject({
      success: true,
      removed: { id: GRADE_ID },
      already_removed: true,
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('grade_remove_all clears the numeric submission', async () => {
    mocks.findById.mockResolvedValue(numericGra([]));
    mocks.findByAssignmentId.mockResolvedValue([{ id: 'g1', emoji: '🟢' }]);
    mocks.removeGradeFromGitRepoAssignment.mockResolvedValue(true);

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
