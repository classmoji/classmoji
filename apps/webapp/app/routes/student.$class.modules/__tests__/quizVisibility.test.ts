import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The modules page in a classroom without quizzes (not Pro, or switched off).
 *
 * Quiz assignments and quiz items are dropped in the loader, so no quiz row,
 * "Quiz:" label or item count reaches the page — for students, and for the
 * teaching team through the /teacher re-export. Everything else in the module
 * is untouched, and nothing is dropped when the classroom has quizzes.
 */

const listForClassroomMock = vi.fn();
const findAllAssignmentsMock = vi.fn();
const assertAccessMock = vi.fn();
const loadQuizzesVisibleMock = vi.fn();

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    module: { listForClassroom: (...a: unknown[]) => listForClassroomMock(...a) },
    helper: { findAllAssignmentsForStudent: (...a: unknown[]) => findAllAssignmentsMock(...a) },
    repository: { findByClassroomId: vi.fn().mockResolvedValue([]) },
    organizationTag: { findByClassroomIdAndName: vi.fn() },
    team: { findUserTeamByTag: vi.fn() },
  },
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => assertAccessMock(...a),
}));

vi.mock('~/utils/classroomProFlag.server', () => ({
  loadQuizzesVisible: (...a: unknown[]) => loadQuizzesVisibleMock(...a),
}));

// The loader is what is under test; the view layer only needs to import.
vi.mock('~/components/features/modules/StudentModuleCard', () => ({ default: () => null }));
vi.mock('~/components/features/modules/studentTree', () => ({
  buildAssignmentLeaf: () => ({}),
  resourceLeaves: () => [],
}));
vi.mock('react-router', () => ({ useLocation: () => ({ pathname: '/student/cs52-26f/modules' }) }));
vi.mock('antd', () => ({ Button: () => null }));

const { loader } = await import('../route.tsx');

const CLASS_SLUG = 'cs52-26f';

const MODULE = {
  id: 'module-1',
  title: 'Week 1',
  description: null,
  is_published: true,
  assignments: [
    {
      id: 'asg-repo',
      type: 'REPO',
      title: 'Lab 1',
      repository_id: 'repo-1',
      repository: { id: 'repo-1', type: 'INDIVIDUAL', is_published: true },
      quiz: null,
      form: null,
    },
    {
      id: 'asg-quiz',
      type: 'QUIZ',
      title: 'Recursion check',
      repository_id: null,
      repository: null,
      quiz: { id: 'quiz-1', name: 'Recursion check', status: 'PUBLISHED' },
      form: null,
    },
    {
      id: 'asg-form',
      type: 'FORM',
      title: 'Survey',
      repository_id: null,
      repository: null,
      quiz: null,
      form: { id: 'form-1', title: 'Survey', slug: 'survey', status: 'OPEN' },
    },
  ],
  items: [
    { id: 'item-page', item_type: 'PAGE', page: { id: 'page-1', title: 'Reading' } },
    {
      id: 'item-quiz',
      item_type: 'QUIZ',
      quiz: { id: 'quiz-2', name: 'Pointers warm-up', status: 'PUBLISHED' },
    },
    { id: 'item-form', item_type: 'FORM', form: { id: 'form-2', title: 'Check-in' } },
  ],
};

const loaderArgs = (prefix = 'student') =>
  ({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/${prefix}/${CLASS_SLUG}/modules`),
  }) as unknown as Parameters<typeof loader>[0];

type Loaded = Extract<Awaited<ReturnType<typeof loader>>, { enabled: true }>;

const load = async (prefix?: string) => (await loader(loaderArgs(prefix))) as Loaded;

describe('modules loader — quizzes appear only when the classroom has them', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertAccessMock.mockResolvedValue({
      userId: 'student-1',
      classroom: { id: 'class-1', slug: CLASS_SLUG, settings: {} },
      membership: { role: 'STUDENT' },
    });
    listForClassroomMock.mockResolvedValue([MODULE]);
    findAllAssignmentsMock.mockResolvedValue([]);
  });

  it('keeps quiz assignments and quiz items when the classroom has quizzes', async () => {
    loadQuizzesVisibleMock.mockResolvedValue(true);

    const data = await load();

    expect(loadQuizzesVisibleMock).toHaveBeenCalledWith('class-1');
    expect(data.modules[0].assignments.map(a => a.id)).toEqual([
      'asg-repo',
      'asg-quiz',
      'asg-form',
    ]);
    expect(data.modules[0].items.map(i => i.id)).toEqual(['item-page', 'item-quiz', 'item-form']);
  });

  it('drops every quiz assignment and quiz item when the classroom has none', async () => {
    loadQuizzesVisibleMock.mockResolvedValue(false);

    const data = await load();

    expect(data.modules[0].assignments.map(a => a.id)).toEqual(['asg-repo', 'asg-form']);
    expect(data.modules[0].items.map(i => i.id)).toEqual(['item-page', 'item-form']);
    // Nothing about either quiz reaches the page, so no row can name one.
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain('Recursion check');
    expect(serialized).not.toContain('Pointers warm-up');
  });

  it('drops them from the teaching team’s preview too', async () => {
    assertAccessMock.mockResolvedValue({
      userId: 'teacher-1',
      classroom: { id: 'class-1', slug: CLASS_SLUG, settings: {} },
      membership: { role: 'TEACHER' },
    });
    loadQuizzesVisibleMock.mockResolvedValue(false);

    const data = await load('teacher');

    expect(data.isStaff).toBe(true);
    expect(data.modules[0].assignments.some(a => a.type === 'QUIZ')).toBe(false);
    expect(data.modules[0].items.some(i => i.item_type === 'QUIZ')).toBe(false);
  });

  it('asks nothing when the access gate refuses', async () => {
    assertAccessMock.mockRejectedValue(new Response('Forbidden', { status: 403 }));

    await expect(loader(loaderArgs())).rejects.toBeInstanceOf(Response);
    expect(loadQuizzesVisibleMock).not.toHaveBeenCalled();
    expect(listForClassroomMock).not.toHaveBeenCalled();
  });

  // The student-visibility rule (draft quizzes, release dates) runs in the
  // module service; the route's part is handing it the classroom's quiz answer.
  it.each([[true], [false]])(
    'hands the module list the quiz answer (%s) for the student view',
    async visible => {
      loadQuizzesVisibleMock.mockResolvedValue(visible);

      await load();

      expect(listForClassroomMock).toHaveBeenCalledWith(CLASS_SLUG, {
        includeUnpublished: false,
        quizzesVisible: visible,
      });
    }
  );
});
