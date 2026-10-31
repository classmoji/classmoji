/**
 * Regrade request rows (list_regrade_requests / my_regrade_requests and their
 * resources) with quiz targets.
 *
 * Held here: a quiz request names its quiz and attempt and states every grade
 * as an emoji on the classroom's scale, never a number (E6); an adjusted
 * attempt shows its own emoji and the AI's original; the staff reply
 * (grader_comment) reaches the student who asked; new_grade is null while a
 * request is open; quiz requests are left out where the classroom shows no
 * quizzes (`regradeRequest.findManyForDisplay`, emulated here over the same
 * predicate); the student's list is read for the caller only; a resolved quiz
 * request's new_grade is its own snapshot (`resolved_emoji`); the staff queue
 * carries an open quiz request's late_hours and counted_emoji.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  quizzesVisibleOrThrow: vi.fn(),
  findScaleByClassroomId: vi.fn(),
  lateness: vi.fn(),
}));

vi.mock('@classmoji/database', async () =>
  (await import('../../__tests__/prismaSchemaStub.ts')).databaseModuleMock()
);

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    regradeRequest: {
      // The service's rule: scoped to the classroom, quiz rows only where the
      // classroom shows quizzes (asked only when there is one).
      findManyForDisplay: async (classroomId: string, query: Record<string, unknown>) => {
        const rows = (await mocks.findMany({ ...query, classroom_id: classroomId })) as Array<{
          quiz_attempt: unknown;
        }>;
        if (!rows.some(r => r.quiz_attempt)) return rows;
        return (await mocks.quizzesVisibleOrThrow(classroomId))
          ? rows
          : rows.filter(r => !r.quiz_attempt);
      },
      openQuizRequestLateness: (...a: unknown[]) => mocks.lateness(...a),
    },
    entitlement: { quizzesVisibleOrThrow: (...a: unknown[]) => mocks.quizzesVisibleOrThrow(...a) },
    emojiMapping: {
      findScaleByClassroomId: (...a: unknown[]) => mocks.findScaleByClassroomId(...a),
    },
  },
}));

const { regradeQueueResource, regradeMineResource } = await import('../grading.ts');
const { listRegradeRequestsTool, myRegradeRequestsTool } = await import('../../tools/reads.ts');

const SCALE = { rocket: 100, '+1': 90, eyes: 80, '-1': 60, sob: 0 };
const VARS = { org: 'org', slug: 'w26' };
const URI = new URL('classmoji://org/w26/regrade-requests');

const ctx = (role: 'TEACHER' | 'STUDENT', userId = role === 'STUDENT' ? 'stu-1' : 'staff-1') =>
  ({
    viewer: { userId, clientId: 'c', scopes: new Set(['read']) },
    classroom: {
      classroomId: 'class-1',
      role,
      status: 'ACTIVE',
      membership: { id: 'm-1', role },
      classroom: { settings: {}, git_organization: null },
    },
  }) as unknown as ToolContext;

const student = { id: 'stu-1', name: 'Ada', image: null, email: 'ada@school.edu', accounts: [] };

const repoRequest = {
  id: 'rr-repo',
  status: 'IN_REVIEW',
  student_comment: 'Tests pass now',
  grader_comment: null,
  previous_grade: ['-1'],
  created_at: new Date('2026-10-20T10:00:00Z'),
  student,
  git_repo_assignment: {
    id: 'gra-1',
    assignment: { title: 'Lab 1' },
    git_repo: { name: 'lab-1-ada', repository: { title: 'Labs' } },
    grades: [{ id: 'g1', emoji: '-1' }],
  },
  quiz_attempt: null,
};

const quizRequest = (over: Record<string, unknown> = {}) => ({
  id: 'rr-quiz',
  status: 'APPROVED',
  student_comment: 'Q3 was ambiguous',
  grader_comment: 'Fair point, adjusted.',
  previous_grade: ['-1'],
  created_at: new Date('2026-10-20T11:00:00Z'),
  student,
  git_repo_assignment: null,
  quiz_attempt: {
    id: 'att-2',
    user_id: 'stu-1',
    attempt_number: 2,
    partial_credit_percentage: 62,
    adjusted_emoji: 'rocket',
    instructor_comment: 'Fair point.',
    quiz: {
      id: 'quiz-1',
      name: 'Quiz 1',
      classroom_id: 'class-1',
      assignment: { id: 'asg-1', title: 'Week 3 quiz' },
    },
  },
  ...over,
});

/** Every [key, value] in a JSON value, at any depth. */
const entriesOf = (value: unknown): Array<[string, unknown]> =>
  Array.isArray(value)
    ? value.flatMap(entriesOf)
    : value && typeof value === 'object' && !(value instanceof Date)
      ? Object.entries(value).flatMap(([k, v]) => [[k, v] as [string, unknown], ...entriesOf(v)])
      : [];

