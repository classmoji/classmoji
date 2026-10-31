/**
 * Unit tests for list_quiz_attempts: the teaching team's view of who has taken
 * a quiz. Only the service boundary is mocked; the results page's row builder,
 * the counting-attempt selector, the late-hours and counted-zero rules and the
 * emoji scale run for real (@classmoji/utils).
 *
 * The things that must hold: every rostered student is listed (so "who has not
 * started" has an answer), staff previews and former members stay apart from
 * students, the quiz is resolved inside the authorized classroom (S1), the read
 * is audited, no field of a joined user or membership row leaks beyond id,
 * login and name, and grades leave as emoji on the classroom's scale only
 * (E6), never as numbers.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  quizFindById: vi.fn(),
  findByQuiz: vi.fn(),
  findUsersByRole: vi.fn(),
  findUsersByRoles: vi.fn(),
  netHours: vi.fn(),
  quizzesVisibleOrThrow: vi.fn(),
  auditCreate: vi.fn(),
  emojiScale: vi.fn(),
  userFindMany: vi.fn(),
}));

vi.mock('@classmoji/database', async () => ({
  ...(await vi.importActual<typeof import('@classmoji/database/gitIdentity')>(
    '@classmoji/database/gitIdentity'
  )),
  default: () => ({ user: { findMany: (...a: unknown[]) => mocks.userFindMany(...a) } }),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    quiz: { findById: (...a: unknown[]) => mocks.quizFindById(...a) },
    quizAttempt: { findByQuiz: (...a: unknown[]) => mocks.findByQuiz(...a) },
    classroomMembership: {
      findUsersByRole: (...a: unknown[]) => mocks.findUsersByRole(...a),
      findUsersByRoles: (...a: unknown[]) => mocks.findUsersByRoles(...a),
    },
    token: { netQuizExtensionHoursByStudent: (...a: unknown[]) => mocks.netHours(...a) },
    entitlement: { quizzesVisibleOrThrow: (...a: unknown[]) => mocks.quizzesVisibleOrThrow(...a) },
    emojiMapping: { findScaleByClassroomId: (...a: unknown[]) => mocks.emojiScale(...a) },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
  },
}));

const { listQuizAttemptsTool } = await import('../quizAttempts.ts');
const { toolAnnotations } = await import('../../mcp/registry.ts');

/** An emoji scale, as emojiMapping.findScaleByClassroomId returns it. */
const EMOJI_SCALE = { rocket: 100, '+1': 90, eyes: 80, '-1': 60, sob: 0 };
/** The numeric scale: score-0 … score-100 in tens, as ensureDefaultScale seeds it. */
const SCORE_SCALE = Object.fromEntries(
  Array.from({ length: 11 }, (_, i) => [`score-${i * 10}`, i * 10])
);

/** Keys that would carry a grade as a number. None may appear anywhere in a payload. */
const NUMERIC_GRADE_KEYS = [
  'score',
  'first_attempt_score',
  'current_score',
  'counted_score',
  'best_score',
  'avg_score',
  'credit_earned',
  'numeric_score',
  'partial_credit_percentage',
  'first_attempt_percentage',
  'raw_percentage',
  'grade',
  'late_penalty_per_hour',
];

/** A grade's number in text: a percentage or a grade field's name. */
const NUMERIC_GRADE_TEXT =
  /\d+(\.\d+)?\s*%|credit_earned|numeric_score|partial_credit|first_attempt_percentage|raw_percentage/i;

/** Every string in a JSON value, at any depth. */
const stringsOf = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(stringsOf)
      : value && typeof value === 'object'
        ? Object.values(value).flatMap(stringsOf)
        : [];

/** Every key in a JSON value, at any depth. */
const keysOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap(keysOf)
    : value && typeof value === 'object'
      ? Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)])
      : [];

const settings: Record<string, unknown> = {};
const CTX: ToolContext = {
  viewer: { userId: 'staff-1', clientId: 'c', scopes: new Set(['read']) },
  classroom: {
    classroomId: 'class-1',
    role: 'TEACHER',
    status: 'ACTIVE',
    membership: { id: 'm-1', role: 'TEACHER' },
    classroom: { settings, git_organization: { provider: 'GITLAB' } },
  },
} as unknown as ToolContext;

