/**
 * What the quiz results page and the attempt drawers send to the browser.
 *
 * Their loaders start from wide rows: `quiz.findById` joins the classroom and
 * every attempt with its user, `quizAttempt.findByQuiz` and `findWithMessages`
 * join each attempt's user, and a user row carries contact and account fields
 * no quiz screen shows. The payloads are now built field by field
 * (~/utils/quizPayloads), so these tests feed the loaders rows shaped like the
 * real joins — with a SENTINEL in every field no screen renders — and assert
 * two things per payload:
 *
 *   - the unrendered keys are ABSENT (`'email' in row === false`), and no
 *     sentinel survives anywhere in the serialized payload;
 *   - the screen still gets everything it renders.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  assertProTier: vi.fn(),
  loadQuizzesVisible: vi.fn(),
  quizzesVisibleOrThrow: vi.fn(),
  addAuditLog: vi.fn(),
  quizFindById: vi.fn(),
  findByQuiz: vi.fn(),
  findWithMessages: vi.fn(),
  getMessages: vi.fn(),
  userFindById: vi.fn(),
  findUsersByRole: vi.fn(),
  netQuizExtensionHoursByStudent: vi.fn(),
  netQuizExtensionHours: vi.fn(),
  findScaleByClassroomId: vi.fn(),
  regradeFindMany: vi.fn(),
  openQuizRequestAttemptIds: vi.fn(),
  findOpenByQuizAttemptId: vi.fn(),
  findByClassroomAndUser: vi.fn(),
  findForUserByQuizIds: vi.fn(),
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertProTier: (...a: unknown[]) => mocks.assertProTier(...a),
  addAuditLog: (...a: unknown[]) => mocks.addAuditLog(...a),
  addClassroomAuditLog: vi.fn(),
}));
vi.mock('~/utils/routeAuth.server', () => ({
  assertClassroomMutationAllowed: vi.fn(),
  requireClassroomTeachingTeam: vi.fn(),
}));
// Every loader here gates on quiz visibility; these payload tests run with
// quizzes visible.
vi.mock('~/utils/classroomProFlag.server', () => ({
  loadQuizzesVisible: (...a: unknown[]) => mocks.loadQuizzesVisible(...a),
  quizzesVisibleOrThrow: (...a: unknown[]) => mocks.quizzesVisibleOrThrow(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    quiz: { findById: (...a: unknown[]) => mocks.quizFindById(...a) },
    quizAttempt: {
      findByQuiz: (...a: unknown[]) => mocks.findByQuiz(...a),
      findWithMessages: (...a: unknown[]) => mocks.findWithMessages(...a),
      getMessages: (...a: unknown[]) => mocks.getMessages(...a),
      findForUserByQuizIds: (...a: unknown[]) => mocks.findForUserByQuizIds(...a),
      clearForUserAndQuiz: vi.fn(),
    },
    user: { findById: (...a: unknown[]) => mocks.userFindById(...a) },
    classroomMembership: {
      findUsersByRole: (...a: unknown[]) => mocks.findUsersByRole(...a),
      findByClassroomAndUser: (...a: unknown[]) => mocks.findByClassroomAndUser(...a),
    },
    token: {
      netQuizExtensionHoursByStudent: (...a: unknown[]) =>
        mocks.netQuizExtensionHoursByStudent(...a),
    },
    quizGradeItems: {
      netQuizExtensionHours: (...a: unknown[]) => mocks.netQuizExtensionHours(...a),
    },
    emojiMapping: {
      findScaleByClassroomId: (...a: unknown[]) => mocks.findScaleByClassroomId(...a),
    },
    regradeRequest: {
      findMany: (...a: unknown[]) => mocks.regradeFindMany(...a),
      openQuizRequestAttemptIds: (...a: unknown[]) => mocks.openQuizRequestAttemptIds(...a),
      findOpenByQuizAttemptId: (...a: unknown[]) => mocks.findOpenByQuizAttemptId(...a),
    },
  },
  QuizAttemptNotFoundError: class QuizAttemptNotFoundError extends Error {},
  QuizGradeError: class QuizGradeError extends Error {},
}));

// The loaders are under test; the view layers only need to import.
vi.mock('~/components', () => ({
  UserThumbnailView: () => null,
  GradeBadge: () => null,
  SectionHeader: () => null,
  QuizAttemptInterface: () => null,
}));
vi.mock('~/hooks', () => ({
  useRouteDrawer: () => ({ opened: true }),
  useDarkMode: () => ({ isDarkMode: false }),
}));
vi.mock('~/utils/quizUtils', () => ({ formatDuration: () => '' }));
vi.mock('@classmoji/ui-components', () => ({ useCallout: () => ({ show: vi.fn() }) }));
vi.mock('antd', () => ({
  Table: () => null,
  Button: () => null,
  Tag: () => null,
  Tooltip: () => null,
  Badge: () => null,
  Space: () => null,
  Modal: Object.assign(() => null, { confirm: vi.fn(), error: vi.fn() }),
  Select: () => null,
  Spin: () => null,
  Drawer: () => null,
  ConfigProvider: () => null,
  theme: { darkAlgorithm: {}, defaultAlgorithm: {} },
}));
vi.mock('@ant-design/icons', () => ({
  TrophyOutlined: () => null,
  PlayCircleOutlined: () => null,
  ClearOutlined: () => null,
}));
vi.mock('@tabler/icons-react', () => ({
  IconEye: () => null,
  IconArrowLeft: () => null,
  IconClock: () => null,
  IconTrophy: () => null,
  IconChartBar: () => null,
}));
vi.mock('react-router', () => ({
  useLocation: () => ({ pathname: '/assistant/intro-101/quizzes/quiz-1' }),
  useNavigate: () => vi.fn(),
  useParams: () => ({ class: 'intro-101', quizId: 'quiz-1' }),
  useFetcher: () => ({ submit: vi.fn() }),
  Outlet: () => null,
  Link: () => null,
  data: (body: unknown, init?: unknown) => ({ body, init }),
}));

const detailRoute = await import('../admin.$class.quizzes_.$quizId.tsx');
const staffAttemptRoute =
  await import('../admin.$class.quizzes_.$quizId.attempt.$attemptId/route.tsx');
const studentAttemptRoute =
  await import('../student.$class.quizzes.$quizId.attempt.$attemptId/route.tsx');
const { buildQuizResultRows, staffAttemptGradePanel, attemptGradeView } =
  await import('~/utils/quizPayloads');

/** The classroom's grading scale (emoji → grade), best first, as `findScaleByClassroomId` returns it. */
const SCALE = { rocket: 100, '+1': 85, eyes: 70, '-1': 50, sob: 0 };

// ─── Fixtures shaped like the real joins ────────────────────────────────────

