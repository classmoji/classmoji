/**
 * quiz.service — source material and course search on create/update, the
 * `source_material` read shape, and the student list's attempt allowlist.
 *
 * Prisma is mocked with a `$transaction` that runs the callback on a tx client
 * and PROPAGATES its failure, as the real one does; what is pinned is that the
 * quiz write and its material write share that one transaction (an unknown
 * document rolls the quiz back), that the content manifest is never rebuilt
 * for quiz material, and that `agent_config` never leaves through the student
 * list.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const tx = {
  quiz: {
    create: vi.fn(),
    update: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
  },
  module: { findFirst: vi.fn() },
  assignment: { create: vi.fn(), findFirst: vi.fn() },
  page: { findMany: vi.fn() },
  slide: { findMany: vi.fn() },
  pageLink: { deleteMany: vi.fn(), createMany: vi.fn() },
  slideLink: { deleteMany: vi.fn(), createMany: vi.fn() },
};
const transaction = vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx));
const quizFindUnique = vi.fn();
const quizFindMany = vi.fn();

vi.mock('@classmoji/database', () => ({
  // quiz.service reads it for its includes; its shape does not matter here.
  GIT_IDENTITY: {},
  default: () => ({
    $transaction: (fn: (client: typeof tx) => unknown) => transaction(fn),
    quiz: {
      findUnique: (...a: unknown[]) => quizFindUnique(...a),
      findMany: (...a: unknown[]) => quizFindMany(...a),
      // The row create hands back, read once the transaction has committed.
      findUniqueOrThrow: (...a: unknown[]) => tx.quiz.findUniqueOrThrow(...a),
    },
  }),
}));

const saveManifest = vi.fn();
vi.mock('../contentManifest.service.ts', () => ({
  saveManifest: (...a: unknown[]) => saveManifest(...a),
  isPlaced: () => false,
}));

vi.mock('../notification.service.ts', () => ({}));
vi.mock('../entitlement.service.ts', () => ({}));

const quizService = await import('../quiz.service.ts');
const { QuizExcludedPathsError, QuizStatusChangeError } = quizService;
const { ResourceLinkServiceError } = await import('../resourceLink.service.ts');

const CLASSROOM = 'classroom-1';
const T0 = new Date('2026-09-01T00:00:00Z');
/** Every quiz is created in a module (its assignment's). */
const IN_MODULE = { assignment: { moduleId: 'mod-1' } };

beforeEach(() => {
  vi.clearAllMocks();
  tx.quiz.create.mockResolvedValue({ id: 'quiz-1' });
  tx.quiz.update.mockResolvedValue({ id: 'quiz-1', classroom_id: CLASSROOM });
  tx.quiz.findUniqueOrThrow.mockResolvedValue({ id: 'quiz-1', name: 'Q' });
  // The quiz as update reads it first: in no module unless a test says so.
  tx.quiz.findUnique.mockResolvedValue({
    classroom_id: CLASSROOM,
    status: 'PUBLISHED',
    weight: 0,
    due_date: null,
    updated_at: T0,
    assignment: null,
  });
  tx.module.findFirst.mockResolvedValue({ id: 'mod-1' });
  tx.assignment.findFirst.mockResolvedValue(null);
  tx.assignment.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'asg-1',
    ...data,
    module: { classroom_id: CLASSROOM },
  }));
  tx.page.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
    where.id.in.map(id => ({ id }))
  );
  tx.slide.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
    where.id.in.map(id => ({ id }))
  );
});

