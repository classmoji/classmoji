/**
 * The assistant's read-only Modules page runs its own loader over the admin
 * page's component, so it hides quizzes the same way: in a classroom that does
 * not show them, no quiz item, quiz assignment, candidate or binding is sent.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomTeachingTeam: vi.fn(),
  loadQuizzesVisible: vi.fn(),
  listModuleContentsForClassroom: vi.fn(),
  getCandidateContent: vi.fn(),
  assignmentListForClassroom: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomTeachingTeam: (...a: unknown[]) => mocks.requireClassroomTeachingTeam(...a),
}));
vi.mock('~/utils/classroomProFlag.server', () => ({
  loadQuizzesVisible: (...a: unknown[]) => mocks.loadQuizzesVisible(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    module: {
      listModuleContentsForClassroom: (...a: unknown[]) =>
        mocks.listModuleContentsForClassroom(...a),
      getCandidateContent: (...a: unknown[]) => mocks.getCandidateContent(...a),
    },
    assignment: {
      listForClassroom: (...a: unknown[]) => mocks.assignmentListForClassroom(...a),
    },
    repository: { findByClassroomId: async () => [] },
    organizationTag: { findByClassroomId: async () => [] },
  },
}));

// The re-exported admin page component is not under test.
vi.mock('../../admin.$class.modules/route', () => ({ default: () => null }));

const { loader } = await import('../route');

const CLASSROOM_ID = 'class-1';

const load = () =>
  loader({
    params: { class: 'cs52' },
    request: new Request('http://x/assistant/cs52/modules'),
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireClassroomTeachingTeam.mockResolvedValue({ classroom: { id: CLASSROOM_ID } });
  mocks.listModuleContentsForClassroom.mockResolvedValue([
    {
      id: 'mod-1',
      items: [
        { id: 'item-page', item_type: 'PAGE' },
        { id: 'item-quiz', item_type: 'QUIZ', quiz: { id: 'q1', name: 'Recursion' } },
      ],
      assignments: [
        { id: 'asg-repo', type: 'REPO' },
        { id: 'asg-quiz', type: 'QUIZ', quiz: { id: 'q1', name: 'Recursion' } },
      ],
    },
  ]);
  mocks.getCandidateContent.mockResolvedValue({
    pages: [],
    slides: [],
    quizzes: [{ id: 'q1', name: 'Recursion', status: 'PUBLISHED' }],
    forms: [],
  });
  mocks.assignmentListForClassroom.mockResolvedValue([
    { id: 'asg-quiz', quiz_id: 'q1', form_id: null },
  ]);
});

describe('assistant Modules loader', () => {
  it('sends no quiz rows, candidates or bindings without quizzes', async () => {
    mocks.loadQuizzesVisible.mockResolvedValue(false);
    const result = await load();

    expect(mocks.loadQuizzesVisible).toHaveBeenCalledWith(CLASSROOM_ID);
    expect(result.quizzesVisible).toBe(false);
    expect(result.modules[0].items.map(i => i.id)).toEqual(['item-page']);
    expect(result.modules[0].assignments.map(a => a.id)).toEqual(['asg-repo']);
    expect(result.candidates.quizzes).toEqual([]);
    expect(result.boundQuizIds).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('Recursion');
  });

  it('keeps them when the classroom shows quizzes', async () => {
    mocks.loadQuizzesVisible.mockResolvedValue(true);
    const result = await load();

    expect(result.quizzesVisible).toBe(true);
    expect(result.modules[0].items.map(i => i.id)).toEqual(['item-page', 'item-quiz']);
    expect(result.modules[0].assignments.map(a => a.id)).toEqual(['asg-repo', 'asg-quiz']);
    expect(result.candidates.quizzes).toHaveLength(1);
    expect(result.boundQuizIds).toEqual(['q1']);
  });

  // The read-only card offers no Delete, so this page gets no Delete flag —
  // not even for a module that owns hidden quiz assignments.
  it('sends no Delete flag, and nothing about hidden assignments', async () => {
    mocks.listModuleContentsForClassroom.mockResolvedValue([
      {
        id: 'mod-2',
        items: [],
        assignments: [{ id: 'asg-quiz-2', type: 'QUIZ', quiz: { id: 'q2', name: 'Closures' } }],
      },
      { id: 'mod-3', items: [], assignments: [{ id: 'asg-repo-3', type: 'REPO' }] },
    ]);

    mocks.loadQuizzesVisible.mockResolvedValue(false);
    const hidden = await load();
    expect(hidden.modules.map(m => 'hasUnlistedAssignments' in m)).toEqual([false, false]);
    expect(hidden.modules[0].assignments).toEqual([]);
    expect(JSON.stringify(hidden)).not.toMatch(/Closures|asg-quiz-2|"q2"|hasUnlistedAssignments/);

    mocks.loadQuizzesVisible.mockResolvedValue(true);
    const shown = await load();
    expect(shown.modules.map(m => 'hasUnlistedAssignments' in m)).toEqual([false, false]);
  });
});