const CLASS_SLUG = 'intro-101';
const CLASSROOM = { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE' };
const QUIZ_ID = 'quiz-1';

const SENTINEL = {
  email: 'SENTINEL-EMAIL',
  providerEmail: 'SENTINEL-PROVIDER-EMAIL',
  schoolId: 'SENTINEL-SCHOOL-ID',
  stripe: 'cus_SENTINEL',
  banReason: 'SENTINEL-BAN-REASON',
  providerId: 'SENTINEL-PROVIDER-ID',
  sessionToken: 'SENTINEL-SESSION-TOKEN',
  repo: 'SENTINEL-REPO',
  feedback: 'SENTINEL-FEEDBACK',
  codebasePath: 'SENTINEL-CODEBASE-PATH',
  systemPrompt: 'SENTINEL-SYSTEM-PROMPT',
  rubricPrompt: 'SENTINEL-RUBRIC-PROMPT',
  classroomSecret: 'SENTINEL-CLASSROOM',
};

/** Fields a user row carries that no quiz screen renders. */
const UNRENDERED_USER_FIELDS = [
  'email',
  'provider_email',
  'provider_id',
  'provider',
  'school_id',
  'stripe_customer_id',
  'role',
  'banned',
  'ban_reason',
  'ban_expires_at',
  'emailVerified',
  'image',
  'created_at',
  'updated_at',
  'onboarding_completed_at',
];

const userRow = (id: string, login: string, name: string) => ({
  id,
  login,
  name,
  image: `https://avatars.example.test/${login}.png`,
  email: `${login}-${SENTINEL.email}`,
  emailVerified: true,
  provider: 'GITHUB',
  provider_id: `${SENTINEL.providerId}-${login}`,
  provider_email: `${login}-${SENTINEL.providerEmail}`,
  school_id: `${SENTINEL.schoolId}-${login}`,
  stripe_customer_id: `${SENTINEL.stripe}-${login}`,
  role: 'user',
  banned: false,
  ban_reason: SENTINEL.banReason,
  ban_expires_at: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
  onboarding_completed_at: null,
});

const ADA = userRow('stu-ada', 'ada', 'Ada Lovelace');
const BABBAGE = userRow('stu-babbage', 'babbage', 'Charles Babbage');
const TA = userRow('ta-1', 'grace', 'Grace Hopper');

const attemptRow = (
  id: string,
  user: ReturnType<typeof userRow>,
  over: Partial<{
    started_at: Date;
    completed_at: Date | null;
    partial_credit_percentage: number | null;
    first_attempt_percentage: number | null;
    total_duration_ms: number | null;
    unfocused_duration_ms: number | null;
    adjusted_emoji: string | null;
    instructor_comment: string | null;
    adjusted_by_id: string | null;
    adjusted_at: Date | null;
    comment_by_id: string | null;
    comment_at: Date | null;
  }> = {}
) => ({
  id,
  quiz_id: QUIZ_ID,
  user_id: user.id,
  conversation_id: `conv-${id}`,
  started_at: new Date('2026-03-01T10:00:00Z'),
  completed_at: null as Date | null,
  score: null,
  feedback: SENTINEL.feedback,
  attempt_number: 1,
  questions_asked: 3,
  session_token: `${SENTINEL.sessionToken}-${id}`,
  last_activity: new Date('2026-03-01T10:30:00Z'),
  total_duration_ms: null as number | null,
  unfocused_duration_ms: null as number | null,
  modal_closed_at: null,
  question_results_json: { note: SENTINEL.feedback },
  partial_credit_percentage: null as number | null,
  first_attempt_percentage: null as number | null,
  adjusted_emoji: null as string | null,
  session_status: 'active',
  codebase_path: SENTINEL.codebasePath,
  agent_config: { instructorRepoName: SENTINEL.repo },
  created_at: new Date('2026-03-01T10:00:00Z'),
  updated_at: new Date('2026-03-01T10:30:00Z'),
  user,
  ...over,
});

// Newest first, the order `findByQuiz` returns.
const ADA_SECOND = attemptRow('a-ada-2', ADA, {
  started_at: new Date('2026-03-03T10:00:00Z'),
  completed_at: new Date('2026-03-03T10:20:00Z'),
  partial_credit_percentage: 60,
  first_attempt_percentage: 55,
  total_duration_ms: 1000,
  unfocused_duration_ms: 250,
});
const TA_PREVIEW = attemptRow('a-ta', TA, { started_at: new Date('2026-03-02T12:00:00Z') });
const BABBAGE_OPEN = attemptRow('a-babbage', BABBAGE, {
  started_at: new Date('2026-03-02T10:00:00Z'),
});
const ADA_FIRST = attemptRow('a-ada-1', ADA, {
  started_at: new Date('2026-03-01T10:00:00Z'),
  completed_at: new Date('2026-03-01T10:20:00Z'),
  partial_credit_percentage: 80,
  first_attempt_percentage: 80,
  total_duration_ms: 2000,
  unfocused_duration_ms: 0,
});
const ATTEMPTS = [ADA_SECOND, TA_PREVIEW, BABBAGE_OPEN, ADA_FIRST];

// `quiz.findById` joins the classroom and every attempt with its user.
const QUIZ_ROW = {
  id: QUIZ_ID,
  classroom_id: CLASSROOM.id,
  repository_id: 'repo-1',
  name: 'Recursion',
  system_prompt: SENTINEL.systemPrompt,
  rubric_prompt: SENTINEL.rubricPrompt,
  due_date: null,
  status: 'PUBLISHED',
  weight: 10,
  question_count: 5,
  difficulty_level: 'Beginner',
  subject: 'CS',
  include_code_context: false,
  grading_strategy: 'HIGHEST',
  max_attempts: 3,
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
  repository: { id: 'repo-1', title: 'hw1', classroom_id: CLASSROOM.id },
  classroom: { id: CLASSROOM.id, slug: CLASS_SLUG, name: SENTINEL.classroomSecret },
  attempts: ATTEMPTS,
};

// `findWithMessages` joins the attempt to its user, and its quiz to the
// classroom with settings.
const withMessages = (attempt: ReturnType<typeof attemptRow>) => ({
  attempt: {
    ...attempt,
    quiz: {
      ...QUIZ_ROW,
      attempts: undefined,
      classroom: { ...QUIZ_ROW.classroom, settings: { anthropic_api_key: 'sk-SENTINEL' } },
    },
  },
  messages: [
    { id: 'm1', role: 'assistant', content: 'Question 1', metadata: null, timestamp: new Date() },
  ],
});

const ALL_SENTINELS = [...Object.values(SENTINEL), 'sk-SENTINEL'];

const expectNoSentinels = (payload: unknown) => {
  const serialized = JSON.stringify(payload);
  for (const sentinel of ALL_SENTINELS) expect(serialized).not.toContain(sentinel);
};

const detailArgs = () =>
  ({
    params: { class: CLASS_SLUG, quizId: QUIZ_ID },
    request: new Request(`http://localhost/assistant/${CLASS_SLUG}/quizzes/${QUIZ_ID}`),
  }) as never;

const attemptArgs = (prefix: string, attemptId: string) =>
  ({
    params: { class: CLASS_SLUG, quizId: QUIZ_ID, attemptId },
    request: new Request(
      `http://localhost/${prefix}/${CLASS_SLUG}/quizzes/${QUIZ_ID}/attempt/${attemptId}`
    ),
  }) as never;

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.assertProTier.mockResolvedValue(undefined);
  mocks.loadQuizzesVisible.mockResolvedValue(true);
  mocks.quizzesVisibleOrThrow.mockResolvedValue(true);
  mocks.quizFindById.mockResolvedValue(QUIZ_ROW);
  mocks.findByQuiz.mockResolvedValue(ATTEMPTS);
  // Wired so a loader that still read them would find something to send.
  mocks.userFindById.mockImplementation(async (id: string) =>
    [ADA, BABBAGE, TA].find(u => u.id === id)
  );
  mocks.getMessages.mockResolvedValue([{ role: 'ASSISTANT', content: SENTINEL.feedback }]);
  // The results page always reads the STUDENT roster; empty unless a test says.
  mocks.findUsersByRole.mockResolvedValue([]);
  mocks.findScaleByClassroomId.mockResolvedValue(SCALE);
  mocks.regradeFindMany.mockResolvedValue([]);
  mocks.openQuizRequestAttemptIds.mockResolvedValue(new Set());
  mocks.findOpenByQuizAttemptId.mockResolvedValue(null);
  mocks.netQuizExtensionHours.mockResolvedValue(new Map());
  // One user's attempts on the quiz, newest first (the counting-attempt read).
  mocks.findForUserByQuizIds.mockImplementation(async (userId: string) =>
    ATTEMPTS.filter(a => a.user_id === userId)
  );
  // Ada and Babbage are current students; nobody else is.
  mocks.findByClassroomAndUser.mockImplementation(async (_c: string, userId: string) =>
    [ADA.id, BABBAGE.id].includes(userId) ? { has_accepted_invite: true } : null
  );
});

