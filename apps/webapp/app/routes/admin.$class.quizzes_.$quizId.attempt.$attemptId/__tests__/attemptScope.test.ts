import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The instructor transcript view — reads stay inside the authorized classroom.
 *
 * The policy this loader implements is deliberately broad: staff read any of
 * their students' attempts, with no ownership check. What makes that safe is
 * the chain of bindings underneath it. `params.class` authorizes a classroom,
 * step 2 holds the quiz against that classroom, and step 3 holds the attempt
 * against that quiz — `quizAttempt.findWithMessages` resolves an attempt by id
 * alone, so without the last link "any student's attempt" reaches every
 * transcript in the database, other classrooms included.
 *
 * The route is re-exported unchanged at the /teacher and /assistant prefixes,
 * so the same loader is what those roles get.
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
  QuizAttemptNotFoundError: class QuizAttemptNotFoundError extends Error {},
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
  useLocation: () => ({ pathname: '/admin/cs52-26f/quizzes/quiz-1/attempt/attempt-1' }),
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
// The service's own "no such attempt" signal, taken from the mocked module so
// the route's instanceof check sees the same class it does in production.
const { QuizAttemptNotFoundError } = (await import('@classmoji/services')) as unknown as {
  QuizAttemptNotFoundError: new (message?: string) => Error;
};

const CLASS_SLUG = 'cs52-26f';
const CLASSROOM = { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE' };
const QUIZ_ID = 'quiz-1';
const QUIZ = { id: QUIZ_ID, name: 'Recursion', classroom_id: 'class-1' };

/** A student's attempt on this classroom's quiz — the case staff must see. */
const STUDENT_ATTEMPT = {
  id: 'attempt-1',
  quiz_id: QUIZ_ID,
  user_id: 'student-1',
  completed_at: new Date('2026-02-01'),
  total_duration_ms: 1000,
  unfocused_duration_ms: 250,
  agent_config: { anthropic_api_key: 'sk-must-not-leak' },
  user: { id: 'student-1', name: 'Ada Lovelace', login: 'ada' },
  quiz: { id: QUIZ_ID, classroom: { id: 'class-1', settings: { anthropic_api_key: 'sk-nope' } } },
};

/** The same shape, but sat on a quiz in another classroom entirely. */
const FOREIGN_ATTEMPT = {
  ...STUDENT_ATTEMPT,
  id: 'attempt-elsewhere',
  quiz_id: 'quiz-elsewhere',
  user_id: 'student-9',
  quiz: { id: 'quiz-elsewhere', classroom: { id: 'class-2', settings: {} } },
};

const loaderArgs = (attemptId: string) =>
  ({
    params: { class: CLASS_SLUG, quizId: QUIZ_ID, attemptId },
    request: new Request(
      `http://localhost/admin/${CLASS_SLUG}/quizzes/${QUIZ_ID}/attempt/${attemptId}`
    ),
  }) as unknown as Parameters<typeof route.loader>[0];

const load = (attemptId = 'attempt-1') => route.loader(loaderArgs(attemptId));

describe('quiz attempt transcript loader — reads stay inside the authorized classroom', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    assertAccessMock.mockResolvedValue({
      userId: 'owner-1',
      classroom: CLASSROOM,
      membership: { role: 'OWNER' },
    });
    assertProTierMock.mockResolvedValue(undefined);
    quizFindByIdMock.mockResolvedValue(QUIZ);
    findWithMessagesMock.mockResolvedValue({
      attempt: STUDENT_ATTEMPT,
      messages: [{ id: 'm1', role: 'assistant', content: 'Question 1' }],
    });
  });

  it("serves a student's transcript to staff who never sat it", async () => {
    // The policy: no ownership check. Staff read their students' attempts.
    const data = await load();

    expect(data.quiz).toEqual(QUIZ);
    expect(data.attempt.id).toBe('attempt-1');
    expect(data.studentName).toBe('Ada Lovelace');
    expect(data.messages).toHaveLength(1);
    expect(data.readOnly).toBe(true);
    expect(data.focusMetrics).toEqual({ totalMs: 1000, focusedMs: 750, percentage: 75 });
    // Nothing carrying a key reaches the browser.
    expect(data.attempt).not.toHaveProperty('agent_config');
    expect(data.attempt.quiz.classroom).toEqual({ id: 'class-1', settings: undefined });
  });

  it("refuses an attempt sat on another classroom's quiz", async () => {
    findWithMessagesMock.mockResolvedValue({ attempt: FOREIGN_ATTEMPT, messages: [] });

    const thrown = (await load('attempt-elsewhere').catch(e => e)) as Response;

    expect(thrown).toBeInstanceOf(Response);
    expect(thrown.status).toBe(404);
    expect(await thrown.text()).toBe('Attempt not found');
  });

  it('answers an out-of-scope attempt id exactly as it answers one that names nothing', async () => {
    findWithMessagesMock.mockResolvedValue({ attempt: FOREIGN_ATTEMPT, messages: [] });
    const foreign = (await load('attempt-elsewhere').catch(e => e)) as Response;

    // `findWithMessages` throws rather than returning null when there is no
    // such attempt; both paths have to end at the same answer.
    findWithMessagesMock.mockRejectedValue(new QuizAttemptNotFoundError('Attempt not found'));
    const missing = (await load('attempt-missing').catch(e => e)) as Response;

    expect(missing).toBeInstanceOf(Response);
    expect(missing.status).toBe(foreign.status);
    expect(await missing.text()).toBe(await foreign.text());
  });

  it('lets a query failure surface instead of reporting the attempt as absent', async () => {
    // Only the service's "no such attempt" becomes a 404. A dropped connection
    // read as one would tell staff the transcript does not exist, and log
    // nothing that says otherwise.
    findWithMessagesMock.mockRejectedValue(new Error('connection pool timeout'));

    const thrown = (await load().catch(e => e)) as Error;

    expect(thrown).not.toBeInstanceOf(Response);
    expect(thrown.message).toBe('connection pool timeout');
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
