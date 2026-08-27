import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The instructor quiz-preview view — reads stay inside the authorized classroom.
 *
 * Preview is stricter than the transcript view next door: staff preview as
 * themselves, so the attempt has to be their own. That ownership check was
 * already here, but it was the only thing holding the attempt down —
 * `quizAttempt.findWithMessages` resolves by id alone, so an attempt sat on a
 * quiz in some other classroom still rendered under this classroom's quiz.
 *
 * Order matters in the two checks: the quiz binding answers 404 first, so an id
 * from elsewhere is never confirmed to exist by a 403.
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
  useLocation: () => ({ pathname: '/admin/cs52-26f/quizzes/quiz-1/preview/attempt-1' }),
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

/** The previewing instructor's own attempt on this classroom's quiz. */
const OWN_ATTEMPT = {
  id: 'attempt-1',
  quiz_id: QUIZ_ID,
  user_id: 'owner-1',
  completed_at: null,
  total_duration_ms: 0,
  unfocused_duration_ms: 0,
  agent_config: { instructorRepoName: 'demo-repo' },
  user: { id: 'owner-1', name: 'Grace Hopper', login: 'grace' },
  quiz: { id: QUIZ_ID, classroom: { id: 'class-1', settings: { anthropic_api_key: 'sk-nope' } } },
};

const loaderArgs = (attemptId: string) =>
  ({
    params: { class: CLASS_SLUG, quizId: QUIZ_ID, attemptId },
    request: new Request(
      `http://localhost/admin/${CLASS_SLUG}/quizzes/${QUIZ_ID}/preview/${attemptId}`
    ),
  }) as unknown as Parameters<typeof route.loader>[0];

const load = (attemptId = 'attempt-1') => route.loader(loaderArgs(attemptId));

describe('quiz preview loader — reads stay inside the authorized classroom', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    assertAccessMock.mockResolvedValue({
      userId: 'owner-1',
      classroom: CLASSROOM,
      membership: { role: 'OWNER' },
    });
    assertProTierMock.mockResolvedValue(undefined);
    quizFindByIdMock.mockResolvedValue(QUIZ);
    findWithMessagesMock.mockResolvedValue({ attempt: OWN_ATTEMPT, messages: [] });
  });

  it("serves the instructor's own preview attempt on this quiz", async () => {
    const data = await load();

    expect(data.quiz).toEqual(QUIZ);
    expect(data.attempt.id).toBe('attempt-1');
    expect(data.readOnly).toBe(false);
    expect(data.attempt).not.toHaveProperty('agent_config');
    expect(data.attempt.quiz.classroom).toEqual({ id: 'class-1', settings: undefined });
  });

  it("refuses an attempt sat on another classroom's quiz, before checking whose it is", async () => {
    // Owned by the caller, so ownership alone would have let it through — the
    // quiz binding is what stops it, and it answers 404 rather than 403.
    findWithMessagesMock.mockResolvedValue({
      attempt: { ...OWN_ATTEMPT, id: 'attempt-elsewhere', quiz_id: 'quiz-elsewhere' },
      messages: [],
    });

    const thrown = (await load('attempt-elsewhere').catch(e => e)) as Response;

    expect(thrown).toBeInstanceOf(Response);
    expect(thrown.status).toBe(404);
    expect(await thrown.text()).toBe('Attempt not found');
  });

  it('answers an out-of-scope attempt id exactly as it answers one that names nothing', async () => {
    findWithMessagesMock.mockResolvedValue({
      attempt: { ...OWN_ATTEMPT, id: 'attempt-elsewhere', quiz_id: 'quiz-elsewhere' },
      messages: [],
    });
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
    // Only the service's "no such attempt" becomes a 404; a dropped connection
    // keeps its error, and its log line.
    findWithMessagesMock.mockRejectedValue(new Error('connection pool timeout'));

    const thrown = (await load().catch(e => e)) as Error;

    expect(thrown).not.toBeInstanceOf(Response);
    expect(thrown.message).toBe('connection pool timeout');
  });

  it("keeps refusing another user's attempt on this same quiz", async () => {
    // Preview is sat as yourself: a student's attempt on this quiz stays 403,
    // which is what the transcript route next door is for.
    findWithMessagesMock.mockResolvedValue({
      attempt: { ...OWN_ATTEMPT, id: 'attempt-student', user_id: 'student-1' },
      messages: [],
    });

    const thrown = (await load('attempt-student').catch(e => e)) as Response;

    expect(thrown.status).toBe(403);
  });

  it('reads nothing when the authorization gate throws', async () => {
    assertAccessMock.mockRejectedValue(new Response('Forbidden', { status: 403 }));

    await expect(load()).rejects.toBeInstanceOf(Response);
    expect(quizFindByIdMock).not.toHaveBeenCalled();
    expect(findWithMessagesMock).not.toHaveBeenCalled();
  });
});