// ─── The results page ───────────────────────────────────────────────────────

describe('quiz results page payload', () => {
  type DetailPayload = Awaited<ReturnType<typeof detailRoute.loader>>;
  let payload: DetailPayload;

  beforeEach(async () => {
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: TA.id,
      classroom: CLASSROOM,
      membership: { role: 'ASSISTANT' },
    });
    payload = await detailRoute.loader(detailArgs());
  });

  it('gives each student row exactly the user fields the thumbnail renders', () => {
    expect(payload.students.length).toBeGreaterThan(0);
    for (const student of payload.students) {
      expect(Object.keys(student.user).sort()).toEqual(['avatar_url', 'id', 'login', 'name']);
      for (const field of UNRENDERED_USER_FIELDS) {
        expect(field in student.user).toBe(false);
      }
    }
  });

  it('gives each attempt row only the columns the attempts table renders', () => {
    for (const attempt of payload.students.flatMap(s => s.attempts)) {
      expect(Object.keys(attempt).sort()).toEqual(
        [
          'completed_at',
          'firstAttemptEmoji',
          'firstAttemptScore',
          'focusMetrics',
          'grade',
          'id',
          'isCounting',
          'lateHours',
          'partialCreditScore',
          'regradeRequested',
          'started_at',
        ].sort()
      );
      for (const field of ['user', 'agent_config', 'session_token', 'feedback', 'codebase_path']) {
        expect(field in attempt).toBe(false);
      }
    }
  });

  it('sends the quiz as the fields the page reads, without its joined attempts', () => {
    expect(payload.quiz).toEqual({
      id: QUIZ_ID,
      name: 'Recursion',
      grading_strategy: 'HIGHEST',
      max_attempts: 3,
      include_code_context: false,
    });
    expect('attempts' in payload.quiz).toBe(false);
    expect('classroom' in payload).toBe(false);
  });

  it("narrows the viewer's own attempt to what resuming a preview needs", () => {
    expect(payload.adminAttempt).toEqual({ id: TA_PREVIEW.id, completed_at: null });
  });

  it('carries no sentinel anywhere in the serialized payload', () => {
    expectNoSentinels(payload);
  });

  it('still gives the page everything it renders', () => {
    const ada = payload.students.find(s => s.userId === ADA.id)!;
    expect(ada.user).toEqual({
      id: ADA.id,
      name: 'Ada Lovelace',
      login: 'ada',
      avatar_url: ADA.image,
    });
    expect(ada.attemptCount).toBe(2);
    // HIGHEST: the 80 counts, though the 60 is more recent.
    expect(ada.currentScore).toBe(80);
    expect(ada.bestScore).toBe(80);
    expect(ada.firstAttemptScore).toBe(80);
    expect(ada.countingAttemptId).toBe(ADA_FIRST.id);
    expect(ada.latestAttempt).toEqual(ADA_SECOND.started_at);
    // Newest first, with the counting attempt flagged.
    expect(ada.attempts.map(a => [a.id, a.isCounting])).toEqual([
      [ADA_SECOND.id, false],
      [ADA_FIRST.id, true],
    ]);
    expect(ada.attempts[0].focusMetrics).toEqual({ totalMs: 1000, focusedMs: 750, percentage: 75 });

    const babbage = payload.students.find(s => s.userId === BABBAGE.id)!;
    expect(babbage.currentScore).toBeNull();
    expect(babbage.bestScore).toBeNull();
    expect(babbage.attempts[0].completed_at).toBeNull();
  });

  it("shows every grade as the classroom's emoji (E1), from this classroom's scale", () => {
    expect(mocks.findScaleByClassroomId).toHaveBeenCalledWith(CLASSROOM.id);
    const ada = payload.students.find(s => s.userId === ADA.id)!;
    // 80 is nearest 👍 (85); 60 ties 👀 and 👎 and takes the higher (E5).
    expect(ada).toMatchObject({
      currentEmoji: '+1',
      countedEmoji: null,
      bestEmoji: '+1',
      firstAttemptEmoji: '+1',
      countingAdjusted: false,
      regradeRequested: false,
    });
    expect(ada.attempts.map(a => [a.grade.effective.emoji, a.firstAttemptEmoji])).toEqual([
      ['eyes', '-1'],
      ['+1', '+1'],
    ]);
    const babbage = payload.students.find(s => s.userId === BABBAGE.id)!;
    expect(babbage).toMatchObject({ currentEmoji: null, bestEmoji: null });
    // Average of 60 and 80 is 70 (👀); highest 80 (👍); lowest 60 (👀).
    expect(payload.stats).toEqual({
      totalAttempts: 4,
      completedAttempts: 2,
      inProgressAttempts: 2,
      completionRate: 50,
      averageEmoji: 'eyes',
      highestEmoji: '+1',
      lowestEmoji: 'eyes',
    });
  });

  it("reads each user's login on the classroom's own git provider", async () => {
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: TA.id,
      classroom: { ...CLASSROOM, git_organization: { provider: 'GITLAB' } },
      membership: { role: 'ASSISTANT' },
    });
    await detailRoute.loader(detailArgs());
    expect(mocks.findByQuiz).toHaveBeenLastCalledWith(QUIZ_ID, 'GITLAB');
  });
});

describe('quiz results page: adjustments and regrade requests', () => {
  beforeEach(() => {
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: TA.id,
      classroom: CLASSROOM,
      membership: { role: 'ASSISTANT' },
    });
  });

  it('shows an adjusted attempt by its adjustment, with the original beside it (D6, D8)', async () => {
    // Ada's 60 adjusted to 🚀 becomes the best attempt and counts (D3).
    mocks.findByQuiz.mockResolvedValue([
      { ...ADA_SECOND, adjusted_emoji: 'rocket' },
      TA_PREVIEW,
      BABBAGE_OPEN,
      ADA_FIRST,
    ]);

    const payload = await detailRoute.loader(detailArgs());

    const ada = payload.students.find(s => s.userId === ADA.id)!;
    expect(ada).toMatchObject({
      countingAttemptId: ADA_SECOND.id,
      currentEmoji: 'rocket',
      countingAdjusted: true,
      bestEmoji: 'rocket',
    });
    expect(ada.attempts[0].grade).toMatchObject({
      adjusted: true,
      original: { emoji: 'eyes' },
      effective: { emoji: 'rocket' },
    });
    expect(payload.stats.highestEmoji).toBe('rocket');
  });

  it("marks a student with an open quiz regrade request, read from this classroom's requests on this quiz", async () => {
    // Attempt ids only (the service selects nothing else).
    mocks.openQuizRequestAttemptIds.mockResolvedValue(new Set([ADA_FIRST.id]));

    const payload = await detailRoute.loader(detailArgs());

    expect(mocks.openQuizRequestAttemptIds).toHaveBeenCalledWith(CLASSROOM.id, QUIZ_ID);
    expect(mocks.regradeFindMany).not.toHaveBeenCalled();
    const ada = payload.students.find(s => s.userId === ADA.id)!;
    expect(ada.regradeRequested).toBe(true);
    expect(ada.attempts.map(a => [a.id, a.regradeRequested])).toEqual([
      [ADA_SECOND.id, false],
      [ADA_FIRST.id, true],
    ]);
    expect(payload.students.find(s => s.userId === BABBAGE.id)!.regradeRequested).toBe(false);
    // The request rows themselves never leave.
    expectNoSentinels(payload);
  });
});

