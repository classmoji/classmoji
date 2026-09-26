/**
 * The student quiz list's payload.
 *
 * `quiz.getQuizzesForStudent` spreads each of the student's attempt rows into
 * its result, so every attempt carried the agent config, the session token,
 * the grading columns and the codebase path alongside what the attempts table
 * shows. The list stays mounted under the attempt drawer and revalidates with
 * it, so that went out on every poll. The loader now narrows each attempt, and
 * the per-quiz summary, to the fields the list reads (~/utils/quizPayloads).
 *
 * The REAL service map runs here, against a fake of the one query it makes,
 * so the test feeds the loader exactly the shape the service hands it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  quizFindMany: vi.fn(),
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({ quiz: { findMany: (...a: unknown[]) => mocks.quizFindMany(...a) } }),
}));
// Pulled in by quiz.service; nothing here sends a notification.
vi.mock('../../../../../../packages/services/src/classmoji/notification.service.ts', () => ({}));

vi.mock('@classmoji/services', async () => {
  const quiz = await import('../../../../../../packages/services/src/classmoji/quiz.service.ts');
  return {
    ClassmojiService: {
      quiz,
      classroom: { getClassroomSettingsForServer: async () => ({ quizzes_enabled: true }) },
      user: { findById: async () => ({ id: 'stu-ada', login: 'ada' }) },
    },
    QuizAccessError: quiz.QuizAccessError,
  };
});

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertProTier: async () => undefined,
}));

// The loader is under test; the view layer only needs to import.
vi.mock('~/components', () => ({ Countdown: () => null }));
vi.mock('~/utils/quizUtils', () => ({ formatDuration: () => '' }));
vi.mock('antd', () => ({
  Table: () => null,
  Badge: () => null,
  Typography: { Text: () => null },
  Button: () => null,
  Modal: Object.assign(() => null, { confirm: vi.fn(), error: vi.fn(), warning: vi.fn() }),
  Tag: () => null,
  Tooltip: () => null,
  Space: () => null,
  Select: () => null,
  Spin: () => null,
}));
vi.mock('@ant-design/icons', () => ({
  CheckCircleOutlined: () => null,
  PlayCircleOutlined: () => null,
  TrophyOutlined: () => null,
}));
vi.mock('react-router', () => ({
  Outlet: () => null,
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/student/cs52-26f/quizzes' }),
}));

const route = await import('../route.tsx');

const CLASS_SLUG = 'cs52-26f';

const SENTINEL = {
  systemPrompt: 'SENTINEL-SYSTEM-PROMPT',
  rubricPrompt: 'SENTINEL-RUBRIC-PROMPT',
  sessionToken: 'SENTINEL-SESSION-TOKEN',
  codebasePath: 'SENTINEL-CODEBASE-PATH',
  feedback: 'SENTINEL-FEEDBACK',
  questionResults: 'SENTINEL-QUESTION-RESULTS',
  conversation: 'SENTINEL-CONVERSATION',
};

const attemptRow = (id: string, over: Record<string, unknown>) => ({
  id,
  quiz_id: 'quiz-1',
  user_id: 'stu-ada',
  conversation_id: `${SENTINEL.conversation}-${id}`,
  started_at: new Date('2026-03-01T10:00:00Z'),
  completed_at: null,
  score: null,
  feedback: SENTINEL.feedback,
  attempt_number: 1,
  questions_asked: 3,
  session_token: `${SENTINEL.sessionToken}-${id}`,
  last_activity: new Date('2026-03-01T10:30:00Z'),
  total_duration_ms: null,
  unfocused_duration_ms: null,
  modal_closed_at: null,
  question_results_json: { note: SENTINEL.questionResults },
  partial_credit_percentage: null,
  first_attempt_percentage: null,
  session_status: 'active',
  codebase_path: SENTINEL.codebasePath,
  // The shape the agent config takes when a quiz session stores its prompts.
  agent_config: { systemPrompt: SENTINEL.systemPrompt, rubricPrompt: SENTINEL.rubricPrompt },
  created_at: new Date('2026-03-01T10:00:00Z'),
  updated_at: new Date('2026-03-01T10:30:00Z'),
  ...over,
});

// Newest first, the order the service queries them in.
const IN_PROGRESS = attemptRow('attempt-2', { started_at: new Date('2026-03-02T10:00:00Z') });
const COMPLETED = attemptRow('attempt-1', {
  completed_at: new Date('2026-03-01T10:20:00Z'),
  partial_credit_percentage: 85,
  total_duration_ms: 1000,
  unfocused_duration_ms: 100,
});

const QUIZ_ROW = {
  id: 'quiz-1',
  classroom_id: 'class-1',
  repository_id: null,
  repository: null,
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
  attempts: [IN_PROGRESS, COMPLETED],
};

const load = () =>
  route.loader({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/student/${CLASS_SLUG}/quizzes`),
  } as never);

beforeEach(() => {
  mocks.assertClassroomAccess.mockReset();
  mocks.quizFindMany.mockReset();
  mocks.assertClassroomAccess.mockResolvedValue({
    userId: 'stu-ada',
    classroom: { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE' },
    membership: { role: 'STUDENT', classroom_id: 'class-1', user_id: 'stu-ada' },
  });
  mocks.quizFindMany.mockResolvedValue([QUIZ_ROW]);
});

describe('student quiz list payload', () => {
  it('gives each attempt exactly the fields the attempts table and tabs read', async () => {
    const payload = await load();
    const attempts = payload.quizzes[0].attempts;

    expect(attempts).toHaveLength(2);
    for (const attempt of attempts) {
      expect(Object.keys(attempt).sort()).toEqual(
        [
          'attemptNumber',
          'completed_at',
          'focusMetrics',
          'id',
          'isCounting',
          'partialCreditScore',
          'status',
        ].sort()
      );
      for (const field of [
        'agent_config',
        'session_token',
        'question_results_json',
        'codebase_path',
        'feedback',
        'conversation_id',
      ]) {
        expect(field in attempt).toBe(false);
      }
    }
  });

  it('carries no prompt, session token or codebase path anywhere', async () => {
    const serialized = JSON.stringify(await load());

    for (const sentinel of Object.values(SENTINEL)) expect(serialized).not.toContain(sentinel);
  });

  it('still gives the list what it renders', async () => {
    const [quiz] = (await load()).quizzes;

    expect(quiz.attempts).toEqual([
      {
        id: 'attempt-2',
        attemptNumber: 2,
        status: 'in_progress',
        completed_at: null,
        partialCreditScore: null,
        focusMetrics: null,
        isCounting: false,
      },
      {
        id: 'attempt-1',
        attemptNumber: 1,
        status: 'completed',
        completed_at: COMPLETED.completed_at,
        partialCreditScore: 85,
        focusMetrics: { totalMs: 1000, focusedMs: 900, percentage: 90 },
        isCounting: true,
      },
    ]);
    expect(quiz.attemptStatus).toBe('in_progress');
    expect(quiz.score).toBe(85);
  });

  it('gives the summary the fields the list reads, maxAttempts included', async () => {
    const [quiz] = (await load()).quizzes;

    expect(quiz.attemptsSummary).toEqual({
      count: 2,
      canCreateNew: true,
      currentScore: 85,
      maxAttempts: 3,
    });
  });

  it('sends the quiz itself without its prompts', async () => {
    const [quiz] = (await load()).quizzes;

    expect('system_prompt' in quiz).toBe(false);
    expect('rubric_prompt' in quiz).toBe(false);
    expect('systemPrompt' in quiz).toBe(false);
    expect('rubricPrompt' in quiz).toBe(false);
  });
});
