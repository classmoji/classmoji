import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The attempt view under the /student prefix — reads stay inside the
 * authorized classroom.
 *
 * This loader serves two audiences from one body: a student reading their own
 * attempt, and staff reading a student's. That second audience is why the
 * ownership check exempts OWNER/TEACHER/ASSISTANT — and why the attempt has to
 * be held against the quiz. `quizAttempt.findWithMessages` resolves an attempt
 * by id alone, so an exemption from ownership is an exemption from the only
 * thing that was scoping the read at all.
 *
 * The quiz is already bound to the classroom `params.class` authorized, so
 * binding the attempt to that quiz is what keeps the staff view inside it. The
 * binding is checked ahead of ownership, so an attempt from elsewhere is never
 * confirmed to exist by a 403.
 */

const quizFindByIdMock = vi.fn();
const findWithMessagesMock = vi.fn();
const assertAccessMock = vi.fn();
const assertProTierMock = vi.fn();

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    quiz: { findById: (...a: unknown[]) => quizFindByIdMock(...a) },
    quizAttempt: { findWithMessages: (...a: unknown[]) => findWithMessagesMock(...a) },
  },
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => assertAccessMock(...a),
  assertProTier: (...a: unknown[]) => assertProTierMock(...a),
}));

// The loader is what is under test; the view layer only needs to import.
vi.mock('~/hooks', () => ({
  useRouteDrawer: () => ({ opened: true }),
  useDarkMode: () => ({ isDarkMode: false }),
}));
vi.mock('~/components', () => ({ QuizAttemptInterface: () => null }));
vi.mock('react-router', () => ({
  useLocation: () => ({ pathname: '/student/cs52-26f/quizzes/quiz-1/attempt/attempt-1' }),
  useNavigate: () => () => {},
  useParams: () => ({}),
}));
vi.mock('antd', () => ({
  Drawer: () => null,
  ConfigProvider: () => null,
  Modal: () => null,
  theme: { darkAlgorithm: {}, defaultAlgorithm: {} },
}));

const route = await import('../route.tsx');

