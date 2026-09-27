/**
 * The class-level Assignments page where quizzes are hidden (not Pro, or
 * switched off): the loader sends no quiz assignment and no quiz to bind, and
 * the create action refuses a quiz assignment posted anyway. REPO and FORM
 * assignments are untouched either way.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomAdmin: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  loadQuizzesVisible: vi.fn(),
  listForClassroom: vi.fn(),
  findModules: vi.fn(),
  findRepositories: vi.fn(),
  getCandidateContent: vi.fn(),
  findTags: vi.fn(),
  createInClassroom: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomAdmin: (...a: unknown[]) => mocks.requireClassroomAdmin(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
}));

vi.mock('~/utils/classroomProFlag.server', () => ({
  loadQuizzesVisible: (...a: unknown[]) => mocks.loadQuizzesVisible(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    assignment: {
      listForClassroom: (...a: unknown[]) => mocks.listForClassroom(...a),
      createInClassroom: (...a: unknown[]) => mocks.createInClassroom(...a),
    },
    module: {
      findByClassroomSlug: (...a: unknown[]) => mocks.findModules(...a),
      getCandidateContent: (...a: unknown[]) => mocks.getCandidateContent(...a),
    },
    repository: { findByClassroomSlug: (...a: unknown[]) => mocks.findRepositories(...a) },
    organizationTag: { findByClassroomId: (...a: unknown[]) => mocks.findTags(...a) },
  },
}));

// The loader and action are what is under test; the view layer only needs to
// be importable.
vi.mock('~/components', () => ({ SearchInput: () => null }));
vi.mock('~/components/features/assignments/AssignmentsTable', () => ({ default: () => null }));
vi.mock('~/components/features/assignments/AssignmentFormModal', () => ({ default: () => null }));

const route = await import('../route.tsx');

const CLASS_SLUG = 'cs52-26f';
const CLASSROOM = { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE', name: 'CS 52' };

const ASSIGNMENTS = [
  { id: 'a-repo', title: 'Lab 1', type: 'REPO' },
  { id: 'a-quiz', title: 'Recursion check', type: 'QUIZ', quiz: { id: 'q-1', name: 'Recursion' } },
  { id: 'a-form', title: 'Survey', type: 'FORM', form: { id: 'f-1', title: 'Survey' } },
];

const CANDIDATES = {
  quizzes: [{ id: 'q-2', name: 'Pointers', status: 'DRAFT' }],
  forms: [{ id: 'f-2', title: 'Exit ticket', status: 'PUBLISHED' }],
  pages: [],
  slides: [],
};

const loaderArgs = () =>
  ({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/admin/${CLASS_SLUG}/assignments`),
  }) as unknown as Parameters<typeof route.loader>[0];

const create = (body: Record<string, unknown>) =>
  route.action({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/admin/${CLASS_SLUG}/assignments?/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as unknown as Parameters<typeof route.action>[0]);

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.requireClassroomAdmin.mockResolvedValue({
    userId: 'owner-1',
    classroom: CLASSROOM,
    membership: { role: 'OWNER' },
  });
  mocks.loadQuizzesVisible.mockResolvedValue(true);
  mocks.listForClassroom.mockResolvedValue(ASSIGNMENTS);
  mocks.findModules.mockResolvedValue([
    { id: 'm-1', title: 'Week 1', slug: 'week-1', position: 0 },
  ]);
  mocks.findRepositories.mockResolvedValue([]);
  mocks.getCandidateContent.mockResolvedValue(CANDIDATES);
  mocks.findTags.mockResolvedValue([]);
  mocks.createInClassroom.mockImplementation(async (_c: string, input: { title: string }) => ({
    id: 'new',
    title: input.title,
  }));
});

describe('assignments loader — quiz visibility', () => {
  it('sends quiz assignments and bindable quizzes when quizzes are visible', async () => {
    const data = await route.loader(loaderArgs());

    expect(data.assignments.map(a => a.id)).toEqual(['a-repo', 'a-quiz', 'a-form']);
    expect(data.quizzes).toEqual(CANDIDATES.quizzes);
    expect(data.quizzesVisible).toBe(true);
    expect(mocks.loadQuizzesVisible).toHaveBeenCalledWith('class-1');
  });

  it('sends neither when quizzes are hidden, and leaves the other kinds alone', async () => {
    mocks.loadQuizzesVisible.mockResolvedValue(false);

    const data = await route.loader(loaderArgs());

    expect(data.assignments.map(a => a.id)).toEqual(['a-repo', 'a-form']);
    expect(data.quizzes).toEqual([]);
    expect(data.forms).toEqual(CANDIDATES.forms);
    expect(data.quizzesVisible).toBe(false);
    expect(JSON.stringify(data)).not.toMatch(/"QUIZ"|Recursion|Pointers/);
  });
});

describe('assignments action — a quiz assignment is refused where quizzes are hidden', () => {
  const QUIZ_BODY = {
    module_id: 'm-1',
    type: 'QUIZ',
    quiz_id: 'q-2',
    title: 'Pointers check',
    weight: 10,
  };

  it('refuses with fixed copy and writes nothing', async () => {
    mocks.loadQuizzesVisible.mockResolvedValue(false);

    const result = await create(QUIZ_BODY);

    expect(result).toEqual({ error: "Quizzes aren't available in this class." });
    expect(mocks.loadQuizzesVisible).toHaveBeenCalledWith('class-1');
    expect(mocks.createInClassroom).not.toHaveBeenCalled();
  });

  it('creates it when quizzes are visible', async () => {
    const result = await create(QUIZ_BODY);

    expect(result).toEqual({ success: 'Assignment "Pointers check" created' });
    expect(mocks.createInClassroom).toHaveBeenCalledWith(
      'class-1',
      expect.objectContaining({ type: 'QUIZ', quiz_id: 'q-2' })
    );
  });

  it('never asks about quizzes for another kind of assignment', async () => {
    mocks.loadQuizzesVisible.mockResolvedValue(false);

    const result = await create({
      module_id: 'm-1',
      type: 'FORM',
      form_id: 'f-2',
      title: 'Exit ticket',
    });

    expect(result).toEqual({ success: 'Assignment "Exit ticket" created' });
    expect(mocks.loadQuizzesVisible).not.toHaveBeenCalled();
  });
});