// ─── The attempt drawers ────────────────────────────────────────────────────

describe('staff attempt drawer payload', () => {
  it("sends a student's attempt as the fields the drawer reads", async () => {
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: TA.id,
      classroom: CLASSROOM,
      membership: { role: 'ASSISTANT' },
    });
    mocks.findWithMessages.mockResolvedValue(withMessages(ADA_SECOND));

    const payload = await staffAttemptRoute.loader(attemptArgs('assistant', ADA_SECOND.id));

    expect(payload.quiz).toEqual({ id: QUIZ_ID, name: 'Recursion', question_count: 5 });
    expect(payload.attempt).toEqual({
      id: ADA_SECOND.id,
      completed_at: ADA_SECOND.completed_at,
      total_duration_ms: 1000,
      unfocused_duration_ms: 250,
      partial_credit_percentage: 60,
      first_attempt_percentage: 55,
      question_results: [],
      agent_runtime: 'ai_agent',
      evaluation_json: null,
      ended_by: null,
    });
    expect(payload.studentName).toBe('Ada Lovelace');
    expect(payload.userLogin).toBe('ada');
    expect(payload.messages).toHaveLength(1);
    expect(Object.keys(payload).sort()).toEqual(
      [
        'attempt',
        'chatActivity',
        'chatStarted',
        'focusMetrics',
        'gradePanel',
        'isAdmin',
        'messages',
        'messagesLeft',
        'quiz',
        'readOnly',
        'showTimestamps',
        'studentName',
        'transcript',
        'userImage',
        'userLogin',
        'viewerOwnsAttempt',
      ].sort()
    );
    expectNoSentinels(payload);
  });

  it("gives a current student's completed attempt the adjust panel, as emoji only", async () => {
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: TA.id,
      classroom: CLASSROOM,
      membership: { role: 'ASSISTANT' },
    });
    mocks.findWithMessages.mockResolvedValue(
      withMessages({
        ...ADA_SECOND,
        adjusted_emoji: '+1',
        instructor_comment: 'Q3 has full credit.',
        adjusted_by_id: TA.id,
        adjusted_at: new Date('2026-03-04T10:00:00Z'),
        // The comment's own author, apart from the score's adjuster.
        comment_by_id: BABBAGE.id,
        comment_at: new Date('2026-03-03T10:00:00Z'),
      })
    );
    mocks.findOpenByQuizAttemptId.mockResolvedValue({
      id: 'rr-1',
      classroom_id: CLASSROOM.id,
      student_comment: 'Q3 covered the base case.',
      created_at: new Date('2026-03-04T09:00:00Z'),
    });

    const payload = await staffAttemptRoute.loader(attemptArgs('assistant', ADA_SECOND.id));

    expect(mocks.findScaleByClassroomId).toHaveBeenCalledWith(CLASSROOM.id);
    expect(mocks.findByClassroomAndUser).toHaveBeenCalledWith(CLASSROOM.id, ADA.id, 'STUDENT');
    expect(payload.gradePanel).toEqual({
      attemptId: ADA_SECOND.id,
      adjustable: true,
      canEdit: true,
      grade: {
        emoji: '+1',
        originalEmoji: 'eyes',
        adjusted: true,
        band: { evaluation: 'GOOD', numeric_score: 3 },
        lateHours: null,
        countedEmoji: null,
        // Staff views do not work it out (E15 is the student's label).
        countsTowardGrade: null,
      },
      adjustedEmoji: '+1',
      orphaned: false,
      comment: 'Q3 has full credit.',
      adjustedByName: 'Grace Hopper',
      adjustedAt: '2026-03-04T10:00:00.000Z',
      commentByName: BABBAGE.name,
      commentAt: '2026-03-03T10:00:00.000Z',
      scaleEmojis: ['rocket', '+1', 'eyes', '-1', 'sob'],
      // On time: every emoji counts as itself.
      countedByEmoji: { rocket: 'rocket', '+1': '+1', eyes: 'eyes', '-1': '-1', sob: 'sob' },
      openRequest: {
        id: 'rr-1',
        comment: 'Q3 covered the base case.',
        studentName: 'Ada Lovelace',
        createdAt: '2026-03-04T09:00:00.000Z',
      },
    });
    expectNoSentinels(payload);
  });

  it('shows the panel without its controls in a read-only classroom', async () => {
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: TA.id,
      classroom: { ...CLASSROOM, status: 'LOCKED' },
      membership: { role: 'ASSISTANT' },
    });
    mocks.findWithMessages.mockResolvedValue(withMessages(ADA_SECOND));
    const payload = await staffAttemptRoute.loader(attemptArgs('assistant', ADA_SECOND.id));
    expect(payload.gradePanel).toMatchObject({ adjustable: true, canEdit: false });
  });

  it('gives a completed student attempt with no evaluation record the adjust panel too', async () => {
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: TA.id,
      classroom: CLASSROOM,
      membership: { role: 'ASSISTANT' },
    });
    // Completed with no score and no evaluation: the results card won't render,
    // and the drawer still offers the adjustment (QuizResultSlotsFallback).
    const bare = attemptRow('a-ada-bare', ADA, {
      completed_at: new Date('2026-03-02T12:00:00Z'),
      partial_credit_percentage: null,
      first_attempt_percentage: null,
    });
    mocks.findWithMessages.mockResolvedValue({ ...withMessages(bare), messages: [] });

    const payload = await staffAttemptRoute.loader(attemptArgs('assistant', bare.id));

    expect(payload.gradePanel).toMatchObject({
      attemptId: bare.id,
      adjustable: true,
      grade: { emoji: null, adjusted: false },
    });
  });

  it("hides the adjust panel on a staff preview, and drops another classroom's request", async () => {
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: 'owner-1',
      classroom: CLASSROOM,
      membership: { role: 'OWNER' },
    });
    const taDone = attemptRow('a-ta-done', TA, {
      completed_at: new Date('2026-03-02T12:00:00Z'),
      partial_credit_percentage: 95,
    });
    mocks.findWithMessages.mockResolvedValue(withMessages(taDone));
    mocks.findOpenByQuizAttemptId.mockResolvedValue({ id: 'rr-x', classroom_id: 'class-2' });

    const payload = await staffAttemptRoute.loader(attemptArgs('admin', taDone.id));

    expect(payload.gradePanel).toMatchObject({
      adjustable: false,
      grade: { emoji: 'rocket', adjusted: false, band: { evaluation: 'EXCELLENT' } },
      openRequest: null,
    });
  });

  it('measures lateness for a student attempt and shows what it counts for (D2)', async () => {
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: TA.id,
      classroom: { ...CLASSROOM, settings: { late_penalty_points_per_hour: 1 } },
      membership: { role: 'ASSISTANT' },
    });
    // Due 6 h before Ada's second attempt completed; 60 → 54 counts as 👎.
    mocks.quizFindById.mockResolvedValue({
      ...QUIZ_ROW,
      assignment: { id: 'asg-1', student_deadline: new Date('2026-03-03T04:20:00Z') },
    });
    mocks.findWithMessages.mockResolvedValue(withMessages(ADA_SECOND));

    const payload = await staffAttemptRoute.loader(attemptArgs('assistant', ADA_SECOND.id));

    expect(mocks.netQuizExtensionHours).toHaveBeenCalledWith({
      classroomId: CLASSROOM.id,
      studentId: ADA.id,
      assignmentIds: ['asg-1'],
    });
    expect(payload.gradePanel?.grade).toMatchObject({
      emoji: 'eyes',
      lateHours: 6,
      countedEmoji: '-1',
    });
  });
});