describe('quiz.create', () => {
  it('writes the quiz and its material in ONE transaction, in the given order', async () => {
    await quizService.create({
      name: 'Q',
      classroomId: CLASSROOM,
      rubricPrompt: 'r',
      ...IN_MODULE,
      courseSearchEnabled: true,
      sourceMaterial: [
        { kind: 'slide', id: 's1' },
        { kind: 'page', id: 'p1' },
      ],
    });

    expect(transaction).toHaveBeenCalledOnce();
    expect(tx.quiz.create.mock.calls[0][0].data).toMatchObject({
      classroom_id: CLASSROOM,
      course_search_enabled: true,
    });
    expect(tx.slideLink.createMany).toHaveBeenCalledWith({
      data: [{ slide_id: 's1', quiz_id: 'quiz-1', order: 0 }],
    });
    expect(tx.pageLink.createMany).toHaveBeenCalledWith({
      data: [{ page_id: 'p1', quiz_id: 'quiz-1', order: 1 }],
    });
    // The manifest has no quiz section: nothing about it changed.
    expect(saveManifest).not.toHaveBeenCalled();
  });

  it('defaults course search off and leaves material alone when none is given', async () => {
    await quizService.create({ name: 'Q', classroomId: CLASSROOM, rubricPrompt: 'r', ...IN_MODULE });

    expect(tx.quiz.create.mock.calls[0][0].data.course_search_enabled).toBe(false);
    expect(tx.pageLink.deleteMany).not.toHaveBeenCalled();
    expect(tx.slideLink.deleteMany).not.toHaveBeenCalled();
  });

  it('fails the whole create (so the transaction rolls the quiz back) on an unknown document', async () => {
    tx.page.findMany.mockResolvedValue([]);

    const error = await quizService
      .create({
        name: 'Q',
        classroomId: CLASSROOM,
        rubricPrompt: 'r',
        ...IN_MODULE,
        sourceMaterial: [{ kind: 'page', id: 'foreign' }],
      })
      .catch(e => e);

    expect(error).toBeInstanceOf(ResourceLinkServiceError);
    // The quiz row was written inside the transaction that then threw.
    expect(tx.quiz.create).toHaveBeenCalledOnce();
    expect(tx.pageLink.createMany).not.toHaveBeenCalled();
    expect(tx.quiz.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});

describe('quiz.update', () => {
  it('validates material against the quiz’s OWN classroom, read back from the row', async () => {
    tx.quiz.update.mockResolvedValue({ id: 'quiz-1', classroom_id: 'classroom-from-row' });

    await quizService.update('quiz-1', { sourceMaterial: [{ kind: 'page', id: 'p1' }] });

    expect(tx.page.findMany.mock.calls[0][0].where).toEqual({
      id: { in: ['p1'] },
      classroom_id: 'classroom-from-row',
    });
  });

  it('reorders by replacing: deletes the quiz’s links and writes the new order', async () => {
    await quizService.update('quiz-1', {
      sourceMaterial: [
        { kind: 'page', id: 'p2' },
        { kind: 'page', id: 'p1' },
      ],
    });

    expect(tx.pageLink.deleteMany).toHaveBeenCalledWith({ where: { quiz_id: 'quiz-1' } });
    expect(tx.pageLink.createMany).toHaveBeenCalledWith({
      data: [
        { page_id: 'p2', quiz_id: 'quiz-1', order: 0 },
        { page_id: 'p1', quiz_id: 'quiz-1', order: 1 },
      ],
    });
  });

  it('removes all material for an empty list', async () => {
    await quizService.update('quiz-1', { sourceMaterial: [] });

    expect(tx.pageLink.deleteMany).toHaveBeenCalledOnce();
    expect(tx.slideLink.deleteMany).toHaveBeenCalledOnce();
    expect(tx.pageLink.createMany).not.toHaveBeenCalled();
  });

  it('collapses a duplicate, first position wins', async () => {
    await quizService.update('quiz-1', {
      sourceMaterial: [
        { kind: 'page', id: 'p1' },
        { kind: 'slide', id: 's1' },
        { kind: 'page', id: 'p1' },
      ],
    });

    expect(tx.pageLink.createMany).toHaveBeenCalledWith({
      data: [{ page_id: 'p1', quiz_id: 'quiz-1', order: 0 }],
    });
  });

  it('leaves material untouched when the update does not mention it (e.g. a weight change)', async () => {
    await quizService.update('quiz-1', { weight: 10 });

    expect(tx.pageLink.deleteMany).not.toHaveBeenCalled();
    expect(tx.slideLink.deleteMany).not.toHaveBeenCalled();
  });

  it('sets course_search_enabled only when given', async () => {
    await quizService.update('quiz-1', { courseSearchEnabled: false });
    expect(tx.quiz.update.mock.calls[0][0].data).toEqual({ course_search_enabled: false });

    await quizService.update('quiz-1', { name: 'N' });
    expect(tx.quiz.update.mock.calls[1][0].data).toEqual({ name: 'N' });
  });

  it('returns the saved row and its assignment without loading attempts inside the transaction', async () => {
    const row = { id: 'quiz-1', classroom_id: CLASSROOM, name: 'N', weight: 10, assignment: null };
    tx.quiz.findUniqueOrThrow.mockResolvedValue(row);

    await expect(
      quizService.update('quiz-1', { name: 'N', sourceMaterial: [{ kind: 'page', id: 'p1' }] })
    ).resolves.toBe(row);

    // A plain scalar update: no include pulls every attempt with its user.
    expect(tx.quiz.update.mock.calls[0][0]).toEqual({
      where: { id: 'quiz-1' },
      data: { name: 'N' },
    });
    // Read back with its assignment only.
    expect(tx.quiz.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: 'quiz-1' },
      include: { assignment: { include: { module: { select: { id: true, title: true } } } } },
    });
  });

  it('rolls back on a foreign document: the error escapes the transaction', async () => {
    tx.slide.findMany.mockResolvedValue([]);

    await expect(
      quizService.update('quiz-1', { name: 'N', sourceMaterial: [{ kind: 'slide', id: 'x' }] })
    ).rejects.toBeInstanceOf(ResourceLinkServiceError);
    expect(tx.slideLink.deleteMany).not.toHaveBeenCalled();
    expect(saveManifest).not.toHaveBeenCalled();
  });
});

describe('quiz excluded paths', () => {
  it('create stores them trimmed, repeats dropped', async () => {
    await quizService.create({
      name: 'Q',
      classroomId: CLASSROOM,
      rubricPrompt: 'r',
      ...IN_MODULE,
      includeCodeContext: true,
      excludedPaths: [' tests/** ', '**/*.spec.js', 'tests/**'],
    });
    expect(tx.quiz.create.mock.calls[0][0].data).toMatchObject({
      include_code_context: true,
      excluded_paths: ['tests/**', '**/*.spec.js'],
    });
  });

  it('create leaves them to the column default when none are given', async () => {
    await quizService.create({ name: 'Q', classroomId: CLASSROOM, rubricPrompt: 'r', ...IN_MODULE });
    expect(tx.quiz.create.mock.calls[0][0].data).not.toHaveProperty('excluded_paths');
  });

  it('create refuses a bad pattern before anything is written', async () => {
    const error = await quizService
      .create({
        name: 'Q',
        classroomId: CLASSROOM,
        rubricPrompt: 'r',
        excludedPaths: ['tests/**', '../outside/**'],
      })
      .catch(e => e);
    expect(error).toBeInstanceOf(QuizExcludedPathsError);
    expect(error).toMatchObject({ status: 400, code: 'invalid_excluded_paths' });
    expect(error.message).toBe(
      '"../outside/**" uses "..". Paths to exclude stay inside the repository.'
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(tx.quiz.create).not.toHaveBeenCalled();
  });

  it('update sets them only when given; an empty list clears them', async () => {
    await quizService.update('quiz-1', { excludedPaths: ['playwright.config.*'] });
    expect(tx.quiz.update.mock.calls[0][0].data).toEqual({
      excluded_paths: ['playwright.config.*'],
    });

    await quizService.update('quiz-1', { excludedPaths: [] });
    expect(tx.quiz.update.mock.calls[1][0].data).toEqual({ excluded_paths: [] });

    await quizService.update('quiz-1', { weight: 5 });
    expect(tx.quiz.update.mock.calls[2][0].data).toEqual({ weight: 5 });
  });

  it('update refuses a bad list (absolute, too many, not a list) without writing', async () => {
    for (const excludedPaths of [
      ['/etc/**'],
      Array.from({ length: 51 }, (_, i) => `d${i}/**`),
      'tests/**' as unknown as string[],
    ]) {
      await expect(quizService.update('quiz-1', { excludedPaths })).rejects.toBeInstanceOf(
        QuizExcludedPathsError
      );
    }
    expect(transaction).not.toHaveBeenCalled();
    expect(tx.quiz.update).not.toHaveBeenCalled();
  });
});

describe('quiz.findById', () => {
  it('returns source_material in order and no raw link relations', async () => {
    quizFindUnique.mockResolvedValue({
      id: 'quiz-1',
      classroom_id: CLASSROOM,
      course_search_enabled: true,
      page_links: [
        {
          order: 1,
          created_at: T0,
          page: { id: 'p1', title: 'Page', is_draft: true, classroom_id: CLASSROOM },
        },
      ],
      slide_links: [
        {
          order: 0,
          created_at: T0,
          slide: { id: 's1', title: 'Deck', is_draft: false, classroom_id: CLASSROOM },
        },
      ],
    });

    const quiz = await quizService.findById('quiz-1');

    expect(quiz).not.toHaveProperty('page_links');
    expect(quiz).not.toHaveProperty('slide_links');
    expect(quiz?.course_search_enabled).toBe(true);
    expect(quiz?.source_material).toEqual([
      { kind: 'slide', id: 's1', title: 'Deck', is_draft: false, order: 0 },
      { kind: 'page', id: 'p1', title: 'Page', is_draft: true, order: 1 },
    ]);
  });

  it('is null for no quiz', async () => {
    quizFindUnique.mockResolvedValue(null);
    await expect(quizService.findById('nope')).resolves.toBeNull();
  });
});

describe('quiz.getQuizzesForStudent', () => {
  const quizRow = {
    id: 'quiz-1',
    classroom_id: CLASSROOM,
    max_attempts: 1,
    grading_strategy: 'HIGHEST',
    attempts: [
      {
        id: 'a1',
        started_at: T0,
        completed_at: T0,
        partial_credit_percentage: 80,
        first_attempt_percentage: 70,
        total_duration_ms: 1000,
        unfocused_duration_ms: 100,
      },
    ],
    page_links: [
      {
        order: 0,
        created_at: T0,
        page: { id: 'p1', title: 'Live', is_draft: false, classroom_id: CLASSROOM },
      },
      {
        order: 1,
        created_at: T0,
        page: { id: 'p2', title: 'Draft', is_draft: true, classroom_id: CLASSROOM },
      },
    ],
    slide_links: [],
  };

  it('SELECTS the attempt fields the list reads — agent_config and the session never load', async () => {
    quizFindMany.mockResolvedValue([quizRow]);

    await quizService.getQuizzesForStudent(CLASSROOM, 'student-1', {
      role: 'STUDENT',
      classroom_id: CLASSROOM,
      user_id: 'student-1',
    });

    const select = quizFindMany.mock.calls[0][0].include.attempts.select;
    expect(select).toBeDefined();
    expect(select).not.toHaveProperty('agent_config');
    expect(select).not.toHaveProperty('session_token');
    expect(select).not.toHaveProperty('codebase_path');
    expect(select).not.toHaveProperty('question_results_json');
    // What the list and its focus metrics read is still there.
    for (const field of [
      'id',
      'started_at',
      'completed_at',
      'partial_credit_percentage',
      'first_attempt_percentage',
      'total_duration_ms',
      'unfocused_duration_ms',
    ]) {
      expect(select[field], field).toBe(true);
    }
  });

  it('keeps the derived attempt data and names published material only', async () => {
    quizFindMany.mockResolvedValue([quizRow]);

    const [quiz] = await quizService.getQuizzesForStudent(CLASSROOM, 'student-1', {
      role: 'STUDENT',
      classroom_id: CLASSROOM,
      user_id: 'student-1',
    });

    expect(quiz).not.toHaveProperty('page_links');
    expect(quiz.source_material).toEqual([
      { kind: 'page', id: 'p1', title: 'Live', is_draft: false, order: 0 },
    ]);
    expect(quiz.attempts[0]).toMatchObject({
      id: 'a1',
      attemptNumber: 1,
      status: 'completed',
      partialCreditScore: 80,
      isCounting: true,
      focusMetrics: { totalMs: 1000, unfocusedMs: 100, focusedMs: 900, percentage: 90 },
    });
    expect(quiz.attempts[0]).not.toHaveProperty('agent_config');
  });
});

describe('quiz.getQuizzesForStudent — closed quizzes and the counting score', () => {
  const STUDENT = { role: 'STUDENT' as const, classroom_id: CLASSROOM, user_id: 'student-1' };
  const attempt = (id: string, day: number, completed: boolean, pct: number | null) => ({
    id,
    started_at: new Date(`2026-09-0${day}T10:00:00Z`),
    completed_at: completed ? new Date(`2026-09-0${day}T11:00:00Z`) : null,
    partial_credit_percentage: pct,
    first_attempt_percentage: pct,
    total_duration_ms: null,
    unfocused_duration_ms: null,
  });
  const quizRow = (over: Record<string, unknown>) => ({
    id: 'quiz-1',
    classroom_id: CLASSROOM,
    status: 'PUBLISHED',
    max_attempts: 2,
    grading_strategy: 'HIGHEST',
    assignment: null,
    attempts: [],
    page_links: [],
    slide_links: [],
    ...over,
  });

  it('lists a quiz by its assignment (published, opened), or by its own status when it has none', async () => {
    quizFindMany.mockResolvedValue([]);

    await quizService.getQuizzesForStudent(CLASSROOM, 'student-1', STUDENT);
    await quizService.getQuizzesForStudent(CLASSROOM, 'student-1', STUDENT, {
      includeClosed: true,
    });

    const [assigned, legacy] = quizFindMany.mock.calls[0][0].where.OR;
    expect(assigned.assignment.is_published).toBe(true);
    expect(assigned.assignment.OR[0]).toEqual({ release_at: null });
    expect(legacy).toEqual({ assignment: { is: null }, status: 'PUBLISHED' });
    expect(quizFindMany.mock.calls[1][0].where.OR[1].status).toEqual({
      in: ['PUBLISHED', 'CLOSED'],
    });
    // The assignment's schedule travels with each quiz.
    expect(quizFindMany.mock.calls[1][0].include.assignment.select).toMatchObject({
      student_deadline: true,
      closes_at: true,
      release_at: true,
      is_published: true,
    });
  });

  it('keeps a quiz past its close date visible but not startable for a student', async () => {
    const closedAssignment = {
      is_published: true,
      release_at: null,
      closes_at: new Date(Date.now() - 60_000),
      student_deadline: null,
      weight: 5,
    };
    quizFindMany.mockResolvedValue([
      quizRow({ id: 'quiz-closed', assignment: closedAssignment }),
      quizRow({ id: 'quiz-open', assignment: { ...closedAssignment, closes_at: null } }),
    ]);

    const withClosed = await quizService.getQuizzesForStudent(CLASSROOM, 'student-1', STUDENT, {
      includeClosed: true,
    });
    const withoutClosed = await quizService.getQuizzesForStudent(CLASSROOM, 'student-1', STUDENT);

    expect(withClosed.map(q => [q.id, q.closed, q.attemptsSummary.canCreateNew])).toEqual([
      ['quiz-closed', true, false],
      ['quiz-open', false, true],
    ]);
    expect(withoutClosed.map(q => q.id)).toEqual(['quiz-open']);
  });

  it('offers a student no new attempt on a closed quiz; staff may still preview it', async () => {
    quizFindMany.mockResolvedValue([quizRow({ status: 'CLOSED' })]);

    const [asStudent] = await quizService.getQuizzesForStudent(CLASSROOM, 'student-1', STUDENT, {
      includeClosed: true,
    });
    const [asTeacher] = await quizService.getQuizzesForStudent(
      CLASSROOM,
      'teacher-1',
      { role: 'TEACHER', classroom_id: CLASSROOM },
      { includeClosed: true }
    );

    expect(asStudent.attemptsSummary.canCreateNew).toBe(false);
    expect(asTeacher.attemptsSummary.canCreateNew).toBe(true);
  });

  it('keeps a 0 as the current score', async () => {
    quizFindMany.mockResolvedValue([quizRow({ attempts: [attempt('a1', 1, true, 0)] })]);

    const [quiz] = await quizService.getQuizzesForStudent(CLASSROOM, 'student-1', STUDENT);

    expect(quiz.attemptsSummary.currentScore).toBe(0);
    expect(quiz.attemptsSummary.countingAttemptId).toBe('a1');
  });

  it('does not let a running retake hide the finished attempt', async () => {
    quizFindMany.mockResolvedValue([
      quizRow({
        grading_strategy: 'MOST_RECENT',
        // Newest first, as the query orders them.
        attempts: [attempt('retake', 2, false, null), attempt('a1', 1, true, 75)],
      }),
    ]);

    const [quiz] = await quizService.getQuizzesForStudent(CLASSROOM, 'student-1', STUDENT);

    expect(quiz.attemptsSummary.currentScore).toBe(75);
    expect(quiz.attempts.find(a => a.id === 'a1')?.isCounting).toBe(true);
    expect(quiz.attempts.find(a => a.id === 'retake')?.isCounting).toBe(false);
  });
});

describe('quiz.update — closing a quiz', () => {
  const unassigned = (status: string) => ({
    classroom_id: CLASSROOM,
    status,
    weight: 0,
    due_date: null,
    updated_at: T0,
    assignment: null,
  });

  it('refuses to close a quiz that is still a draft, writing nothing', async () => {
    tx.quiz.findUnique.mockResolvedValue(unassigned('DRAFT'));

    const refusal = await quizService.update('quiz-1', { status: 'CLOSED' }).catch(e => e);

    expect(refusal).toBeInstanceOf(QuizStatusChangeError);
    expect(refusal.message).toBe('Publish the quiz before closing it');
    expect(refusal.status).toBe(400);
    expect(tx.quiz.update).not.toHaveBeenCalled();
  });

  it('closes a published quiz in no module through its own status, as before', async () => {
    tx.quiz.findUnique.mockResolvedValue(unassigned('PUBLISHED'));

    await quizService.update('quiz-1', { status: 'CLOSED' });

    expect(tx.quiz.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CLOSED' }) })
    );
  });

  it('refuses new-shape assignment fields on a quiz in no module, writing nothing', async () => {
    const refusal = await quizService
      .update('quiz-1', { assignment: { weight: 5 } })
      .catch(e => e);

    expect(refusal).toMatchObject({ name: 'QuizAssignmentError', code: 'module_required' });
    expect(tx.quiz.update).not.toHaveBeenCalled();
  });
});

describe('quiz.findByClassroom — due date source', () => {
  it("reads each quiz's assignment due date beside its own", async () => {
    quizFindMany.mockResolvedValue([]);

    await quizService.findByClassroom(CLASSROOM, { role: 'OWNER', classroom_id: CLASSROOM });

    expect(quizFindMany.mock.calls[0][0].include.assignment.select).toMatchObject({
      module: { select: { id: true, title: true } },
      student_deadline: true,
      closes_at: true,
      weight: true,
      is_published: true,
    });
  });
});

describe('quiz.create — the module', () => {
  it('refuses a quiz with no module before anything is written', async () => {
    const refusal = await quizService
      .create({ name: 'Q', classroomId: CLASSROOM, rubricPrompt: 'r' })
      .catch(e => e);

    expect(refusal).toMatchObject({ name: 'QuizAssignmentError', code: 'module_required' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('refuses a module outside the quiz’s classroom, inside the transaction', async () => {
    tx.module.findFirst.mockResolvedValue(null);

    const refusal = await quizService
      .create({ name: 'Q', classroomId: CLASSROOM, rubricPrompt: 'r', ...IN_MODULE })
      .catch(e => e);

    expect(tx.module.findFirst).toHaveBeenCalledWith({
      where: { id: 'mod-1', classroom_id: CLASSROOM },
      select: { id: true },
    });
    expect(refusal).toMatchObject({ code: 'module_not_found', status: 404 });
    expect(tx.quiz.create).not.toHaveBeenCalled();
  });
});