const ARGS = { classroom: 'org/w26', quiz_id: 'quiz-1' };
const DEADLINE = new Date('2026-10-02T04:00:00Z');
const at = (iso: string) => new Date(iso);

/**
 * A membership row as findUsersByRole(s) returns it: the user row, its login
 * on the classroom's provider, and membership fields that must never leave
 * (the letter override and the private staff note among them).
 */
const member = (id: string, login: string, name: string) => ({
  id,
  login,
  name,
  email: `${login}@school.edu`,
  school_id: `school-${id}`,
  is_grader: false,
  has_accepted_invite: true,
  letter_grade: 'B+',
  comment: `PRIVATE NOTE about ${id}`,
});

/** A joined user row on an attempt, with fields that must never leave. */
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
  last_activity: completedAt ? null : at(startedAt),
  partial_credit_percentage: score,
  first_attempt_percentage: score,
  total_duration_ms: null,
  unfocused_duration_ms: null,
  agent_config: { systemPrompt: 'SECRET PROMPT' },
  session_token: 'SECRET TOKEN',
  user: user(userId, `github-${userId}`, `Name ${userId}`),
  ...over,
});

const ASSIGNMENT = {
  id: 'asg-1',
  type: 'QUIZ',
  is_published: true,
  release_at: null,
  module_id: 'mod-1',
  weight: 10,
  is_extra_credit: false,
  student_deadline: DEADLINE,
};

const quiz = (over: Record<string, unknown> = {}) => ({
  id: 'quiz-1',
  classroom_id: 'class-1',
  name: 'HTML quiz',
  grading_strategy: 'HIGHEST',
  max_attempts: 2,
  assignment: ASSIGNMENT,
  attempts: [],
  ...over,
});

const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);

beforeEach(() => {
  vi.useRealTimers();
  for (const m of Object.values(mocks)) m.mockReset();
  for (const key of Object.keys(settings)) delete settings[key];
  mocks.quizzesVisibleOrThrow.mockResolvedValue(true);
  mocks.auditCreate.mockResolvedValue(undefined);
  mocks.netHours.mockResolvedValue(new Map());
  mocks.emojiScale.mockResolvedValue(EMOJI_SCALE);
  mocks.quizFindById.mockResolvedValue(quiz());
  mocks.findByQuiz.mockResolvedValue([]);
  mocks.findUsersByRole.mockResolvedValue([
    member('ada', 'ada', 'Ada Lovelace'),
    member('bo', 'bo', 'Bo Diddley'),
    member('cy', 'cy', 'Cy Young'),
  ]);
  mocks.findUsersByRoles.mockResolvedValue([member('staff-1', 'prof', 'Prof Staff')]);
});

