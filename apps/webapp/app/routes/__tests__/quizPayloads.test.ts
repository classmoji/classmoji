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
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertProTier: (...a: unknown[]) => mocks.assertProTier(...a),
  addAuditLog: (...a: unknown[]) => mocks.addAuditLog(...a),
  addClassroomAuditLog: vi.fn(),
}));
vi.mock('~/utils/routeAuth.server', () => ({ assertClassroomMutationAllowed: vi.fn() }));
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
      clearForUserAndQuiz: vi.fn(),
    },
    user: { findById: (...a: unknown[]) => mocks.userFindById(...a) },
  },
  QuizAttemptNotFoundError: class QuizAttemptNotFoundError extends Error {},
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
  useLocation: () => ({ pathname: '/assistant/cs52-26f/quizzes/quiz-1' }),
  useNavigate: () => vi.fn(),
  useParams: () => ({ class: 'cs52-26f', quizId: 'quiz-1' }),
  useFetcher: () => ({ submit: vi.fn() }),
  Outlet: () => null,
}));

const detailRoute = await import('../admin.$class.quizzes_.$quizId.tsx');
const staffAttemptRoute =
  await import('../admin.$class.quizzes_.$quizId.attempt.$attemptId/route.tsx');
const studentAttemptRoute =
  await import('../student.$class.quizzes.$quizId.attempt.$attemptId/route.tsx');
const { buildQuizResultRows } = await import('~/utils/quizPayloads');

// ─── Fixtures shaped like the real joins ────────────────────────────────────

const CLASS_SLUG = 'cs52-26f';
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
          'firstAttemptScore',
          'focusMetrics',
          'id',
          'isCounting',
          'partialCreditScore',
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
        'isAdmin',
        'messages',
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
        'org',
        'quiz',
        'readOnly',
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
        'evaluation_json',
        'first_attempt_percentage',
        'id',
        'partial_credit_percentage',
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
});

// ─── The grading-strategy rules, directly ───────────────────────────────────

describe('buildQuizResultRows', () => {
  const rows = (gradingStrategy: string) =>
    buildQuizResultRows({ attempts: ATTEMPTS, gradingStrategy, viewerId: 'nobody' });

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
});