type Rows = { count: number; requests: Array<Record<string, unknown>> };

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.quizzesVisibleOrThrow.mockResolvedValue(true);
  mocks.findScaleByClassroomId.mockResolvedValue(SCALE);
  mocks.lateness.mockResolvedValue(new Map());
});

describe('list_regrade_requests with quiz requests', () => {
  it('names the quiz and attempt and states every grade as an emoji', async () => {
    mocks.findMany.mockResolvedValue([quizRequest(), repoRequest]);

    const rows = (await regradeQueueResource.handler(VARS, ctx('TEACHER'), URI)) as Rows;

    expect(mocks.findMany).toHaveBeenCalledWith({ classroom_id: 'class-1' });
    expect(mocks.findScaleByClassroomId).toHaveBeenCalledWith('class-1');
    expect(rows.count).toBe(2);
    expect(rows.requests[0]).toMatchObject({
      id: 'rr-quiz',
      status: 'APPROVED',
      target: 'quiz',
      student_comment: 'Q3 was ambiguous',
      grader_comment: 'Fair point, adjusted.',
      previous_grade: ['-1'],
      new_grade: ['rocket'],
      submission: null,
      quiz: {
        quiz_id: 'quiz-1',
        quiz_name: 'Quiz 1',
        assignment_title: 'Week 3 quiz',
        attempt_id: 'att-2',
        attempt_number: 2,
        current_emoji: 'rocket',
        adjusted: true,
        original_emoji: '-1',
      },
    });
    // The repo row: unchanged shape, plus target, reply and new_grade (null while open).
    expect(rows.requests[1]).toMatchObject({
      id: 'rr-repo',
      target: 'submission',
      grader_comment: null,
      new_grade: null,
      quiz: null,
      submission: { id: 'gra-1', current_grades: [{ id: 'g1', emoji: '-1' }] },
    });
    for (const [key, value] of entriesOf(rows.requests)) {
      if (key !== 'attempt_number') expect(typeof value, key).not.toBe('number');
      expect(key).not.toMatch(/percentage|score/);
    }
  });

  it('leaves quiz requests out where the classroom shows no quizzes', async () => {
    mocks.findMany.mockResolvedValue([quizRequest(), repoRequest]);
    mocks.quizzesVisibleOrThrow.mockResolvedValue(false);

    const rows = (await regradeQueueResource.handler(VARS, ctx('TEACHER'), URI)) as Rows;

    expect(rows.count).toBe(1);
    expect(rows.requests.map(r => r.id)).toEqual(['rr-repo']);
  });

  it('asks nothing about quizzes when no request is a quiz request', async () => {
    mocks.findMany.mockResolvedValue([repoRequest]);
    await regradeQueueResource.handler(VARS, ctx('TEACHER'), URI);
    expect(mocks.quizzesVisibleOrThrow).not.toHaveBeenCalled();
    expect(mocks.findScaleByClassroomId).not.toHaveBeenCalled();
  });

  it('gives an open quiz request no new grade yet, and its lateness as the modal shows it', async () => {
    mocks.findMany.mockResolvedValue([quizRequest({ status: 'IN_REVIEW', grader_comment: null })]);
    mocks.lateness.mockResolvedValue(
      new Map([['rr-quiz', { lateHours: 3, countedEmoji: 'eyes' }]])
    );
    const rows = (await regradeQueueResource.handler(VARS, ctx('TEACHER'), URI)) as Rows;
    expect(rows.requests[0]).toMatchObject({
      status: 'IN_REVIEW',
      new_grade: null,
      quiz: { late_hours: 3, counted_emoji: 'eyes' },
    });
    expect(mocks.lateness).toHaveBeenCalledWith('class-1', expect.any(Array), SCALE);
  });

  it("states a resolved quiz request's new grade from its own snapshot", async () => {
    // Resolved to 👀; adjusted again directly afterwards to 🚀.
    mocks.findMany.mockResolvedValue([quizRequest({ resolved_emoji: 'eyes' })]);
    const rows = (await regradeQueueResource.handler(VARS, ctx('TEACHER'), URI)) as Rows;
    expect(rows.requests[0]).toMatchObject({
      new_grade: ['eyes'],
      quiz: { current_emoji: 'rocket' },
    });
  });
});