describe('student attempt drawer payload', () => {
  it('carries nothing about classmates or the grading prompts', async () => {
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: ADA.id,
      classroom: CLASSROOM,
      membership: { role: 'STUDENT' },
    });
    mocks.findWithMessages.mockResolvedValue(withMessages(ADA_FIRST));

    const payload = await studentAttemptRoute.loader(attemptArgs('student', ADA_FIRST.id));
    const serialized = JSON.stringify(payload);

    // The quiz row joins every attempt on it, classmates' included.
    expect(serialized).not.toContain(BABBAGE.login);
    expect(serialized).not.toContain(BABBAGE.id);
    expect(serialized).not.toContain(TA.login);
    expect('attempts' in payload.quiz).toBe(false);
    expect('rubric_prompt' in payload.quiz).toBe(false);
    expect('system_prompt' in payload.quiz).toBe(false);
    expectNoSentinels(payload);
  });

  it('sends a student no quiz grade number: no score, no credit, no evaluation numbers (E1)', async () => {
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: ADA.id,
      classroom: CLASSROOM,
      membership: { role: 'STUDENT' },
    });
    const graded = {
      ...ADA_FIRST,
      partial_credit_percentage: 73.37,
      first_attempt_percentage: 41.5,
      question_results_json: [
        {
          question_num: 1,
          attempts: 2,
          credit_earned: 66.6,
          eventually_correct: true,
          emoji: 'eyes',
        },
      ],
    };
    const evaluation = {
      quiz_complete: true,
      evaluation: 'GOOD',
      final_acknowledgment: 'Nice work.',
      partial_credit_percentage: 73.37,
      raw_percentage: 74.12,
      question_results: [{ question_num: 1, credit_earned: 66.6 }],
    };
    mocks.findWithMessages.mockResolvedValue({
      ...withMessages(graded as unknown as typeof ADA_FIRST),
      messages: [
        {
          id: 'm9',
          role: 'assistant',
          content: 'Done!\n\n[QUIZ_EVALUATION]\n```json\n' + JSON.stringify(evaluation) + '\n```',
          metadata: null,
          timestamp: new Date(),
        },
      ],
    });

    const payload = await studentAttemptRoute.loader(attemptArgs('student', ADA_FIRST.id));

    const text = JSON.stringify(payload);
    for (const n of ['73.37', '41.5', '74.12', '66.6', 'credit_earned', 'partial_credit']) {
      expect(text).not.toContain(n);
    }
    // The chat still reads the completion and the band.
    expect(payload.messages[0].content).toContain('[QUIZ_EVALUATION]');
    expect(payload.messages[0].content).toContain('"evaluation": "GOOD"');
    expect(payload.attempt.question_results).toEqual([
      expect.objectContaining({ question_num: 1, attempts: 2, emoji: 'eyes' }),
    ]);
  });

  it('sends staff reading a student attempt here what the staff drawer sends', async () => {
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: TA.id,
      classroom: CLASSROOM,
      membership: { role: 'ASSISTANT' },
    });
    mocks.findWithMessages.mockResolvedValue(withMessages(ADA_FIRST));

    const payload = await studentAttemptRoute.loader(attemptArgs('student', ADA_FIRST.id));

    expect(payload.attempt.partial_credit_percentage).toBe(80);
  });

  it('sends exactly the keys the drawer and QuizAttemptInterface take', async () => {
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: ADA.id,
      classroom: CLASSROOM,
      membership: { role: 'STUDENT' },
    });
    mocks.findWithMessages.mockResolvedValue(withMessages(ADA_FIRST));

    const payload = await studentAttemptRoute.loader(attemptArgs('student', ADA_FIRST.id));

    expect(Object.keys(payload).sort()).toEqual(
      [
        'attempt',
        'chatActivity',
        'chatStarted',
        'focusMetrics',
        'isAdmin',
        'messages',
        'messagesLeft',
        'org',
        'quiz',
        'readOnly',
        'result',
        'showTimestamps',
        'transcript',
        'userImage',
        'userLogin',
        'viewerOwnsAttempt',
      ].sort()
    );
    expect(Object.keys(payload.quiz).sort()).toEqual(['id', 'name', 'question_count']);
    expect(Object.keys(payload.attempt).sort()).toEqual(
      [
        'agent_runtime',
        'completed_at',
        'ended_by',
        'evaluation_json',
        'id',
        'question_results',
        'total_duration_ms',
        'unfocused_duration_ms',
      ].sort()
    );
    expect(Object.keys(payload.focusMetrics).sort()).toEqual([
      'focusedMs',
      'percentage',
      'totalMs',
    ]);
    // The student's own transcript, in the shape findWithMessages formats it.
    for (const message of payload.messages) {
      expect(Object.keys(message).sort()).toEqual(
        ['content', 'id', 'metadata', 'role', 'timestamp'].sort()
      );
    }
  });

  it('still gives the drawer what it renders', async () => {
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: ADA.id,
      classroom: CLASSROOM,
      membership: { role: 'STUDENT' },
    });
    mocks.findWithMessages.mockResolvedValue(withMessages(ADA_FIRST));

    const payload = await studentAttemptRoute.loader(attemptArgs('student', ADA_FIRST.id));

    expect(payload.quiz).toEqual({ id: QUIZ_ID, name: 'Recursion', question_count: 5 });
    expect(payload.attempt.id).toBe(ADA_FIRST.id);
    expect(payload.isAdmin).toBe(false);
    expect(payload.readOnly).toBe(true);
    expect(payload.userLogin).toBe('ada');
    expect(payload.messages).toHaveLength(1);
    expect(payload.org).toBe(CLASS_SLUG);
  });

  it('gives the student their grade as emoji, the comment, and their requests on this attempt', async () => {
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: ADA.id,
      classroom: CLASSROOM,
      membership: { role: 'STUDENT' },
    });
    mocks.findWithMessages.mockResolvedValue(
      withMessages({
        ...ADA_FIRST,
        adjusted_emoji: 'rocket',
        instructor_comment: 'Q3 has full credit.',
        adjusted_by_id: BABBAGE.id,
        adjusted_at: new Date('2026-03-05T10:00:00Z'),
        // The comment is signed by its own author, not the last adjuster.
        comment_by_id: TA.id,
        comment_at: new Date('2026-03-04T10:00:00Z'),
      })
    );
    mocks.regradeFindMany.mockResolvedValue([
      {
        id: 'rr-1',
        status: 'APPROVED',
        grader_comment: 'Fixed.',
        previous_grade: ['+1'],
        resolved_emoji: 'rocket',
        created_at: new Date('2026-03-03T10:00:00Z'),
        updated_at: new Date('2026-03-06T10:00:00Z'),
        // The resolver, from the request itself (not the attempt's adjuster).
        resolved_by: { id: 'ta-7', name: 'Ada Lovelace' },
        resolved_at: new Date('2026-03-04T11:00:00Z'),
        student: { email: SENTINEL.email },
      },
    ]);

    const payload = await studentAttemptRoute.loader(attemptArgs('student', ADA_FIRST.id));

    expect(mocks.findScaleByClassroomId).toHaveBeenCalledWith(CLASSROOM.id);
    // Read by attempt, student and classroom, all server-derived.
    expect(mocks.regradeFindMany).toHaveBeenCalledWith({
      quiz_attempt_id: ADA_FIRST.id,
      student_id: ADA.id,
      classroom_id: CLASSROOM.id,
    });
    expect(payload.result).toEqual({
      grade: {
        emoji: 'rocket',
        originalEmoji: '+1',
        adjusted: true,
        band: { evaluation: 'EXCELLENT', numeric_score: 4 },
        lateHours: null,
        countedEmoji: null,
        // Ada's best attempt under HIGHEST (E15).
        countsTowardGrade: true,
      },
      attemptNumber: 1,
      isOwnStudentAttempt: true,
      canRequest: true,
      comment: {
        text: 'Q3 has full credit.',
        byName: 'Grace Hopper',
        at: '2026-03-04T10:00:00.000Z',
      },
      regrade: {
        open: null,
        resolved: {
          id: 'rr-1',
          status: 'APPROVED',
          reply: 'Fixed.',
          previousEmoji: '+1',
          resolvedEmoji: 'rocket',
          resolvedByName: 'Ada Lovelace',
          resolvedAt: '2026-03-04T11:00:00.000Z',
        },
      },
    });
    expectNoSentinels(payload);
  });

  it('offers no request button in a read-only classroom', async () => {
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: ADA.id,
      classroom: { ...CLASSROOM, status: 'UNPUBLISHED' },
      membership: { role: 'STUDENT' },
    });
    mocks.findWithMessages.mockResolvedValue(withMessages(ADA_FIRST));
    mocks.regradeFindMany.mockResolvedValue([]);
    const payload = await studentAttemptRoute.loader(attemptArgs('student', ADA_FIRST.id));
    // No button, but the status of an open request still shows.
    expect(payload.result).toMatchObject({ isOwnStudentAttempt: true, canRequest: false });
  });

  it('reports an open request so the button turns into its status (D7)', async () => {
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: ADA.id,
      classroom: CLASSROOM,
      membership: { role: 'STUDENT' },
    });
    mocks.findWithMessages.mockResolvedValue(withMessages(ADA_FIRST));
    mocks.regradeFindMany.mockResolvedValue([
      { id: 'rr-2', status: 'IN_REVIEW', created_at: new Date('2026-03-05T10:00:00Z') },
      {
        id: 'rr-1',
        status: 'DENIED',
        grader_comment: 'Kept.',
        created_at: new Date('2026-03-03T10:00:00Z'),
      },
    ]);

    const payload = await studentAttemptRoute.loader(attemptArgs('student', ADA_FIRST.id));

    expect(payload.result?.regrade.open).toEqual({
      id: 'rr-2',
      createdAt: '2026-03-05T10:00:00.000Z',
    });
    expect(payload.result?.regrade.resolved).toMatchObject({ id: 'rr-1', status: 'DENIED' });
    // Resolved before the resolver was recorded: no name, no date.
    expect(payload.result?.regrade.resolved).toMatchObject({
      resolvedByName: null,
      resolvedAt: null,
    });
  });

  describe("whether the attempt counts toward the student's grade (E15)", () => {
    const asAda = (classroom: Record<string, unknown> = CLASSROOM) =>
      mocks.assertClassroomAccess.mockResolvedValue({
        userId: ADA.id,
        classroom,
        membership: { role: 'STUDENT' },
      });

    it('flags an attempt the grading strategy does not count, and the one it does', async () => {
      asAda();
      // HIGHEST: the first attempt (80) counts, the second (60) does not.
      mocks.findWithMessages.mockResolvedValue(withMessages(ADA_SECOND));
      const second = await studentAttemptRoute.loader(attemptArgs('student', ADA_SECOND.id));
      expect(second.result?.grade?.countsTowardGrade).toBe(false);
      // Read for the attempt's own student and this quiz only.
      expect(mocks.findForUserByQuizIds).toHaveBeenCalledWith(ADA.id, [QUIZ_ID]);

      mocks.findWithMessages.mockResolvedValue(withMessages(ADA_FIRST));
      const first = await studentAttemptRoute.loader(attemptArgs('student', ADA_FIRST.id));
      expect(first.result?.grade?.countsTowardGrade).toBe(true);
    });

    it('follows the strategy: MOST_RECENT counts the latest attempt', async () => {
      asAda();
      mocks.quizFindById.mockResolvedValue({ ...QUIZ_ROW, grading_strategy: 'MOST_RECENT' });
      mocks.findWithMessages.mockResolvedValue(withMessages(ADA_SECOND));
      const second = await studentAttemptRoute.loader(attemptArgs('student', ADA_SECOND.id));
      expect(second.result?.grade?.countsTowardGrade).toBe(true);
    });

    it('picks over effective, late-penalised scores, as the gradebook does', async () => {
      // Due between the two attempts, 5 points an hour: the second attempt's
      // higher raw score (90) counts for 0, so the on-time first one counts.
      asAda({ ...CLASSROOM, settings: { late_penalty_points_per_hour: 5 } });
      mocks.quizFindById.mockResolvedValue({
        ...QUIZ_ROW,
        assignment: { id: 'asg-1', student_deadline: new Date('2026-03-02T00:00:00Z') },
      });
      const lateBest = { ...ADA_SECOND, partial_credit_percentage: 90 };
      mocks.findForUserByQuizIds.mockResolvedValue([lateBest, ADA_FIRST]);
      mocks.findWithMessages.mockResolvedValue(withMessages(lateBest));
      const payload = await studentAttemptRoute.loader(attemptArgs('student', lateBest.id));
      expect(payload.result?.grade?.countsTowardGrade).toBe(false);

      // A staff adjustment is read as the effective score: the late attempt
      // adjusted to rocket (100) still counts for 0 after the penalty.
      mocks.findForUserByQuizIds.mockResolvedValue([
        { ...lateBest, adjusted_emoji: 'rocket' },
        ADA_FIRST,
      ]);
      mocks.findWithMessages.mockResolvedValue(withMessages(ADA_FIRST));
      const first = await studentAttemptRoute.loader(attemptArgs('student', ADA_FIRST.id));
      expect(first.result?.grade?.countsTowardGrade).toBe(true);
    });

    it('is not worked out for staff reading a student attempt', async () => {
      mocks.assertClassroomAccess.mockResolvedValue({
        userId: TA.id,
        classroom: CLASSROOM,
        membership: { role: 'ASSISTANT' },
      });
      mocks.findWithMessages.mockResolvedValue(withMessages(ADA_SECOND));
      const payload = await studentAttemptRoute.loader(attemptArgs('student', ADA_SECOND.id));
      expect(payload.result?.grade?.countsTowardGrade).toBeNull();
      expect(mocks.findForUserByQuizIds).not.toHaveBeenCalled();
    });
  });

  it('gives staff reading a student attempt here the grade only', async () => {
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: TA.id,
      classroom: CLASSROOM,
      membership: { role: 'ASSISTANT' },
    });
    mocks.findWithMessages.mockResolvedValue(withMessages(ADA_FIRST));

    const payload = await studentAttemptRoute.loader(attemptArgs('student', ADA_FIRST.id));

    expect(mocks.regradeFindMany).not.toHaveBeenCalled();
    expect(payload.result).toMatchObject({
      canRequest: false,
      comment: null,
      regrade: { open: null, resolved: null },
      grade: { emoji: '+1' },
    });
  });
});

