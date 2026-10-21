/**
 * Unit tests for list_quiz_attempts: the teaching team's view of who has taken
 * a quiz. Only the service boundary is mocked; the counting-attempt selector
 * and the late-hours rule run for real (@classmoji/utils).
 *
 * The things that must hold: every rostered student is listed (so "who has not
 * started" has an answer), staff previews stay apart from students, the quiz
 * is resolved inside the authorized classroom (S1), the read is audited, and
 * no field of a joined user row leaks beyond id, login and name.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  quizFindById: vi.fn(),
  findUsersByRole: vi.fn(),
  netHours: vi.fn(),
  quizzesVisibleOrThrow: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    quiz: { findById: (...a: unknown[]) => mocks.quizFindById(...a) },
    classroomMembership: { findUsersByRole: (...a: unknown[]) => mocks.findUsersByRole(...a) },
    token: { netQuizExtensionHoursByStudent: (...a: unknown[]) => mocks.netHours(...a) },
    entitlement: { quizzesVisibleOrThrow: (...a: unknown[]) => mocks.quizzesVisibleOrThrow(...a) },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
  },
}));

const { listQuizAttemptsTool } = await import('../quizAttempts.ts');

const settings: Record<string, unknown> = {};
const CTX: ToolContext = {
  viewer: { userId: 'staff-1', clientId: 'c', scopes: new Set(['read']) },
  classroom: {
    classroomId: 'class-1',
    role: 'TEACHER',
    status: 'ACTIVE',
    membership: { id: 'm-1', role: 'TEACHER' },
    classroom: { settings },
  },
} as unknown as ToolContext;

const ARGS = { classroom: 'org/w26', quiz_id: 'quiz-1' };
const DEADLINE = new Date('2026-10-02T04:00:00Z');
const at = (iso: string) => new Date(iso);

/** A joined user row, with fields that must never leave. */
const user = (id: string, login: string, name: string) => ({
  id,
  login,
  name,
  email: `${login}@school.edu`,
  school_id: `school-${id}`,
});

const attempt = (
  id: string,
  userId: string,
  startedAt: string,
  completedAt: string | null,
  score: number | null,
  over: Record<string, unknown> = {}
) => ({
  id,
  user_id: userId,
  started_at: at(startedAt),
  completed_at: completedAt ? at(completedAt) : null,
  partial_credit_percentage: score,
  first_attempt_percentage: score,
  total_duration_ms: null,
  unfocused_duration_ms: null,
  user: user(userId, `login-${userId}`, `Name ${userId}`),
  ...over,
});

const quiz = (attempts: unknown[], over: Record<string, unknown> = {}) => ({
  id: 'quiz-1',
  classroom_id: 'class-1',
  name: 'HTML quiz',
  grading_strategy: 'HIGHEST',
  max_attempts: 2,
  assignment: { id: 'asg-1', student_deadline: DEADLINE },
  attempts,
  ...over,
});

const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  for (const key of Object.keys(settings)) delete settings[key];
  mocks.quizzesVisibleOrThrow.mockResolvedValue(true);
  mocks.auditCreate.mockResolvedValue(undefined);
  mocks.netHours.mockResolvedValue(new Map());
  mocks.findUsersByRole.mockResolvedValue([
    { id: 'ada', login: 'ada', name: 'Ada Lovelace' },
    { id: 'bo', login: 'bo', name: 'Bo Diddley' },
    { id: 'cy', login: 'cy', name: 'Cy Young' },
  ]);
});