describe('my_regrade_requests with quiz requests', () => {
  it("reads the caller's own requests, with the staff reply", async () => {
    mocks.findMany.mockResolvedValue([quizRequest()]);

    const rows = (await regradeMineResource.handler(VARS, ctx('STUDENT'), URI)) as Rows;

    expect(mocks.findMany).toHaveBeenCalledWith({ classroom_id: 'class-1', student_id: 'stu-1' });
    // The student's list carries no staff lateness read.
    expect(mocks.lateness).not.toHaveBeenCalled();
    expect(rows.requests[0]).toMatchObject({
      target: 'quiz',
      grader_comment: 'Fair point, adjusted.',
      quiz: { quiz_name: 'Quiz 1', attempt_number: 2, current_emoji: 'rocket' },
    });
    // Nothing about which staff member adjusted it, and no contact field.
    const text = JSON.stringify(rows);
    expect(text).not.toContain('adjusted_by');
    expect(text).not.toContain('ada@school.edu');
  });

  it('names who resolved the request and when, from the request (not the attempt)', async () => {
    mocks.findMany.mockResolvedValue([
      quizRequest({
        resolved_by: { id: 'ta-9', name: 'Grace Hopper' },
        resolved_at: new Date('2026-10-21T09:00:00Z'),
        quiz_attempt: {
          ...quizRequest().quiz_attempt,
          adjusted_by: { id: 'x', name: 'Someone Else' },
        },
      }),
      {
        ...repoRequest,
        status: 'DENIED',
        resolved_by: { id: 'ta-8', name: 'Alan Turing' },
        resolved_at: new Date('2026-10-21T08:00:00Z'),
      },
    ]);
    const rows = (await regradeMineResource.handler(VARS, ctx('STUDENT'), URI)) as Rows;
    expect(rows.requests[0]).toMatchObject({
      resolved_by_name: 'Grace Hopper',
      resolved_at: new Date('2026-10-21T09:00:00Z'),
    });
    expect(rows.requests[1]).toMatchObject({ resolved_by_name: 'Alan Turing' });
    const text = JSON.stringify(rows);
    expect(text).not.toContain('Someone Else');
    // A name only: no staff id reaches the student.
    expect(text).not.toContain('ta-9');
  });

  it('shows no name on a request resolved before the resolver was recorded', async () => {
    mocks.findMany.mockResolvedValue([quizRequest({ resolved_by: null, resolved_at: null })]);
    const rows = (await regradeMineResource.handler(VARS, ctx('STUDENT'), URI)) as Rows;
    expect(rows.requests[0]).toMatchObject({ resolved_by_name: null, resolved_at: null });
  });

  it('states no emoji where the classroom has no scale', async () => {
    mocks.findScaleByClassroomId.mockResolvedValue({});
    mocks.findMany.mockResolvedValue([
      quizRequest({ quiz_attempt: { ...quizRequest().quiz_attempt, adjusted_emoji: null } }),
    ]);
    const rows = (await regradeMineResource.handler(VARS, ctx('STUDENT'), URI)) as Rows;
    expect(rows.requests[0]).toMatchObject({ new_grade: [], quiz: { current_emoji: null } });
  });
});

describe('regrade read tool descriptions', () => {
  it('stay under 1,500 bytes and name the quiz target', () => {
    for (const tool of [listRegradeRequestsTool, myRegradeRequestsTool]) {
      expect(Buffer.byteLength(tool.description, 'utf8'), tool.name).toBeLessThan(1500);
      expect(tool.description, tool.name).toContain('quiz');
    }
  });
});