describe('quiz results page: lateness', () => {
  const DUE = new Date('2026-03-01T09:00:00Z');
  /** The quiz's assignment as `quiz.findById` joins it: what the zero rule reads. */
  const assignmentRow = (over: Record<string, unknown> = {}) => ({
    id: 'asg-1',
    module_id: 'mod-1',
    type: 'QUIZ',
    is_published: true,
    release_at: null,
    weight: 10,
    is_extra_credit: false,
    student_deadline: DUE,
    ...over,
  });
  const LOVELACE = userRow('stu-lovelace', 'lovelace', 'Augusta King');

  beforeEach(() => {
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: TA.id,
      classroom: CLASSROOM,
      membership: { role: 'ASSISTANT' },
    });
    mocks.findUsersByRole.mockResolvedValue([{ id: ADA.id }, { id: BABBAGE.id }]);
    mocks.netQuizExtensionHoursByStudent.mockResolvedValue(new Map());
  });

  it("measures students' attempts against the due date and the hours they bought, never staff previews", async () => {
    mocks.quizFindById.mockResolvedValue({ ...QUIZ_ROW, assignment: assignmentRow() });
    // Ada's first attempt completed 1h20m after the due date; she bought 1 h.
    mocks.netQuizExtensionHoursByStudent.mockResolvedValue(new Map([[ADA.id, 1]]));
    const taDone = attemptRow('a-ta-done', TA, {
      completed_at: new Date('2026-03-02T12:00:00Z'),
      partial_credit_percentage: 50,
    });
    mocks.findByQuiz.mockResolvedValue([...ATTEMPTS, taDone]);

    const payload = await detailRoute.loader(detailArgs());

    expect(mocks.netQuizExtensionHoursByStudent).toHaveBeenCalledWith({
      classroomId: CLASSROOM.id,
      assignmentId: 'asg-1',
    });
    expect(mocks.findUsersByRole).toHaveBeenCalledWith(CLASSROOM.id, 'STUDENT');
    const ada = payload.students.find(s => s.userId === ADA.id)!;
    expect(ada.attempts.map(a => [a.id, a.lateHours])).toEqual([
      ['a-ada-2', 48],
      ['a-ada-1', 0],
    ]);
    expect(ada.lateHours).toBe(0);
    // An open attempt has no lateness yet; a staff preview never has any.
    const babbage = payload.students.find(s => s.userId === BABBAGE.id)!;
    expect(babbage.attempts[0].lateHours).toBeNull();
    const ta = payload.students.find(s => s.userId === TA.id)!;
    expect(ta.attempts.every(a => a.lateHours === null)).toBe(true);
    expect(ta.lateHours).toBeNull();
  });

  it('reads no hours bought for a quiz with no due date, and marks nothing late or missing', async () => {
    mocks.quizFindById.mockResolvedValue({
      ...QUIZ_ROW,
      assignment: assignmentRow({ student_deadline: null }),
    });
    mocks.findUsersByRole.mockResolvedValue([ADA, BABBAGE, LOVELACE]);

    const payload = await detailRoute.loader(detailArgs());

    expect(mocks.netQuizExtensionHoursByStudent).not.toHaveBeenCalled();
    expect(payload.students.every(s => s.lateHours === null)).toBe(true);
    expect(payload.students.every(s => !s.countsAsZero)).toBe(true);
    // No due date: a student with no attempt has not started, never Missing.
    expect(payload.students.find(s => s.userId === LOVELACE.id)).toMatchObject({
      attemptCount: 0,
      countsAsZero: false,
    });
  });

  it('lists every rostered student, and counts 0 for those past the due date with nothing completed', async () => {
    mocks.quizFindById.mockResolvedValue({ ...QUIZ_ROW, assignment: assignmentRow() });
    mocks.findUsersByRole.mockResolvedValue([ADA, BABBAGE, LOVELACE]);

    const payload = await detailRoute.loader(detailArgs());

    // Students with attempts first, in arrival order; then the rest of the roster.
    expect(payload.students.map(s => s.userId)).toEqual([ADA.id, TA.id, BABBAGE.id, LOVELACE.id]);
    const lovelace = payload.students.find(s => s.userId === LOVELACE.id)!;
    expect(lovelace).toEqual({
      userId: LOVELACE.id,
      user: {
        id: LOVELACE.id,
        name: 'Augusta King',
        login: 'lovelace',
        avatar_url: LOVELACE.image,
      },
      attempts: [],
      attemptCount: 0,
      currentScore: null,
      countedScore: 0,
      lateHours: null,
      countsAsZero: true,
      bestScore: null,
      firstAttemptScore: null,
      countingAttemptId: null,
      countingAdjusted: false,
      countingOrphaned: false,
      latestAttempt: null,
      currentEmoji: null,
      countedEmoji: 'sob',
      bestEmoji: null,
      firstAttemptEmoji: null,
      regradeRequested: false,
    });
    // A running attempt past the due date is still a counted 0.
    const babbage = payload.students.find(s => s.userId === BABBAGE.id)!;
    expect(babbage).toMatchObject({ countsAsZero: true, attemptCount: 1, currentScore: null });
    // A scored attempt counts; a staff preview never counts 0.
    expect(payload.students.find(s => s.userId === ADA.id)!.countsAsZero).toBe(false);
    expect(payload.students.find(s => s.userId === TA.id)!.countsAsZero).toBe(false);
    // The roster's user rows are as wide as any other: nothing extra leaves.
    expectNoSentinels(payload);
  });

  it('shows a rostered student with no attempt as not started before the due date', async () => {
    mocks.quizFindById.mockResolvedValue({
      ...QUIZ_ROW,
      assignment: assignmentRow({ student_deadline: new Date('2099-01-01T00:00:00Z') }),
    });
    mocks.findUsersByRole.mockResolvedValue([LOVELACE]);

    const payload = await detailRoute.loader(detailArgs());

    expect(payload.students.find(s => s.userId === LOVELACE.id)).toMatchObject({
      attemptCount: 0,
      countsAsZero: false,
      countedScore: null,
    });
  });

  it('the zero waits for the hours a student bought', async () => {
    // Due 2 h ago; Lovelace bought 5 h.
    const due = new Date(Date.now() - 2 * 3_600_000);
    mocks.quizFindById.mockResolvedValue({
      ...QUIZ_ROW,
      assignment: assignmentRow({ student_deadline: due }),
    });
    mocks.findUsersByRole.mockResolvedValue([LOVELACE]);
    mocks.netQuizExtensionHoursByStudent.mockResolvedValue(new Map([[LOVELACE.id, 5]]));

    const payload = await detailRoute.loader(detailArgs());

    expect(payload.students.find(s => s.userId === LOVELACE.id)!.countsAsZero).toBe(false);
  });

  it('nobody counts 0 while the quiz is not open to students', async () => {
    mocks.quizFindById.mockResolvedValue({
      ...QUIZ_ROW,
      assignment: assignmentRow({ is_published: false }),
    });
    mocks.findUsersByRole.mockResolvedValue([LOVELACE]);

    const payload = await detailRoute.loader(detailArgs());

    expect(payload.students.find(s => s.userId === LOVELACE.id)!.countsAsZero).toBe(false);
  });
});