const CLASS_SLUG = 'cs52-26f';
const CLASSROOM = { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE' };
const QUIZ_ID = 'quiz-1';
const QUIZ = { id: QUIZ_ID, name: 'Recursion', classroom_id: 'class-1' };

/** The signed-in student's own attempt on this classroom's quiz. */
const OWN_ATTEMPT = {
  id: 'attempt-1',
  quiz_id: QUIZ_ID,
  user_id: 'student-1',
  completed_at: null,
  total_duration_ms: 1000,
  unfocused_duration_ms: 250,
  agent_config: { anthropic_api_key: 'sk-must-not-leak' },
  user: { id: 'student-1', name: 'Ada Lovelace', login: 'ada' },
  quiz: { id: QUIZ_ID, classroom: { id: 'class-1', settings: { anthropic_api_key: 'sk-nope' } } },
};

/** The same shape, sat by someone else on a quiz in another classroom. */
const FOREIGN_ATTEMPT = {
  ...OWN_ATTEMPT,
  id: 'attempt-elsewhere',
  quiz_id: 'quiz-elsewhere',
  user_id: 'student-9',
  quiz: { id: 'quiz-elsewhere', classroom: { id: 'class-2', settings: {} } },
};

const asStaff = () =>
  assertAccessMock.mockResolvedValue({
    userId: 'owner-1',
    classroom: CLASSROOM,
    membership: { role: 'OWNER' },
  });

const loaderArgs = (attemptId: string) =>
  ({
    params: { class: CLASS_SLUG, quizId: QUIZ_ID, attemptId },
    request: new Request(
      `http://localhost/student/${CLASS_SLUG}/quizzes/${QUIZ_ID}/attempt/${attemptId}`
    ),
  }) as unknown as Parameters<typeof route.loader>[0];

const load = (attemptId = 'attempt-1') => route.loader(loaderArgs(attemptId));

describe('student quiz attempt loader — reads stay inside the authorized classroom', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    assertAccessMock.mockResolvedValue({
      userId: 'student-1',
      classroom: CLASSROOM,
      membership: { role: 'STUDENT' },
    });
    assertProTierMock.mockResolvedValue(undefined);
    quizFindByIdMock.mockResolvedValue(QUIZ);
    findWithMessagesMock.mockResolvedValue({
      attempt: OWN_ATTEMPT,
      messages: [{ id: 'm1', role: 'assistant', content: 'Question 1' }],
    });
  });

  it("serves a student their own attempt on this classroom's quiz", async () => {
    const data = await load();

    expect(data.quiz).toEqual(QUIZ);
    expect(data.attempt.id).toBe('attempt-1');
    expect(data.messages).toHaveLength(1);
    expect(data.isAdmin).toBe(false);
    expect(data.focusMetrics).toEqual({ totalMs: 1000, focusedMs: 750, percentage: 75 });
    // Nothing carrying a key reaches the browser.
    expect(data.attempt).not.toHaveProperty('agent_config');
    expect(data.attempt.quiz.classroom).toEqual({ id: 'class-1', settings: undefined });
  });

  it("serves staff a student's attempt on this quiz without owning it", async () => {
    // The ownership exemption staff have here is the point of the route.
    asStaff();

    const data = await load();

    expect(data.attempt.id).toBe('attempt-1');
    expect(data.isAdmin).toBe(true);
  });

  it("refuses staff an attempt sat on another classroom's quiz", async () => {
    // Exempt from ownership, so the quiz binding is the only thing left holding
    // this read inside the classroom `params.class` authorized.
    asStaff();
    findWithMessagesMock.mockResolvedValue({ attempt: FOREIGN_ATTEMPT, messages: [] });

    const thrown = (await load('attempt-elsewhere').catch(e => e)) as Response;

    expect(thrown).toBeInstanceOf(Response);
    expect(thrown.status).toBe(404);
    expect(await thrown.text()).toBe('Attempt not found');
  });

  it("refuses a student an attempt sat on another classroom's quiz", async () => {
    findWithMessagesMock.mockResolvedValue({ attempt: FOREIGN_ATTEMPT, messages: [] });

    const thrown = (await load('attempt-elsewhere').catch(e => e)) as Response;

    // 404 from the binding, not 403 from ownership: the id is never confirmed.
    expect(thrown.status).toBe(404);
    expect(await thrown.text()).toBe('Attempt not found');
  });

  it('answers an out-of-scope attempt id exactly as it answers one that names nothing', async () => {
    asStaff();
    findWithMessagesMock.mockResolvedValue({ attempt: FOREIGN_ATTEMPT, messages: [] });
    const foreign = (await load('attempt-elsewhere').catch(e => e)) as Response;

    // `findWithMessages` throws rather than returning null when there is no
    // such attempt; both paths have to end at the same answer.
    findWithMessagesMock.mockRejectedValue(new Error('Attempt not found'));
    const missing = (await load('attempt-missing').catch(e => e)) as Response;

    expect(missing).toBeInstanceOf(Response);
    expect(missing.status).toBe(foreign.status);
    expect(await missing.text()).toBe(await foreign.text());
  });

  it("keeps refusing a student another student's attempt on this same quiz", async () => {
    findWithMessagesMock.mockResolvedValue({
      attempt: { ...OWN_ATTEMPT, id: 'attempt-peer', user_id: 'student-2' },
      messages: [],
    });

    const thrown = (await load('attempt-peer').catch(e => e)) as Response;

    expect(thrown.status).toBe(403);
  });

  it('refuses a quiz belonging to another classroom before it looks at the attempt', async () => {
    quizFindByIdMock.mockResolvedValue({ ...QUIZ, classroom_id: 'class-2' });

    const thrown = (await load().catch(e => e)) as Response;

    expect(thrown.status).toBe(404);
    expect(await thrown.text()).toBe('Quiz not found');
    expect(findWithMessagesMock).not.toHaveBeenCalled();
  });

  it('reads nothing when the authorization gate throws', async () => {
    assertAccessMock.mockRejectedValue(new Response('Forbidden', { status: 403 }));

    await expect(load()).rejects.toBeInstanceOf(Response);
    expect(quizFindByIdMock).not.toHaveBeenCalled();
    expect(findWithMessagesMock).not.toHaveBeenCalled();
  });
});