describe('list_quiz_attempts', () => {
  it('is for the teaching team, as a read; a student is refused', () => {
    expect(listQuizAttemptsTool.roles).toEqual(['OWNER', 'TEACHER', 'ASSISTANT']);
    expect(listQuizAttemptsTool.roles).not.toContain('STUDENT');
    expect(listQuizAttemptsTool.scope).toBe('read');
  });

  it('is annotated read-only, non-destructive, idempotent and closed-world', () => {
    expect(listQuizAttemptsTool.annotations).toEqual({
      destructive: false,
      idempotent: true,
      openWorld: false,
    });
    expect(
      toolAnnotations(listQuizAttemptsTool as unknown as Parameters<typeof toolAnnotations>[0])
    ).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });

  it('keeps its description under 1,500 bytes', () => {
    expect(Buffer.byteLength(listQuizAttemptsTool.description)).toBeLessThan(1500);
  });

  it('lists every rostered student, including those who have not started', async () => {
    mocks.quizFindById.mockResolvedValue(quiz({ assignment: null }));
    mocks.findByQuiz.mockResolvedValue([
      attempt('a1', 'ada', '2026-10-01T10:00:00Z', '2026-10-01T10:30:00Z', 80),
    ]);

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
      current_emoji: null,
      counted_emoji: null,
      counts_as_zero: false,
    });
    expect(payload.summary).toEqual({
      roster_students: 3,
      not_started: 2,
      in_progress: 0,
      completed: 1,
      counts_as_zero: 0,
      staff_previews: 0,
      former_members: 0,
    });
  });

  it('reads the attempts with logins on the classroom’s git provider', async () => {
    mocks.findByQuiz.mockResolvedValue([
      attempt('a1', 'ada', '2026-10-01T10:00:00Z', '2026-10-01T10:30:00Z', 80),
      attempt('x1', 'gone', '2026-10-01T10:00:00Z', '2026-10-01T10:30:00Z', 80),
    ]);

    const payload = parse(await listQuizAttemptsTool.handler(ARGS, CTX));

    expect(mocks.findByQuiz).toHaveBeenCalledWith('quiz-1', 'GITLAB');
    // A member's login is the membership's (the provider's), not the attempt join's.
    expect(payload.students[0].student.login).toBe('ada');
    expect(payload.former_members[0].student.login).toBe('github-gone');
  });

  it('marks the attempt that counts under the grading strategy, newest attempt first', async () => {
    mocks.findByQuiz.mockResolvedValue([
      attempt('first', 'ada', '2026-10-01T10:00:00Z', '2026-10-01T10:30:00Z', 90),
      attempt('second', 'ada', '2026-10-01T12:00:00Z', '2026-10-01T12:30:00Z', 60),
    ]);

    const [ada] = parse(await listQuizAttemptsTool.handler(ARGS, CTX)).students;

    expect(ada.attempts.map((a: { id: string }) => a.id)).toEqual(['second', 'first']);
    expect(ada.counting_attempt_id).toBe('first');
    expect(ada.attempts.map((a: { is_counting: boolean }) => a.is_counting)).toEqual([false, true]);
    expect(ada.attempts.map((a: { grade_emoji: string }) => a.grade_emoji)).toEqual(['-1', '+1']);
    expect(ada.current_emoji).toBe('+1');
  });

  it('reports a running attempt as IN_PROGRESS with its last activity', async () => {
    // A running attempt may already hold a partial score: it is not shown.
    mocks.findByQuiz.mockResolvedValue([
      attempt('a1', 'bo', '2026-10-01T10:00:00Z', null, 40, { first_attempt_percentage: 40 }),
    ]);

    const payload = parse(await listQuizAttemptsTool.handler(ARGS, CTX));
    const bo = payload.students.find((s: { student: { id: string } }) => s.student.id === 'bo');

    expect(bo).toMatchObject({ status: 'IN_PROGRESS', counting_attempt_id: null });
    expect(bo.attempts[0]).toMatchObject({
      last_activity: '2026-10-01T10:00:00.000Z',
      grade_emoji: null,
      first_attempt_emoji: null,
      late_hours: null,
    });
    expect(payload.summary.in_progress).toBe(1);
  });

  it('charges the late penalty to counted_emoji and keeps current_emoji raw', async () => {
    settings.late_penalty_points_per_hour = 20;
    // Completed two and a half hours past the deadline, with one hour bought:
    // one late hour, as the results page counts it.
    mocks.netHours.mockResolvedValue(new Map([['ada', 1]]));
    mocks.findByQuiz.mockResolvedValue([
      attempt('a1', 'ada', '2026-10-02T05:00:00Z', '2026-10-02T06:30:00Z', 80),
    ]);

    const [ada] = parse(await listQuizAttemptsTool.handler(ARGS, CTX)).students;

    expect(ada.attempts[0].late_hours).toBe(1);
    expect(ada.late_hours).toBe(1);
    expect(ada.current_emoji).toBe('eyes');
    expect(ada.counted_emoji).toBe('-1');
  });

  it('ignores a late penalty that is not a number, as the web does', async () => {
    settings.late_penalty_points_per_hour = '20';
    mocks.netHours.mockResolvedValue(new Map([['ada', 1]]));
    mocks.findByQuiz.mockResolvedValue([
      attempt('a1', 'ada', '2026-10-02T05:00:00Z', '2026-10-02T06:30:00Z', 80),
    ]);

    const [ada] = parse(await listQuizAttemptsTool.handler(ARGS, CTX)).students;

    expect(ada.counted_emoji).toBe('eyes');
  });

  it('counts a rostered student with no completed attempt past the due date as zero', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-05T12:00:00Z'), toFake: ['Date'] });
    mocks.netHours.mockResolvedValue(new Map([['cy', 200]]));
    mocks.findByQuiz.mockResolvedValue([
      attempt('a1', 'ada', '2026-10-01T10:00:00Z', '2026-10-01T10:30:00Z', 90),
      attempt('b1', 'bo', '2026-10-03T10:00:00Z', null, null),
    ]);

    const payload = parse(await listQuizAttemptsTool.handler(ARGS, CTX));
    const row = (id: string) =>
      payload.students.find((s: { student: { id: string } }) => s.student.id === id);

    expect(row('ada')).toMatchObject({ counts_as_zero: false, counted_emoji: '+1' });
    // Bo's attempt is still open past the deadline: a zero, as the gradebook counts it.
    expect(row('bo')).toMatchObject({ counts_as_zero: true, counted_emoji: 'sob' });
    // Cy bought hours that run past now: not yet a zero.
    expect(row('cy')).toMatchObject({ counts_as_zero: false, counted_emoji: null });
    expect(payload.summary.counts_as_zero).toBe(1);
  });

  it('gives score-N badges on the numeric scale', async () => {
    mocks.emojiScale.mockResolvedValue(SCORE_SCALE);
    settings.late_penalty_points_per_hour = 20;
    mocks.netHours.mockResolvedValue(new Map([['ada', 1]]));
    mocks.findByQuiz.mockResolvedValue([
      attempt('a1', 'ada', '2026-10-02T05:00:00Z', '2026-10-02T06:30:00Z', 83, {
        first_attempt_percentage: 47,
      }),
    ]);

    const [ada] = parse(await listQuizAttemptsTool.handler(ARGS, CTX)).students;

    expect(mocks.emojiScale).toHaveBeenCalledWith('class-1');
    expect(ada.attempts[0]).toMatchObject({
      grade_emoji: 'score-80',
      first_attempt_emoji: 'score-50',
    });
    expect(ada.current_emoji).toBe('score-80');
    expect(ada.counted_emoji).toBe('score-60');
  });

  it('states no emoji where the classroom has no scale, as the web pages do', async () => {
    mocks.emojiScale.mockResolvedValue({});
    mocks.findByQuiz.mockResolvedValue([
      attempt('a1', 'ada', '2026-10-01T10:00:00Z', '2026-10-01T10:30:00Z', 100),
    ]);

    const [ada] = parse(await listQuizAttemptsTool.handler(ARGS, CTX)).students;

    expect(ada.current_emoji).toBeNull();
    expect(ada.attempts[0].grade_emoji).toBeNull();
  });

  it('states no grade as a number anywhere in the payload', async () => {
    settings.late_penalty_points_per_hour = 10;
    mocks.findByQuiz.mockResolvedValue([
      attempt('a1', 'ada', '2026-10-01T10:00:00Z', '2026-10-01T10:30:00Z', 80),
      attempt('a2', 'ada', '2026-10-02T05:00:00Z', '2026-10-02T06:30:00Z', 70),
      attempt('a3', 'bo', '2026-10-01T10:00:00Z', null, null),
      attempt('p1', 'staff-1', '2026-10-03T10:00:00Z', '2026-10-03T11:00:00Z', 100),
      attempt('x1', 'gone', '2026-10-03T10:00:00Z', '2026-10-03T11:00:00Z', 50),
    ]);

    const payload = parse(await listQuizAttemptsTool.handler(ARGS, CTX));

    const keys = keysOf(payload);
    for (const key of NUMERIC_GRADE_KEYS) expect(keys).not.toContain(key);
    // focus_percentage is the share of time the tab was focused, not a grade.
    for (const key of keys.filter(k => k !== 'focus_percentage')) {
      expect(key).not.toMatch(/score|credit|percentage$/i);
    }
    expect(keys).toEqual(
      expect.arrayContaining(['grade_emoji', 'first_attempt_emoji', 'counted_emoji'])
    );
    for (const value of stringsOf(payload)) expect(value).not.toMatch(NUMERIC_GRADE_TEXT);
  });

  it('keeps staff previews and former members apart from students, never late', async () => {
    mocks.findByQuiz.mockResolvedValue([
      attempt('p1', 'staff-1', '2026-10-03T10:00:00Z', '2026-10-03T11:00:00Z', 100),
      attempt('x1', 'gone', '2026-10-03T10:00:00Z', '2026-10-03T11:00:00Z', 50),
    ]);

    const payload = parse(await listQuizAttemptsTool.handler(ARGS, CTX));

    expect(payload.students.every((s: { attempts: unknown[] }) => s.attempts.length === 0)).toBe(
      true
    );
    expect(payload.staff_previews).toHaveLength(1);
    expect(payload.staff_previews[0].student).toEqual({
      id: 'staff-1',
      login: 'prof',
      name: 'Prof Staff',
    });
    expect(payload.staff_previews[0].attempts[0].late_hours).toBeNull();
    expect(payload.staff_previews[0].counts_as_zero).toBe(false);
    expect(payload.former_members).toHaveLength(1);
    expect(payload.former_members[0].student.id).toBe('gone');
    expect(payload.former_members[0].attempts[0].late_hours).toBeNull();
    expect(payload.summary).toMatchObject({ staff_previews: 1, former_members: 1 });
  });

  it('gives no late hours where the quiz has no due date', async () => {
    mocks.quizFindById.mockResolvedValue(quiz({ assignment: null }));
    mocks.findByQuiz.mockResolvedValue([
      attempt('a1', 'ada', '2026-10-01T10:00:00Z', '2026-10-01T10:30:00Z', 80),
    ]);

    const payload = parse(await listQuizAttemptsTool.handler(ARGS, CTX));

    expect(payload.students[0].attempts[0].late_hours).toBeNull();
    expect(payload.students[0].late_hours).toBeNull();
    expect(mocks.netHours).not.toHaveBeenCalled();
  });

  it('derives the focus percentage the review page shows', async () => {
    mocks.findByQuiz.mockResolvedValue([
      attempt('a1', 'ada', '2026-10-01T10:00:00Z', '2026-10-01T10:30:00Z', 80, {
        total_duration_ms: 1_000_000,
        unfocused_duration_ms: 250_000,
      }),
    ]);

    const [ada] = parse(await listQuizAttemptsTool.handler(ARGS, CTX)).students;

    expect(ada.attempts[0].focus_percentage).toBe(75);
  });

  it('sends only an id, a login and a name for each person', async () => {
    mocks.findByQuiz.mockResolvedValue([
      attempt('a1', 'ada', '2026-10-01T10:00:00Z', '2026-10-01T10:30:00Z', 80),
      attempt('p1', 'staff-1', '2026-10-03T10:00:00Z', '2026-10-03T11:00:00Z', 100),
    ]);

    const result = await listQuizAttemptsTool.handler(ARGS, CTX);

    const text = result.content[0].text;
    for (const secret of [
      '@school.edu',
      'school-ada',
      'PRIVATE NOTE',
      'B+',
      'letter_grade',
      // The membership's staff note (`comment`); `instructor_comment` is the
      // attempt's comment to the student, which staff may read.
      '"comment"',
      'has_accepted_invite',
      'SECRET PROMPT',
      'SECRET TOKEN',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(parse(result).students[0].student).toEqual({
      id: 'ada',
      login: 'ada',
      name: 'Ada Lovelace',
    });
  });

  it('refuses a quiz of another classroom exactly like an unknown one', async () => {
    mocks.quizFindById.mockResolvedValue(quiz({ classroom_id: 'other-class' }));
    await expect(listQuizAttemptsTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
    });

    mocks.quizFindById.mockResolvedValue(null);
    await expect(listQuizAttemptsTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(mocks.findByQuiz).not.toHaveBeenCalled();
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
    await listQuizAttemptsTool.handler(ARGS, CTX);

    expect(mocks.auditCreate.mock.calls[0][0]).toMatchObject({
      user_id: 'staff-1',
      classroom_id: 'class-1',
      role: 'TEACHER',
      resource_type: 'QUIZ_DETAILS',
      resource_id: 'quiz-1',
      action: 'VIEW',
      // The tool's own name, like every other MCP tool's audit row.
      data: { tool: 'list_quiz_attempts', students: 3 },
    });
  });
});