// ─── The grading-strategy rules, directly ───────────────────────────────────

describe('buildQuizResultRows', () => {
  const rows = (gradingStrategy: string) =>
    buildQuizResultRows({
      attempts: ATTEMPTS,
      gradingStrategy,
      viewerId: 'nobody',
      emojiScale: SCALE,
    });

  it('counts the most recently completed attempt under MOST_RECENT', () => {
    const ada = rows('MOST_RECENT').students.find(s => s.userId === ADA.id)!;
    expect(ada.countingAttemptId).toBe(ADA_SECOND.id);
    expect(ada.currentScore).toBe(60);
    expect(ada.firstAttemptScore).toBe(55);
    expect(ada.bestScore).toBe(80);
  });

  it('counts the earliest started attempt under FIRST', () => {
    const ada = rows('FIRST').students.find(s => s.userId === ADA.id)!;
    expect(ada.countingAttemptId).toBe(ADA_FIRST.id);
    expect(ada.currentScore).toBe(80);
  });

  it('falls back to HIGHEST for an unknown strategy', () => {
    const ada = rows('SOMETHING_NEW').students.find(s => s.userId === ADA.id)!;
    expect(ada.countingAttemptId).toBe(ADA_FIRST.id);
  });

  it('reports no focus metrics without a positive total duration', () => {
    const babbage = rows('HIGHEST').students.find(s => s.userId === BABBAGE.id)!;
    expect(babbage.attempts[0].focusMetrics).toBeNull();
  });

  it('keeps students in the order their first attempt arrives', () => {
    expect(rows('HIGHEST').students.map(s => s.userId)).toEqual([ADA.id, TA.id, BABBAGE.id]);
  });

  it('returns no viewer attempt for a viewer who has none', () => {
    expect(rows('HIGHEST').viewerAttempt).toBeNull();
  });

  it('counts a 0 as a score and never counts a completed attempt without one', () => {
    const zero = attemptRow('a-ada-zero', ADA, {
      started_at: new Date('2026-03-04T10:00:00Z'),
      completed_at: new Date('2026-03-04T10:20:00Z'),
      partial_credit_percentage: 0,
    });
    const unscored = attemptRow('a-ada-unscored', ADA, {
      started_at: new Date('2026-03-05T10:00:00Z'),
      completed_at: new Date('2026-03-05T10:20:00Z'),
      partial_credit_percentage: null,
    });
    const { students } = buildQuizResultRows({
      attempts: [unscored, zero],
      gradingStrategy: 'MOST_RECENT',
      viewerId: 'nobody',
      emojiScale: SCALE,
    });

    expect(students[0].countingAttemptId).toBe(zero.id);
    expect(students[0].currentScore).toBe(0);
    expect(students[0].countingOrphaned).toBe(false);
  });

  it("flags an orphaned adjustment on the counting attempt and counts the AI's grade (E17)", () => {
    const orphan = attemptRow('a-ada-orphan', ADA, {
      started_at: new Date('2026-03-04T10:00:00Z'),
      completed_at: new Date('2026-03-04T10:20:00Z'),
      partial_credit_percentage: 72,
      adjusted_emoji: 'heart',
    });
    const { students } = buildQuizResultRows({
      attempts: [orphan],
      gradingStrategy: 'HIGHEST',
      viewerId: 'nobody',
      emojiScale: SCALE,
    });

    expect(students[0]).toMatchObject({
      countingAttemptId: orphan.id,
      currentScore: 72,
      countingAdjusted: false,
      countingOrphaned: true,
    });
    expect(students[0].attempts[0].grade).toMatchObject({ orphaned: true, adjusted: false });
  });

  it('counts the attempt that scores best after the late penalty, and shows its raw score', () => {
    const late = {
      studentDeadline: new Date('2026-03-01T00:00:00Z'),
      latePenaltyPerHour: 1,
      extensionHours: new Map<string, number>(),
      studentIds: new Set([ADA.id]),
    };
    // Ada's 80 completed 10 h late counts 70; her 60, 58 h late, counts 2.
    const { students } = buildQuizResultRows({
      attempts: [ADA_SECOND, ADA_FIRST],
      gradingStrategy: 'HIGHEST',
      viewerId: 'nobody',
      emojiScale: SCALE,
      late,
    });
    expect(students[0]).toMatchObject({
      countingAttemptId: ADA_FIRST.id,
      currentScore: 80,
      countedScore: 70,
      lateHours: 10,
    });

    // At 10 points an hour both floor at 0; the tie goes to the one completed first.
    const harsh = buildQuizResultRows({
      attempts: [ADA_SECOND, ADA_FIRST],
      gradingStrategy: 'HIGHEST',
      viewerId: 'nobody',
      emojiScale: SCALE,
      late: { ...late, latePenaltyPerHour: 10 },
    });
    expect(harsh.students[0]).toMatchObject({ countedScore: 0, lateHours: 10 });
  });
});

