/**
 * Unit tests for the mirrored read tools (tools/reads.ts).
 *
 * Three things are pinned here:
 *   1. NO-DRIFT (the central requirement): a pure mirror tool and its resource
 *      produce byte-identical payloads (get_leaderboard vs the leaderboard
 *      resource), and list_submissions' per-submission rows are IDENTICAL to the
 *      grading-queue resource's `all` rows (shared queueRow shaping).
 *   2. list_submissions filters (repository_id / assignment_id / grader_id /
 *      status) applied in-memory over the raw rows.
 *   3. list_teaching_team aggregation: staff only, one row per user with a
 *      `roles[]` array; STUDENT rows excluded.
 *
 * `@classmoji/services` is mocked (factory idiom) so the real handler logic runs
 * against hand-built rows. Role-gating itself is enforced by the registry (not
 * the handlers) and is covered by the integration matrix, not here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolError } from '../../mcp/errors.ts';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  findByClassroomId: vi.fn(), // gitRepoAssignment.findByClassroomId
  findEmojiByClassroomId: vi.fn(), // emojiMapping.findByClassroomId
  findAssignedByGrader: vi.fn(), // gitRepoAssignmentGrader.findAssignedByGrader
  gradingReport: vi.fn(), // gitRepoAssignmentGrader.gradingReport
  findBySlug: vi.fn(), // classroom.findBySlug
  calculateClassLeaderboard: vi.fn(), // helper.calculateClassLeaderboard
  membershipsByClassroom: vi.fn(), // classroomMembership.findByClassroomId
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    gitRepoAssignment: { findByClassroomId: (...a: unknown[]) => mocks.findByClassroomId(...a) },
    emojiMapping: { findByClassroomId: (...a: unknown[]) => mocks.findEmojiByClassroomId(...a) },
    gitRepoAssignmentGrader: {
      findAssignedByGrader: (...a: unknown[]) => mocks.findAssignedByGrader(...a),
      gradingReport: (...a: unknown[]) => mocks.gradingReport(...a),
    },
    classroom: { findBySlug: (...a: unknown[]) => mocks.findBySlug(...a) },
    helper: {
      calculateClassLeaderboard: (...a: unknown[]) => mocks.calculateClassLeaderboard(...a),
    },
    classroomMembership: {
      findByClassroomId: (...a: unknown[]) => mocks.membershipsByClassroom(...a),
    },
  },
}));

const { listSubmissionsTool, getLeaderboardTool, listTeachingTeamTool, gradingReportTool } =
  await import('../reads.ts');
const { gradingQueueResource, leaderboardResource } = await import('../../resources/grading.ts');

const CLASSROOM = 'test-org/winter-2025';

/** ctx as the registry hands it to a role-gated handler. */
function staffCtx(role: 'OWNER' | 'ASSISTANT' = 'ASSISTANT'): ToolContext {
  return {
    viewer: { userId: 'staff-1', clientId: 'c', scopes: new Set(['read']) },
    classroom: {
      classroomId: 'class-1',
      role,
      status: 'ACTIVE',
      membership: { id: 'm-1', role },
      classroom: { slug: 'winter-2025', git_organization: { login: 'test-org' }, settings: {} },
    },
  } as unknown as ToolContext;
}

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

/** Two submissions with distinct repository/assignment/grader/status. */
function seededSubmissions() {
  return [
    {
      id: 'gra-open',
      status: 'OPEN',
      assignment: { id: 'a-1', title: 'HW1', grades_released: false },
      git_repo: {
        id: 'r-1',
        repository_id: 'repo-1',
        repository: { id: 'repo-1', title: 'Lab 1' },
        student: { id: 'stu-1', login: 'stu1', name: 'Student One', image: null },
        team: null,
      },
      grades: [{ id: 'grade-1', emoji: '🟢' }],
      graders: [{ grader: { id: 'grader-x', name: 'Grader X' } }],
    },
    {
      id: 'gra-closed',
      status: 'CLOSED',
      assignment: { id: 'a-2', title: 'HW2', grades_released: true },
      git_repo: {
        id: 'r-2',
        repository_id: 'repo-2',
        repository: { id: 'repo-2', title: 'Lab 2' },
        student: null,
        team: { id: 'team-1', name: 'Team Alpha' },
      },
      grades: [],
      graders: [{ grader: { id: 'grader-y', name: 'Grader Y' } }],
    },
  ];
}

const EMOJI_SCALE = [{ emoji: '🟢', grade: 100, extra_tokens: 0, description: 'Great' }];

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.findByClassroomId.mockResolvedValue(seededSubmissions());
  mocks.findEmojiByClassroomId.mockResolvedValue(EMOJI_SCALE);
  mocks.findAssignedByGrader.mockResolvedValue([]);
});

