/**
 * Unit tests for the quiz detail route's clearMyAttempts audit row.
 *
 * This route's LOADER already logged a VIEW, so the absence of any row for the
 * mutation was conspicuous: reading the page was recorded, deleting attempt
 * data from it was not.
 *
 * The row is keyed on the quiz, which is what distinguishes it from the
 * classroom-wide clear on the quiz list route — the two clear different amounts
 * of data and must not look identical in the trail.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  assertProTier: vi.fn(),
  addClassroomAuditLog: vi.fn(),
  addAuditLog: vi.fn(),
  clearForUserAndQuiz: vi.fn(),
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertProTier: (...a: unknown[]) => mocks.assertProTier(...a),
  addClassroomAuditLog: (...a: unknown[]) => mocks.addClassroomAuditLog(...a),
  addAuditLog: (...a: unknown[]) => mocks.addAuditLog(...a),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    quizAttempt: {
      clearForUserAndQuiz: (...a: unknown[]) => mocks.clearForUserAndQuiz(...a),
      findByQuiz: vi.fn(),
      getMessages: vi.fn(),
    },
    quiz: { findById: vi.fn() },
    user: { findById: vi.fn() },
  },
}));

// The action is what is under test; the view layer only needs to import.
vi.mock('~/components', () => ({
  UserThumbnailView: () => null,
  GradeBadge: () => null,
  SectionHeader: () => null,
}));
vi.mock('~/utils/quizUtils', () => ({
  formatDuration: () => '',
  checkForCompletion: () => null,
}));
vi.mock('antd', () => ({
  Table: () => null,
  Button: () => null,
  Tag: () => null,
  Tooltip: () => null,
  Badge: () => null,
  Space: () => null,
  Modal: { confirm: vi.fn() },
  message: { success: vi.fn(), error: vi.fn() },
  Select: () => null,
  Spin: () => null,
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
  useLocation: () => ({ pathname: '/admin/cs52-26f/quizzes/quiz-1' }),
  useNavigate: () => vi.fn(),
  useParams: () => ({ class: 'cs52-26f', quizId: 'quiz-1' }),
  useFetcher: () => ({ submit: vi.fn() }),
  Outlet: () => null,
}));

const route = await import('../admin.$class.quizzes_.$quizId.tsx');

const CLASS_SLUG = 'cs52-26f';
const QUIZ_ID = 'quiz-1';
const CLASSROOM = { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE' };

const submit = (body: Record<string, unknown>) =>
  route.action({
    params: { class: CLASS_SLUG, quizId: QUIZ_ID },
    request: new Request(`http://localhost/admin/${CLASS_SLUG}/quizzes/${QUIZ_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as unknown as Parameters<typeof route.action>[0]);

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.assertClassroomAccess.mockResolvedValue({
    userId: 'ta-1',
    classroom: CLASSROOM,
    membership: { id: 'm-1', role: 'ASSISTANT' },
  });
  mocks.clearForUserAndQuiz.mockResolvedValue(undefined);
});

describe('quiz detail action — clearMyAttempts audit row', () => {
  it('audits the clear against the quiz it was scoped to', async () => {
    await submit({ _action: 'clearMyAttempts' });

    expect(mocks.addClassroomAuditLog).toHaveBeenCalledExactlyOnceWith({
      classroomId: 'class-1',
      userId: 'ta-1',
      role: 'ASSISTANT',
      action: 'DELETE',
      resourceType: 'QUIZ',
      resourceId: QUIZ_ID,
      metadata: { tool: 'web:quiz.clear_my_attempts', scope: 'quiz' },
    });
  });

  it('clears only the calling user own attempts for this quiz', async () => {
    await submit({ _action: 'clearMyAttempts' });

    expect(mocks.clearForUserAndQuiz).toHaveBeenCalledExactlyOnceWith('ta-1', QUIZ_ID, 'class-1');
  });

  it('writes no row when the authorization gate throws', async () => {
    mocks.assertClassroomAccess.mockRejectedValue(new Response('Forbidden', { status: 403 }));

    await expect(submit({ _action: 'clearMyAttempts' })).rejects.toBeInstanceOf(Response);
    expect(mocks.clearForUserAndQuiz).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('writes no row when the classroom is not open to mutation', async () => {
    mocks.assertClassroomMutationAllowed.mockImplementation(() => {
      throw new Response('Locked', { status: 403 });
    });

    await expect(submit({ _action: 'clearMyAttempts' })).rejects.toBeInstanceOf(Response);
    expect(mocks.clearForUserAndQuiz).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });
});