describe('list_quiz_attempts: staff adjustments', () => {
  it('shows an adjusted attempt by its own emoji, with the AI original and who adjusted it', async () => {
    mocks.findByQuiz.mockResolvedValue([
      attempt('a1', 'ada', '2026-10-01T10:00:00Z', '2026-10-01T10:30:00Z', 62, {
        adjusted_emoji: 'rocket',
        instructor_comment: 'Q3 was ambiguous.',
        adjusted_by_id: 'staff-1',
        adjusted_at: at('2026-10-03T12:00:00Z'),
      }),
      attempt('a2', 'ada', '2026-10-02T10:00:00Z', '2026-10-02T10:30:00Z', 80),
    ]);
    mocks.userFindMany.mockResolvedValue([{ id: 'staff-1', name: 'Prof Staff' }]);

    const [ada] = parse(await listQuizAttemptsTool.handler(ARGS, CTX)).students;
    const adjusted = ada.attempts.find((a: { id: string }) => a.id === 'a1');
    const plain = ada.attempts.find((a: { id: string }) => a.id === 'a2');

    // HIGHEST over effective grades: the adjusted 100 counts over the 80.
    expect(ada.counting_attempt_id).toBe('a1');
    expect(ada.counting_adjusted).toBe(true);
    expect(ada.current_emoji).toBe('rocket');
    expect(adjusted).toMatchObject({
      grade_emoji: 'rocket',
      adjusted: true,
      original_emoji: '-1',
      instructor_comment: 'Q3 was ambiguous.',
      adjusted_at: '2026-10-03T12:00:00.000Z',
      adjusted_by: { id: 'staff-1', name: 'Prof Staff' },
    });
    expect(adjusted).toMatchObject({ adjusted_emoji: 'rocket', adjustment_orphaned: false });
    expect(ada.counting_adjustment_orphaned).toBe(false);
    expect(plain).toMatchObject({
      grade_emoji: 'eyes',
      adjusted: false,
      original_emoji: 'eyes',
      adjusted_emoji: null,
      adjustment_orphaned: false,
      instructor_comment: null,
      adjusted_at: null,
      adjusted_by: null,
    });
    // One name read, for the adjusters only: id and name.
    expect(mocks.userFindMany).toHaveBeenCalledWith({
      where: { id: { in: ['staff-1'] } },
      select: { id: true, name: true },
    });
  });

  it("flags an adjustment whose emoji left the scale, with the stored emoji; the AI's grade counts (E17)", async () => {
    mocks.findByQuiz.mockResolvedValue([
      attempt('a1', 'ada', '2026-10-01T10:00:00Z', '2026-10-01T10:30:00Z', 62, {
        adjusted_emoji: 'heart',
        adjusted_by_id: 'staff-1',
        adjusted_at: at('2026-10-03T12:00:00Z'),
      }),
    ]);
    mocks.userFindMany.mockResolvedValue([{ id: 'staff-1', name: 'Prof Staff' }]);

    const [ada] = parse(await listQuizAttemptsTool.handler(ARGS, CTX)).students;
    expect(ada).toMatchObject({
      counting_attempt_id: 'a1',
      counting_adjusted: false,
      counting_adjustment_orphaned: true,
      current_emoji: '-1',
    });
    expect(ada.attempts[0]).toMatchObject({
      grade_emoji: '-1',
      adjusted: false,
      adjusted_emoji: 'heart',
      adjustment_orphaned: true,
      adjusted_by: { id: 'staff-1', name: 'Prof Staff' },
    });
  });

  it('reads no names when nothing is adjusted', async () => {
    mocks.findByQuiz.mockResolvedValue([
      attempt('a1', 'ada', '2026-10-01T10:00:00Z', '2026-10-01T10:30:00Z', 80),
    ]);
    await listQuizAttemptsTool.handler(ARGS, CTX);
    expect(mocks.userFindMany).not.toHaveBeenCalled();
  });
});