describe('list_submissions', () => {
  it('returns every submission with the emoji scale and no filters', async () => {
    const payload = parse(await listSubmissionsTool.handler({ classroom: CLASSROOM }, staffCtx()));
    expect(payload.count).toBe(2);
    expect(payload.total_matched).toBe(2);
    expect(payload.truncated).toBe(false);
    expect(payload.emoji_scale).toEqual(EMOJI_SCALE);
    expect(payload.submissions.map((s: { id: string }) => s.id)).toEqual([
      'gra-open',
      'gra-closed',
    ]);
    // The returned id is the GitRepoAssignment id (what grade_add consumes).
    expect(payload.submissions[0].id).toBe('gra-open');
  });

  it('filters by repository_id, assignment_id, grader_id and status', async () => {
    const byRepo = parse(
      await listSubmissionsTool.handler(
        { classroom: CLASSROOM, repository_id: 'repo-2' },
        staffCtx()
      )
    );
    expect(byRepo.submissions.map((s: { id: string }) => s.id)).toEqual(['gra-closed']);

    const byAssignment = parse(
      await listSubmissionsTool.handler({ classroom: CLASSROOM, assignment_id: 'a-1' }, staffCtx())
    );
    expect(byAssignment.submissions.map((s: { id: string }) => s.id)).toEqual(['gra-open']);

    const byGrader = parse(
      await listSubmissionsTool.handler({ classroom: CLASSROOM, grader_id: 'grader-y' }, staffCtx())
    );
    expect(byGrader.submissions.map((s: { id: string }) => s.id)).toEqual(['gra-closed']);

    const byStatus = parse(
      await listSubmissionsTool.handler({ classroom: CLASSROOM, status: 'OPEN' }, staffCtx())
    );
    expect(byStatus.submissions.map((s: { id: string }) => s.id)).toEqual(['gra-open']);
  });

  it('honors limit and reports truncation', async () => {
    const payload = parse(
      await listSubmissionsTool.handler({ classroom: CLASSROOM, limit: 1 }, staffCtx())
    );
    expect(payload.count).toBe(1);
    expect(payload.total_matched).toBe(2);
    expect(payload.truncated).toBe(true);
  });

  it('NO-DRIFT: per-submission rows are identical to the grading-queue resource', async () => {
    const tool = parse(await listSubmissionsTool.handler({ classroom: CLASSROOM }, staffCtx()));
    const resource = (await gradingQueueResource.handler(
      { org: 'test-org', slug: 'winter-2025' },
      staffCtx(),
      new URL('classmoji://x')
    )) as { all: unknown[]; emoji_scale: unknown };
    // Same queueRow shaping + same emoji-scale shaping, by construction.
    expect(tool.submissions).toEqual(resource.all);
    expect(tool.emoji_scale).toEqual(resource.emoji_scale);
  });
});

describe('get_leaderboard', () => {
  beforeEach(() => {
    mocks.findBySlug.mockResolvedValue({ id: 'class-1' });
    mocks.calculateClassLeaderboard.mockResolvedValue([
      { id: 'stu-1', name: 'Student One', login: 'stu1', grade: 88, avatar_url: null },
    ]);
  });

  it('NO-DRIFT: the tool payload is byte-identical to the leaderboard resource', async () => {
    const resourcePayload = await leaderboardResource.handler(
      { org: 'test-org', slug: 'winter-2025' },
      staffCtx('OWNER'),
      new URL('classmoji://x')
    );
    const toolResult = await getLeaderboardTool.handler(
      { classroom: CLASSROOM },
      staffCtx('OWNER')
    );
    expect(toolResult.content[0].text).toBe(JSON.stringify(resourcePayload, null, 2));
    expect(parse(toolResult).count).toBe(1);
  });

  it('preserves the twin-classroom guard (bare slug resolves elsewhere → refuse)', async () => {
    mocks.findBySlug.mockResolvedValue({ id: 'a-different-classroom' });
    // The handler throws; the registry (not the handler) maps it to isError, so
    // here we assert the thrown ToolError directly (mirrors content.test.ts).
    const err = await getLeaderboardTool
      .handler({ classroom: CLASSROOM }, staffCtx('OWNER'))
      .catch(e => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).kind).toBe('internal');
    // Guard fires BEFORE any leaderboard computation.
    expect(mocks.calculateClassLeaderboard).not.toHaveBeenCalled();
  });
});

