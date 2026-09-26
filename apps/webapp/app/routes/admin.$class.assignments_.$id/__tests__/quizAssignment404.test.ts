/**
 * The assignment page hands a quiz assignment to the quiz's own screen. Where
 * quizzes are hidden (not Pro, or switched off) it answers 404 instead, with
 * the same message a missing assignment gets, so nothing links on to a quiz.
 * Served under /admin, /teacher and /assistant from this one loader.
 *
 * A REPO assignment's page also carries the assignment modal's context; where
 * quizzes are hidden that context offers no quiz and names none as bound.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomTeachingTeam: vi.fn(),
  findByIdInClassroom: vi.fn(),
  listForClassroom: vi.fn(),
  getCandidateContent: vi.fn(),
  loadQuizzesVisible: vi.fn(),
  quizzesVisibleOrThrow: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomTeachingTeam: (...a: unknown[]) => mocks.requireClassroomTeachingTeam(...a),
  assertClassroomMutationAllowed: vi.fn(),
}));

vi.mock('~/utils/classroomProFlag.server', () => ({
  loadQuizzesVisible: (...a: unknown[]) => mocks.loadQuizzesVisible(...a),
  quizzesVisibleOrThrow: (...a: unknown[]) => mocks.quizzesVisibleOrThrow(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    assignment: {
      findByIdInClassroom: (...a: unknown[]) => mocks.findByIdInClassroom(...a),
      listForClassroom: (...a: unknown[]) => mocks.listForClassroom(...a),
    },
    module: {
      findByClassroomSlug: vi.fn(async () => []),
      getCandidateContent: (...a: unknown[]) => mocks.getCandidateContent(...a),
    },
    repository: { findByClassroomId: vi.fn(async () => []) },
    gitRepo: { findByRepository: vi.fn(async () => []) },
    autogradingTest: { findByRepositoryId: vi.fn(async () => []) },
    autogradingResult: { findLatestByGitRepoIds: vi.fn(async () => new Map()) },
    classroomMembership: { findUsersByRoles: vi.fn(async () => []) },
    emojiMapping: { findByClassroomId: vi.fn(async () => []) },
  },
  HelperService: {},
}));

// The loader is what is under test; the view layer only needs to import.
vi.mock('~/components', () => ({ SearchInput: () => null }));
vi.mock('~/components/features/assignments/AssignmentFormModal', () => ({ default: () => null }));
vi.mock('~/hooks', () => ({ useGlobalFetcher: () => ({}) }));
vi.mock('../SubmissionsTable', () => ({ default: () => null, matchesFilter: () => true }));

const route = await import('../route.tsx');

const CLASS_SLUG = 'cs52-26f';

const loaderArgs = (prefix: 'admin' | 'teacher' | 'assistant' = 'admin') =>
  ({
    params: { class: CLASS_SLUG, id: 'asg-1' },
    request: new Request(`http://localhost/${prefix}/${CLASS_SLUG}/assignments/asg-1`),
  }) as unknown as Parameters<typeof route.loader>[0];

const load = async (prefix: 'admin' | 'teacher' | 'assistant' = 'admin'): Promise<Response> => {
  try {
    await route.loader(loaderArgs(prefix));
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
  throw new Error('expected the loader to throw a Response');
};

const QUIZ_ASSIGNMENT = { id: 'asg-1', type: 'QUIZ', quiz: { id: 'quiz-1' }, form: null };

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.requireClassroomTeachingTeam.mockResolvedValue({
    userId: 'teacher-1',
    classroom: { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE' },
    membership: { role: 'TEACHER' },
  });
  mocks.findByIdInClassroom.mockResolvedValue(QUIZ_ASSIGNMENT);
  mocks.loadQuizzesVisible.mockResolvedValue(true);
  mocks.quizzesVisibleOrThrow.mockResolvedValue(true);
});

describe('assignment page — quiz assignments', () => {
  it.each([['admin'], ['teacher'], ['assistant']] as const)(
    'redirects to the quiz under /%s when quizzes are visible',
    async prefix => {
      const response = await load(prefix);

      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe(`/${prefix}/${CLASS_SLUG}/quizzes/quiz-1`);
      expect(mocks.quizzesVisibleOrThrow).toHaveBeenCalledWith('class-1');
    }
  );

  it.each([['admin'], ['teacher'], ['assistant']] as const)(
    '404s under /%s when quizzes are hidden, exactly as a missing assignment does',
    async prefix => {
      mocks.quizzesVisibleOrThrow.mockResolvedValue(false);
      const hidden = await load(prefix);

      mocks.findByIdInClassroom.mockResolvedValue(null);
      const missing = await load(prefix);

      expect(hidden.status).toBe(404);
      expect(hidden.headers.get('Location')).toBeNull();
      expect(await hidden.text()).toBe(await missing.text());
    }
  );

  it('lets a failed visibility lookup surface as an error, not as a 404', async () => {
    mocks.quizzesVisibleOrThrow.mockRejectedValue(new Error('db down'));

    await expect(route.loader(loaderArgs())).rejects.toThrow('db down');
  });

  it('never asks about quizzes for a form assignment', async () => {
    mocks.quizzesVisibleOrThrow.mockResolvedValue(false);
    mocks.findByIdInClassroom.mockResolvedValue({
      id: 'asg-1',
      type: 'FORM',
      quiz: null,
      form: { id: 'form-1', slug: 'exit-ticket' },
    });

    const response = await load();

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(`/admin/${CLASS_SLUG}/forms/exit-ticket`);
    expect(mocks.quizzesVisibleOrThrow).not.toHaveBeenCalled();
  });
});

describe('assignment page — a REPO assignment’s modal context', () => {
  const CANDIDATES = {
    quizzes: [{ id: 'quiz-9', name: 'Recursion quiz', status: 'PUBLISHED' }],
    forms: [{ id: 'form-9', title: 'Exit ticket' }],
    pages: [],
    slides: [],
  };

  beforeEach(() => {
    mocks.findByIdInClassroom.mockResolvedValue({
      id: 'asg-1',
      type: 'REPO',
      quiz: null,
      form: null,
      repository: { id: 'repo-1' },
    });
    mocks.getCandidateContent.mockResolvedValue(CANDIDATES);
    mocks.listForClassroom.mockResolvedValue([
      { id: 'asg-1', type: 'REPO', quiz_id: null, form_id: null },
      { id: 'asg-2', type: 'QUIZ', quiz_id: 'quiz-9', form_id: null },
      { id: 'asg-3', type: 'FORM', quiz_id: null, form_id: 'form-9' },
    ]);
  });

  it('offers no quiz and names none as bound where quizzes are hidden', async () => {
    mocks.loadQuizzesVisible.mockResolvedValue(false);

    const payload = await route.loader(loaderArgs());

    expect(payload.candidates.quizzes).toEqual([]);
    expect(payload.candidates.forms).toEqual(CANDIDATES.forms);
    expect(payload.boundQuizIds).toEqual([]);
    expect(payload.boundFormIds).toEqual(['form-9']);
    expect(JSON.stringify(payload)).not.toContain('quiz-9');
  });

  it('carries the quizzes where they show', async () => {
    const payload = await route.loader(loaderArgs());

    expect(payload.candidates.quizzes).toEqual(CANDIDATES.quizzes);
    expect(payload.boundQuizIds).toEqual(['quiz-9']);
  });
});