describe('an orphaned adjustment in the staff drawer payload (E17)', () => {
  const scale = { rocket: 100, '+1': 90, eyes: 80, '-1': 60, sob: 0 };
  const attempt = {
    id: 'att-o',
    started_at: '2026-03-01T10:00:00Z',
    completed_at: '2026-03-01T11:00:00Z',
    partial_credit_percentage: 72,
    adjusted_emoji: 'heart',
  };

  it("flags it for staff and shows the AI's grade; the student's view is unchanged", () => {
    const grade = attemptGradeView({ attempt, emojiScale: scale });
    const panel = staffAttemptGradePanel({
      attempt,
      adjustable: true,
      canEdit: true,
      grade,
      adjustedByName: 'Grace Hopper',
      commentByName: null,
      emojiScale: scale,
      latePenaltyPerHour: 0,
      openRequest: null,
      studentName: null,
    });
    expect(panel).toMatchObject({ orphaned: true, adjustedEmoji: 'heart' });
    expect(panel.grade).toMatchObject({ emoji: 'eyes', adjusted: false, originalEmoji: null });
    // What a student is sent carries no orphan flag.
    expect(grade).not.toHaveProperty('orphaned');
  });

  it('is not orphaned when the emoji is on the scale', () => {
    const onScale = { ...attempt, adjusted_emoji: '+1' };
    const panel = staffAttemptGradePanel({
      attempt: onScale,
      adjustable: true,
      canEdit: true,
      grade: attemptGradeView({ attempt: onScale, emojiScale: scale }),
      adjustedByName: null,
      commentByName: null,
      emojiScale: scale,
      latePenaltyPerHour: 0,
      openRequest: null,
      studentName: null,
    });
    expect(panel.orphaned).toBe(false);
  });
});