describe('list_teaching_team', () => {
  it('returns staff only, one row per user with an aggregated roles[] array', async () => {
    mocks.membershipsByClassroom.mockResolvedValue([
      { role: 'OWNER', user: { id: 'u1', login: 'prof', name: 'Prof' } },
      { role: 'ASSISTANT', user: { id: 'u1', login: 'prof', name: 'Prof' } }, // same user, 2nd role
      { role: 'TEACHER', user: { id: 'u2', login: 'tt', name: 'Teach' } },
      { role: 'STUDENT', user: { id: 'u3', login: 'stu', name: 'Student' } }, // excluded
    ]);

    const payload = parse(await listTeachingTeamTool.handler({ classroom: CLASSROOM }, staffCtx()));
    expect(payload.count).toBe(2);

    const byId = Object.fromEntries(
      (payload.members as Array<{ id: string; roles: string[] }>).map(m => [m.id, m])
    );
    expect(byId.u1.roles).toEqual(['OWNER', 'ASSISTANT']);
    expect(byId.u2.roles).toEqual(['TEACHER']);
    expect(byId.u3).toBeUndefined(); // students are not teaching team
    // Only id/login/name/roles — no PII (email/school_id) or avatar.
    expect(Object.keys(byId.u1).sort()).toEqual(['id', 'login', 'name', 'roles']);
  });
});

describe('grading_report', () => {
  const GRADER_ID = '33333333-3333-4333-8333-333333333333';
  const ASSIGNMENT_ID = '44444444-4444-4444-8444-444444444444';

  function reportRows() {
    return [
      {
        grader: { id: 'g-1', login: 'ta-ann', name: 'Ann' },
        assignment: { id: 'a-1', title: 'HW1', repository_title: 'Lab 1' },
        assigned_count: 5,
        graded_count: 3,
        grade_distribution: { '🟢': 2, '🟡': 1 },
        last_graded_at: new Date('2026-08-20T15:04:05.000Z'),
      },
      {
        grader: { id: 'g-1', login: 'ta-ann', name: 'Ann' },
        assignment: { id: 'a-2', title: 'HW2', repository_title: 'Lab 2' },
        assigned_count: 0, // graded without ever being formally assigned
        graded_count: 1,
        grade_distribution: { '🟢': 1 },
        last_graded_at: null,
      },
      {
        grader: { id: 'g-2', login: 'ta-bob', name: 'Bob' },
        assignment: { id: 'a-1', title: 'HW1', repository_title: 'Lab 1' },
        assigned_count: 4,
        graded_count: 4,
        grade_distribution: { '🔴': 4 },
        last_graded_at: new Date('2026-08-21T09:00:00.000Z'),
      },
    ];
  }

  it('summarizes the rows and serializes last_graded_at to ISO', async () => {
    mocks.gradingReport.mockResolvedValue(reportRows());

    const payload = parse(
      await gradingReportTool.handler({ classroom: CLASSROOM }, staffCtx('OWNER'))
    );
    expect(payload.total_rows).toBe(3);
    expect(payload.graders).toBe(2); // DISTINCT graders, not row count

    expect(payload.rows[0]).toMatchObject({
      assigned_count: 5,
      graded_count: 3,
      grade_distribution: { '🟢': 2, '🟡': 1 },
      last_graded_at: '2026-08-20T15:04:05.000Z',
    });
    // A grader who graded without being assigned is kept, with assigned_count 0.
    expect(payload.rows[1]).toMatchObject({ assigned_count: 0, graded_count: 1 });
    expect(payload.rows[1].last_graded_at).toBeNull();

    // classroomId comes from ctx; absent filters are passed as explicit nulls.
    expect(mocks.gradingReport).toHaveBeenCalledWith({
      classroomId: 'class-1',
      assignmentId: null,
      graderId: null,
    });
  });

  it('passes the assignment_id / grader_id filters straight through', async () => {
    mocks.gradingReport.mockResolvedValue([]);

    await gradingReportTool.handler(
      { classroom: CLASSROOM, assignment_id: ASSIGNMENT_ID, grader_id: GRADER_ID },
      staffCtx('OWNER')
    );

    expect(mocks.gradingReport).toHaveBeenCalledWith({
      classroomId: 'class-1',
      assignmentId: ASSIGNMENT_ID,
      graderId: GRADER_ID,
    });
  });

  it('returns an empty report (not an error) when nothing matches the filters', async () => {
    mocks.gradingReport.mockResolvedValue([]);

    const payload = parse(
      await gradingReportTool.handler(
        { classroom: CLASSROOM, grader_id: GRADER_ID },
        staffCtx('OWNER')
      )
    );
    expect(payload).toEqual({ total_rows: 0, graders: 0, rows: [] });
  });

  it('is gated to OWNER/TEACHER — assistants must not read peers grading stats', () => {
    expect(gradingReportTool.roles).toEqual(['OWNER', 'TEACHER']);
    expect(gradingReportTool.scope).toBe('read');
  });
});
