/**
 * Unit tests for the grade tools.
 *
 * grade_add reads what it changed from HelperService.addGradeToGitRepoAssignment,
 * which answers, from inside its transaction, the grade rows it removed and
 * the one it created, and reports `deduplicated` when no new row was made.
 * The audit row of each change is the service's (helper.gradeAudit tests in
 * @classmoji/services): the tools pass the caller as the actor and write no
 * row of their own.
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
    audit: WRITTEN,
  });
  mocks.removeGradeFromGitRepoAssignment.mockResolvedValue({ removed: true, audit: WRITTEN });
  mocks.auditCreate.mockResolvedValue(undefined);
});

/** The service wrote the call's row. */
const WRITTEN = { written: 1, missed: 0 };
/** The call changed nothing: no row owed. */
const NONE = { written: 0, missed: 0 };

/** The actor every grade tool passes for CTX's caller. */
const actorFor = (tool: string) => ({
  userId: 'ta-1',
  role: 'ASSISTANT',
  tool,
  impersonatedBy: null,
  clientId: 'c',
  via: 'mcp',
});

describe('grade_add', () => {
  it('reports deduplicated:true and writes no row when the call changed nothing', async () => {
    mocks.findById.mockResolvedValue(gra([{ id: 'g-old', emoji: '🟢' }]));
    mocks.addGradeToGitRepoAssignment.mockResolvedValue({
      removed: [],
      created: null,
      audit: NONE,
    });
    mocks.findByAssignmentId.mockResolvedValue([
      { id: 'g-old', emoji: '🟢', grader: { login: 'ta' } },
    ]);

    const payload = parse(await gradeAddTool.handler(ARGS, CTX));
    expect(payload.success).toBe(true);
    expect(payload.deduplicated).toBe(true);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(CTX.auditIncomplete).toBeUndefined();
  });

  it('grades as the caller and passes the caller as the actor, writing no row itself', async () => {
    mocks.findById.mockResolvedValue(gra([]));
    mocks.findByAssignmentId.mockResolvedValue([]);

    await gradeAddTool.handler(ARGS, CTX);
    expect(mocks.addGradeToGitRepoAssignment).toHaveBeenCalledExactlyOnceWith({
      classroom: { id: 'class-1' },
      gitRepoAssignment: { id: 'gra-1' },
      graderId: 'ta-1',
      grade: '🟢',
      studentId: 'student-1',
      teamId: undefined,
      actor: actorFor('grade_add'),
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('marks the call when the service could not write its row', async () => {
    mocks.findById.mockResolvedValue(gra([]));
    mocks.findByAssignmentId.mockResolvedValue([]);
    mocks.addGradeToGitRepoAssignment.mockResolvedValue({
      removed: [],
      created: { id: 'g-new', emoji: '🟢' },
      audit: { written: 0, missed: 1 },
    });
    const ctx = { ...CTX } as ToolContext;

    const payload = parse(await gradeAddTool.handler(ARGS, ctx));
    expect(payload).toMatchObject({ success: true, deduplicated: false });
    expect(ctx.auditIncomplete).toBe(true);
  });

  it('writes no row for the second of two racing identical calls, whatever it read before', async () => {
    // Both calls read the submission before either committed; the second
    // waited for the submission lock, found the grade already there and
    // changed nothing.
    mocks.findByClassroomId.mockResolvedValue(['score-70', 'score-80'].map(emoji => ({ emoji })));
    mocks.findById.mockResolvedValue(gra([{ id: 'g-mine', emoji: 'score-70', grader_id: 'ta-1' }]));
    mocks.addGradeToGitRepoAssignment.mockResolvedValue({
      removed: [],
      created: null,
      audit: NONE,
    });
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
      audit: WRITTEN,
    });
    mocks.findByAssignmentId.mockResolvedValue([
      { id: 'g-new', emoji: '🟢', grader: { login: 'ta' } },
    ]);

    const payload = parse(await gradeAddTool.handler(ARGS, CTX));
    expect(payload.success).toBe(true);
    expect(payload.deduplicated).toBe(false);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('reports deduplicated:false on a plain first-time grade', async () => {
    mocks.findById.mockResolvedValue(gra([]));
    mocks.findByAssignmentId.mockResolvedValue([
      { id: 'g-new', emoji: '🟢', grader: { login: 'ta' } },
    ]);

    const payload = parse(await gradeAddTool.handler(ARGS, CTX));
    expect(payload.deduplicated).toBe(false);
  });

  it('reports deduplicated when a grade went although the emoji was already there', async () => {
    // The caller's pre-regrade grade was cleared while another grader's equal
    // grade stayed: `deduplicated`, though the grades changed (the service
    // records that change).
    mocks.findById.mockResolvedValue(
      gra([
        { id: 'g-other', emoji: '🟢', grader_id: 'ta-2' },
        { id: 'g-mine', emoji: '🔴', grader_id: 'ta-1' },
      ])
    );
    mocks.addGradeToGitRepoAssignment.mockResolvedValue({
      removed: [{ id: 'g-mine', emoji: '🔴', grader_id: 'ta-1' }],
      created: null,
      audit: WRITTEN,
    });
    mocks.findByAssignmentId.mockResolvedValue([
      { id: 'g-other', emoji: '🟢', grader: { login: 'ta2' } },
    ]);

    const payload = parse(await gradeAddTool.handler(ARGS, CTX));
    expect(payload.deduplicated).toBe(true);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('grades (and so records, in the service) before reading the grades back', async () => {
    mocks.findById.mockResolvedValue(gra([]));
    mocks.findByAssignmentId.mockRejectedValue(new Error('db down'));

    await expect(gradeAddTool.handler(ARGS, CTX)).rejects.toThrow('db down');
    expect(mocks.addGradeToGitRepoAssignment).toHaveBeenCalledTimes(1);
  });
});

// ─── U9: grade_remove_all audits every completed removal ─────────────────────

describe('grade_remove_all per-grade audit (U9)', () => {
  const REMOVE_ARGS = { classroom: 'org/winter-2025', git_repo_assignment_id: 'gra-1' };

  beforeEach(() => {
    mocks.findById.mockResolvedValue(gra([]));
  });

  /** The grade ids the tool asked the service to remove. */
  const removalsAsked = () =>
    mocks.removeGradeFromGitRepoAssignment.mock.calls.map(
      c => (c[0] as { grade: { id: string } }).grade.id
    );

  it('removes each grade through the service, as the caller, and returns the removed count', async () => {
    mocks.findByAssignmentId.mockResolvedValue([
      { id: 'g1', emoji: '🟢' },
      { id: 'g2', emoji: '🔴' },
      { id: 'g3', emoji: '🟡' },
    ]);

    const payload = parse(await gradeRemoveAllTool.handler(REMOVE_ARGS, CTX));
    expect(payload.removed_count).toBe(3);
    // One service call per grade, each recording its own row for the actor.
    expect(removalsAsked()).toEqual(['g1', 'g2', 'g3']);
    for (const [arg] of mocks.removeGradeFromGitRepoAssignment.mock.calls) {
      expect(arg).toMatchObject({ actor: actorFor('grade_remove_all') });
    }
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('counts and audits only the grades this call removed', async () => {
    mocks.findByAssignmentId.mockResolvedValue([
      { id: 'g1', emoji: '🟢' },
      { id: 'g2', emoji: '🔴' },
      { id: 'g3', emoji: '🟡' },
    ]);
    // g2 was already gone when its removal ran: nothing changed for it.
    mocks.removeGradeFromGitRepoAssignment
      .mockResolvedValueOnce({ removed: true, audit: WRITTEN })
      .mockResolvedValueOnce({ removed: false, audit: NONE })
      .mockResolvedValueOnce({ removed: true, audit: WRITTEN });
    const ctx = { ...CTX } as ToolContext;

    const payload = parse(await gradeRemoveAllTool.handler(REMOVE_ARGS, ctx));
    expect(payload.removed_count).toBe(2);
    expect(ctx.auditIncomplete).toBeUndefined();
  });

  it('marks the call when any one removal could not be recorded', async () => {
    mocks.findByAssignmentId.mockResolvedValue([
      { id: 'g1', emoji: '🟢' },
      { id: 'g2', emoji: '🔴' },
    ]);
    mocks.removeGradeFromGitRepoAssignment
      .mockResolvedValueOnce({ removed: true, audit: { written: 0, missed: 1 } })
      .mockResolvedValueOnce({ removed: true, audit: WRITTEN });
    const ctx = { ...CTX } as ToolContext;

    const payload = parse(await gradeRemoveAllTool.handler(REMOVE_ARGS, ctx));
    expect(payload.removed_count).toBe(2);
    expect(ctx.auditIncomplete).toBe(true);
  });

  it('still audits the completed removals when the loop throws partway', async () => {
    mocks.findByAssignmentId.mockResolvedValue([
      { id: 'g1', emoji: '🟢' },
      { id: 'g2', emoji: '🔴' },
    ]);
    // First removal succeeds (and the service records it); the second throws.
    mocks.removeGradeFromGitRepoAssignment
      .mockResolvedValueOnce({ removed: true, audit: WRITTEN })
      .mockRejectedValueOnce(new Error('boom'));

    await expect(gradeRemoveAllTool.handler(REMOVE_ARGS, CTX)).rejects.toThrow('boom');
    // Each removal is its own service call, recorded as it lands: the first
    // one's row was written before the failure — not stranded.
    expect(removalsAsked()).toEqual(['g1', 'g2']);
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
      expect.objectContaining({
        gitRepoAssignment: { id: NUMERIC_ID },
        actor: actorFor('grade_add'),
      })
    );
  });

  it('grade_remove matches the grade to the numeric submission', async () => {
    mocks.findById.mockResolvedValue(numericGra([]));
    mocks.gradeFindById.mockResolvedValue({
      id: GRADE_ID,
      emoji: '🟢',
      git_repo_assignment_id: NUMERIC_ID,
    });
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
    expect(mocks.removeGradeFromGitRepoAssignment).toHaveBeenCalledWith(
      expect.objectContaining({
        gitRepoAssignment: expect.objectContaining({ id: NUMERIC_ID }),
        actor: actorFor('grade_remove'),
      })
    );
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('grade_remove reports a grade that was already removed', async () => {
    mocks.findById.mockResolvedValue(numericGra([]));
    mocks.gradeFindById.mockResolvedValue({
      id: GRADE_ID,
      emoji: '🟢',
      git_repo_assignment_id: NUMERIC_ID,
    });
    mocks.removeGradeFromGitRepoAssignment.mockResolvedValue({ removed: false, audit: NONE });

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