describe('list_quiz_attempts', () => {
  it('is for the teaching team, as a read', () => {
    expect(listQuizAttemptsTool.roles).toEqual(['OWNER', 'TEACHER', 'ASSISTANT']);
    expect(listQuizAttemptsTool.scope).toBe('read');
  });

  it('lists every rostered student, including those who have not started', async () => {
    mocks.quizFindById.mockResolvedValue(
      quiz([attempt('a1', 'ada', '2026-10-01T10:00:00Z', '2026-10-01T10:30:00Z', 80)])
    );

    const payload = parse(await listQuizAttemptsTool.handler(ARGS, CTX));

    expect(payload.students.map((s: { student: { login: string } }) => s.student.login)).toEqual([
      'ada',
      'bo',
      'cy',
    ]);
    expect(payload.students.map((s: { status: string }) => s.status)).toEqual([
      'COMPLETED',
      'NOT_STARTED',
      'NOT_STARTED',
    ]);
    expect(payload.students[1]).toMatchObject({
      attempts: [],
      counting_attempt_id: null,
      current_score: null,
      counted_score: null,
    });
  });

  it('marks the attempt that counts under the grading strategy, newest attempt first', async () => {
    mocks.quizFindById.mockResolvedValue(
      quiz([
        attempt('first', 'ada', '2026-10-01T10:00:00Z', '2026-10-01T10:30:00Z', 90),
        attempt('second', 'ada', '2026-10-01T12:00:00Z', '2026-10-01T12:30:00Z', 60),
      ])
    );

    const [ada] = parse(await listQuizAttemptsTool.handler(ARGS, CTX)).students;

    expect(ada.attempts.map((a: { id: string }) => a.id)).toEqual(['second', 'first']);
    expect(ada.counting_attempt_id).toBe('first');
    expect(ada.attempts.map((a: { is_counting: boolean }) => a.is_counting)).toEqual([false, true]);
    expect(ada.current_score).toBe(90);
  });

  it('reports a running attempt as IN_PROGRESS with nothing counting yet', async () => {
    mocks.quizFindById.mockResolvedValue(
      quiz([attempt('a1', 'bo', '2026-10-01T10:00:00Z', null, null)])
    );

    const students = parse(await listQuizAttemptsTool.handler(ARGS, CTX)).students;

    expect(students[1]).toMatchObject({ status: 'IN_PROGRESS', counting_attempt_id: null });
  });

  it('charges the late penalty to counted_score and keeps current_score raw', async () => {
    settings.late_penalty_points_per_hour = 10;
    // Two hours past the deadline, with one hour bought: one late hour.
    mocks.netHours.mockResolvedValue(new Map([['ada', 1]]));
    mocks.quizFindById.mockResolvedValue(
      quiz([attempt('a1', 'ada', '2026-10-02T05:00:00Z', '2026-10-02T06:30:00Z', 80)])
    );

    const [ada] = parse(await listQuizAttemptsTool.handler(ARGS, CTX)).students;

    expect(ada.attempts[0].late_hours).toBe(1);
    expect(ada.current_score).toBe(80);
    expect(ada.counted_score).toBe(70);
  });

  it('keeps staff previews apart from students and never calls them late', async () => {
    mocks.quizFindById.mockResolvedValue(
      quiz([attempt('p1', 'staff-1', '2026-10-03T10:00:00Z', '2026-10-03T11:00:00Z', 100)])
    );

    const payload = parse(await listQuizAttemptsTool.handler(ARGS, CTX));

    expect(payload.students.every((s: { attempts: unknown[] }) => s.attempts.length === 0)).toBe(
      true
    );
    expect(payload.staff_previews).toHaveLength(1);
    expect(payload.staff_previews[0].student.id).toBe('staff-1');
    expect(payload.staff_previews[0].attempts[0].late_hours).toBe(0);
  });

  it('derives the focus percentage the review page shows', async () => {
    mocks.quizFindById.mockResolvedValue(
      quiz([
        attempt('a1', 'ada', '2026-10-01T10:00:00Z', '2026-10-01T10:30:00Z', 80, {
          total_duration_ms: 1_000_000n,
          unfocused_duration_ms: 250_000n,
        }),
      ])
    );

    const [ada] = parse(await listQuizAttemptsTool.handler(ARGS, CTX)).students;

    expect(ada.attempts[0].focus_percentage).toBe(75);
  });

  it('sends only an id, a login and a name for each person', async () => {
    mocks.quizFindById.mockResolvedValue(
      quiz([attempt('a1', 'ada', '2026-10-01T10:00:00Z', '2026-10-01T10:30:00Z', 80)])
    );

    const result = await listQuizAttemptsTool.handler(ARGS, CTX);

    const text = result.content[0].text;
    expect(text).not.toContain('@school.edu');
    expect(text).not.toContain('school-ada');
    expect(parse(result).students[0].student).toEqual({
      id: 'ada',
      login: 'ada',
      name: 'Ada Lovelace',
    });
  });

  it('refuses a quiz of another classroom exactly like an unknown one', async () => {
    mocks.quizFindById.mockResolvedValue(quiz([], { classroom_id: 'other-class' }));
    await expect(listQuizAttemptsTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
    });

    mocks.quizFindById.mockResolvedValue(null);
    await expect(listQuizAttemptsTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('is refused where the classroom shows no quizzes', async () => {
    mocks.quizzesVisibleOrThrow.mockResolvedValue(false);

    await expect(listQuizAttemptsTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'forbidden',
    });
    expect(mocks.quizFindById).not.toHaveBeenCalled();
  });

  it('audits the read as a VIEW of the quiz', async () => {
    mocks.quizFindById.mockResolvedValue(quiz([]));

    await listQuizAttemptsTool.handler(ARGS, CTX);

    expect(mocks.auditCreate.mock.calls[0][0]).toMatchObject({
      user_id: 'staff-1',
      classroom_id: 'class-1',
      role: 'TEACHER',
      resource_id: 'quiz-1',
      action: 'VIEW',
      data: { tool: 'quiz.attempts.view', mcp_tool: 'list_quiz_attempts', students: 3 },
    });
  });

  it('asks for the hours bought only when the quiz has a due date', async () => {
    mocks.quizFindById.mockResolvedValue(quiz([], { assignment: null }));

    await listQuizAttemptsTool.handler(ARGS, CTX);

    expect(mocks.netHours).not.toHaveBeenCalled();
  });
});
