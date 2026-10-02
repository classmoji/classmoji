/**
 * The class-level Assignments page and quizzes.
 *
 *   - Where quizzes are hidden (not Pro, or switched off) the loader sends no
 *     quiz assignment. It never sends quizzes to bind: a quiz and its
 *     assignment are made together in the quiz form, so this page binds none.
 *   - The create action refuses a QUIZ assignment, with or without quizzes,
 *     and writes nothing. REPO and FORM assignments are untouched.
 *   - Deleting a quiz's assignment is refused by the service (it goes with the
 *     quiz); the action answers with the service's own message, which says
 *     what to do instead.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomAdmin: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  loadQuizzesVisible: vi.fn(),
  quizzesVisibleOrThrow: vi.fn(),
  findByIdInClassroom: vi.fn(),
  listForClassroom: vi.fn(),
  findModules: vi.fn(),
  findRepositories: vi.fn(),
  getCandidateContent: vi.fn(),
  findTags: vi.fn(),
  createInClassroom: vi.fn(),
  updateInClassroom: vi.fn(),
  deleteInClassroom: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomAdmin: (...a: unknown[]) => mocks.requireClassroomAdmin(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
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
      createInClassroom: (...a: unknown[]) => mocks.createInClassroom(...a),
      updateInClassroom: (...a: unknown[]) => mocks.updateInClassroom(...a),
      deleteInClassroom: (...a: unknown[]) => mocks.deleteInClassroom(...a),
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

/** What the service says when asked to delete a quiz's assignment on its own. */
const DELETE_REFUSAL = 'Delete the quiz, or move it to another module';

const loaderArgs = () =>
  ({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/admin/${CLASS_SLUG}/assignments`),
  }) as unknown as Parameters<typeof route.loader>[0];

const post = (name: string, body: Record<string, unknown>) =>
  route.action({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/admin/${CLASS_SLUG}/assignments?/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as unknown as Parameters<typeof route.action>[0]);

const create = (body: Record<string, unknown>) => post('create', body);

let consoleError: ReturnType<typeof vi.spyOn>;

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
  mocks.deleteInClassroom.mockResolvedValue(undefined);
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('assignments loader — quiz visibility', () => {
  it('sends quiz assignments when quizzes are visible, and no quizzes to bind', async () => {
    const data = await route.loader(loaderArgs());

    expect(data.assignments.map(a => a.id)).toEqual(['a-repo', 'a-quiz', 'a-form']);
    expect(data).not.toHaveProperty('quizzes');
    expect(JSON.stringify(data)).not.toContain('Pointers');
    expect(data.quizzesVisible).toBe(true);
    expect(mocks.loadQuizzesVisible).toHaveBeenCalledWith('class-1');
  });

  it('sends no quiz assignment when quizzes are hidden, and leaves the other kinds alone', async () => {
    mocks.loadQuizzesVisible.mockResolvedValue(false);

    const data = await route.loader(loaderArgs());

    expect(data.assignments.map(a => a.id)).toEqual(['a-repo', 'a-form']);
    expect(data).not.toHaveProperty('quizzes');
    expect(data.forms).toEqual(CANDIDATES.forms);
    expect(data.quizzesVisible).toBe(false);
    expect(JSON.stringify(data)).not.toMatch(/"QUIZ"|Recursion|Pointers/);
  });
});

describe('assignments action — create refuses a quiz assignment', () => {
  const QUIZ_BODY = {
    module_id: 'm-1',
    type: 'QUIZ',
    quiz_id: 'q-2',
    title: 'Pointers check',
    weight: 10,
  };

  it.each([
    ['visible', true],
    ['hidden', false],
  ])('refuses it where quizzes are %s, says where quizzes are added, and writes nothing', async (_label, visible) => {
    mocks.loadQuizzesVisible.mockResolvedValue(visible);

    const result = await create(QUIZ_BODY);

    expect(result).toEqual({ error: 'Add a quiz from the quiz form.' });
    expect(mocks.createInClassroom).not.toHaveBeenCalled();
    // The refusal does not depend on the classroom's quiz setting.
    expect(mocks.loadQuizzesVisible).not.toHaveBeenCalled();
  });

  it('still creates a form assignment, without asking about quizzes', async () => {
    mocks.loadQuizzesVisible.mockResolvedValue(false);

    const result = await create({
      module_id: 'm-1',
      type: 'FORM',
      form_id: 'f-2',
      title: 'Exit ticket',
    });

    expect(result).toEqual({ success: 'Assignment "Exit ticket" created' });
    expect(mocks.createInClassroom).toHaveBeenCalledWith(
      'class-1',
      expect.objectContaining({ type: 'FORM', form_id: 'f-2' })
    );
    expect(mocks.loadQuizzesVisible).not.toHaveBeenCalled();
  });
});

describe('assignments action — updating a quiz assignment', () => {
  it('writes nothing to a quiz assignment where quizzes are hidden', async () => {
    mocks.findByIdInClassroom.mockResolvedValue({ id: 'a-quiz', type: 'QUIZ' });
    mocks.quizzesVisibleOrThrow.mockResolvedValue(false);

    const result = await post('update', { id: 'a-quiz', weight: 5 });

    expect(result).toEqual({ error: 'Failed to update assignment. Please try again.' });
    expect(mocks.findByIdInClassroom).toHaveBeenCalledWith('a-quiz', 'class-1');
    expect(mocks.updateInClassroom).not.toHaveBeenCalled();
  });

  it('updates a quiz assignment where quizzes show, and any other without asking', async () => {
    mocks.updateInClassroom.mockResolvedValue({ title: 'Updated' });
    mocks.findByIdInClassroom.mockResolvedValue({ id: 'a-quiz', type: 'QUIZ' });
    mocks.quizzesVisibleOrThrow.mockResolvedValue(true);
    expect(await post('update', { id: 'a-quiz', weight: 5 })).toEqual({
      success: 'Assignment "Updated" updated',
    });

    mocks.quizzesVisibleOrThrow.mockClear();
    mocks.findByIdInClassroom.mockResolvedValue({ id: 'a-repo', type: 'REPO' });
    expect(await post('update', { id: 'a-repo', weight: 5 })).toEqual({
      success: 'Assignment "Updated" updated',
    });
    expect(mocks.quizzesVisibleOrThrow).not.toHaveBeenCalled();
  });
});

describe('assignments action — deleting a quiz assignment', () => {
  it("answers the service's refusal with its own message", async () => {
    mocks.deleteInClassroom.mockRejectedValue(
      Object.assign(new Error(DELETE_REFUSAL), {
        name: 'QuizAssignmentError',
        code: 'quiz_assignment',
        status: 400,
      })
    );

    const result = await post('delete', { id: 'a-quiz' });

    expect(result).toEqual({ error: DELETE_REFUSAL });
    expect(mocks.deleteInClassroom).toHaveBeenCalledWith('a-quiz', 'class-1');
    // An expected refusal, not a failure: nothing goes to the error log.
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('keeps the fixed copy for any other failure, whatever its message says', async () => {
    // Matched by the error's name, not its text.
    mocks.deleteInClassroom.mockRejectedValue(new Error(DELETE_REFUSAL));

    expect(await post('delete', { id: 'a-repo' })).toEqual({
      error: 'Failed to delete assignment. Please try again.',
    });
    expect(consoleError).toHaveBeenCalled();
  });

  it('deletes any other assignment as before', async () => {
    expect(await post('delete', { id: 'a-form' })).toEqual({ success: 'Assignment deleted' });
    expect(mocks.deleteInClassroom).toHaveBeenCalledWith('a-form', 'class-1');
  });
});
