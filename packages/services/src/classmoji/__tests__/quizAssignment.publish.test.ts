/**
 * Publishing a quiz's assignment, and the QUIZ_PUBLISHED notice.
 *
 * `setQuizAssignmentPublished` is the one function every quiz publish path
 * calls (the quiz form, the quiz list, a module card, MCP quiz_publish), and
 * `assignment.publish` / `assignment.update` / `assignment.updateInClassroom`
 * route a QUIZ row's publish through the same notice. Pinned here:
 *
 *   - the class is told once, on the unpublished → published change only;
 *   - nobody is told where the classroom's quizzes are hidden
 *     (`entitlement.quizzesVisible`), nor while the quiz's Opens date is
 *     still ahead (the calendar and Up next carry it from then on);
 *   - unpublishing tells nobody;
 *   - the quiz's name, due date, rounded weight and status are written from
 *     the row in the same transaction, under the row lock;
 *   - `sourceMaterialAllDraft` is true only when the quiz links material and
 *     every linked page and deck is still a draft;
 *   - a REPO row's publish never sends QUIZ_PUBLISHED.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  assignmentFindUnique: vi.fn(),
  assignmentFindFirst: vi.fn(),
  assignmentFindUniqueOrThrow: vi.fn(),
  assignmentUpdate: vi.fn(),
  quizUpdate: vi.fn(),
  quizFindUnique: vi.fn(),
  quizzesVisible: vi.fn(),
  getStudentsInClassroom: vi.fn(),
  getStudentsForAssignment: vi.fn(),
  createNotifications: vi.fn(),
}));

vi.mock('@classmoji/database', () => {
  const client = {
    // The row lock is a tagged template call.
    $queryRaw: (...a: unknown[]) => mocks.queryRaw(...a),
    assignment: {
      findUnique: (...a: unknown[]) => mocks.assignmentFindUnique(...a),
      findFirst: (...a: unknown[]) => mocks.assignmentFindFirst(...a),
      findUniqueOrThrow: (...a: unknown[]) => mocks.assignmentFindUniqueOrThrow(...a),
      update: (...a: unknown[]) => mocks.assignmentUpdate(...a),
    },
    quiz: {
      update: (...a: unknown[]) => mocks.quizUpdate(...a),
      findUnique: (...a: unknown[]) => mocks.quizFindUnique(...a),
    },
    // An interactive transaction runs its callback against the same client.
    $transaction: (fn: (tx: unknown) => unknown) => fn(client),
  };
  return { default: () => client, GIT_IDENTITY: {} };
});

vi.mock('../entitlement.service.ts', () => ({
  quizzesVisible: (...a: unknown[]) => mocks.quizzesVisible(...a),
}));

// `runSafely` as the real one behaves: a throw inside is logged and swallowed.
vi.mock('../notification.service.ts', () => ({
  runSafely: async (_label: string, fn: () => Promise<unknown>) => {
    try {
      return await fn();
    } catch {
      return null;
    }
  },
  getStudentsInClassroom: (...a: unknown[]) => mocks.getStudentsInClassroom(...a),
  getStudentsForAssignment: (...a: unknown[]) => mocks.getStudentsForAssignment(...a),
  createNotifications: (...a: unknown[]) => mocks.createNotifications(...a),
}));

const { setQuizAssignmentPublished, notifyQuizPublished, quizSourceMaterialAllDraft } =
  await import('../quizAssignment.service.ts');
const { QuizAssignmentError } = await import('../quizAssignment.service.ts');
const assignmentService = await import('../assignment.service.ts');

const DAY = 24 * 60 * 60 * 1000;
const DUE = new Date('2026-10-20T23:59:00.000Z');

/** A QUIZ assignment row as the publish function selects it. */
const quizRow = (
  over: Partial<{
    is_published: boolean;
    release_at: Date | null;
    closes_at: Date | null;
    weight: number;
  }> = {}
) => ({
  id: 'asg-1',
  type: 'QUIZ' as const,
  quiz_id: 'quiz-1',
  module_id: 'mod-1',
  title: 'Week 3 Quiz',
  student_deadline: DUE,
  release_at: null,
  closes_at: null,
  weight: 2.4,
  tokens_per_hour: 0,
  is_published: true,
  module: { classroom_id: 'class-1' },
  ...over,
});

/** The same row as assignment.update / updateInClassroom read it back. */
const updatedRow = (type: 'QUIZ' | 'REPO', over: Parameters<typeof quizRow>[0] = {}) => ({
  ...quizRow(over),
  type,
  quiz_id: type === 'QUIZ' ? 'quiz-1' : null,
  repository_id: type === 'REPO' ? 'repo-1' : null,
  grades_released: false,
  repository: null,
  quiz: null,
  form: null,
});

const quizPublishedNotices = () =>
  mocks.createNotifications.mock.calls.filter(([input]) => input?.type === 'QUIZ_PUBLISHED');

/** Linked material, each document a draft or not. */
const material = (pages: boolean[], decks: boolean[]) => ({
  page_links: pages.map(is_draft => ({ page: { is_draft } })),
  slide_links: decks.map(is_draft => ({ slide: { is_draft } })),
});

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.queryRaw.mockResolvedValue([]);
  mocks.quizUpdate.mockResolvedValue({});
  mocks.quizFindUnique.mockResolvedValue(material([], []));
  mocks.quizzesVisible.mockResolvedValue(true);
  mocks.getStudentsInClassroom.mockResolvedValue(['student-1', 'student-2']);
  mocks.getStudentsForAssignment.mockResolvedValue({
    classroomId: 'class-1',
    studentIds: ['student-1', 'student-2'],
  });
  mocks.createNotifications.mockResolvedValue(undefined);
});

describe('setQuizAssignmentPublished — publishing', () => {
  it('tells the class once when an unpublished quiz is published', async () => {
    mocks.assignmentFindFirst.mockResolvedValue({ is_published: false });
    mocks.assignmentUpdate.mockResolvedValue(quizRow());

    const result = await setQuizAssignmentPublished('asg-1', true);

    expect(result).toMatchObject({ wasPublished: false, notified: true });
    expect(mocks.getStudentsInClassroom).toHaveBeenCalledWith('class-1');
    expect(mocks.createNotifications).toHaveBeenCalledExactlyOnceWith({
      type: 'QUIZ_PUBLISHED',
      classroomId: 'class-1',
      recipientUserIds: ['student-1', 'student-2'],
      resourceType: 'quiz',
      resourceId: 'quiz-1',
      title: 'Quiz published: Week 3 Quiz',
    });
  });

  it('locks the row before reading it, and writes only the publish flag', async () => {
    mocks.assignmentFindFirst.mockResolvedValue({ is_published: false });
    mocks.assignmentUpdate.mockResolvedValue(quizRow());

    await setQuizAssignmentPublished('asg-1', true);

    const [strings, ...values] = mocks.queryRaw.mock.calls[0];
    expect((strings as string[]).join('?')).toContain('FOR UPDATE');
    expect(values).toEqual(['asg-1']);
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.assignmentFindFirst.mock.invocationCallOrder[0]
    );
    expect(mocks.assignmentUpdate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ where: { id: 'asg-1' }, data: { is_published: true } })
    );
  });

  it('tells nobody again for a quiz that was already published', async () => {
    mocks.assignmentFindFirst.mockResolvedValue({ is_published: true });
    mocks.assignmentUpdate.mockResolvedValue(quizRow());

    const result = await setQuizAssignmentPublished('asg-1', true);

    expect(result).toMatchObject({ wasPublished: true, notified: false });
    expect(mocks.createNotifications).not.toHaveBeenCalled();
    expect(mocks.quizzesVisible).not.toHaveBeenCalled();
  });

  it("tells nobody where the classroom's quizzes are hidden; the quiz is still published", async () => {
    mocks.assignmentFindFirst.mockResolvedValue({ is_published: false });
    mocks.assignmentUpdate.mockResolvedValue(quizRow());
    mocks.quizzesVisible.mockResolvedValue(false);

    const result = await setQuizAssignmentPublished('asg-1', true);

    expect(mocks.quizzesVisible).toHaveBeenCalledWith('class-1');
    expect(result).toMatchObject({ wasPublished: false, notified: false });
    expect(mocks.createNotifications).not.toHaveBeenCalled();
    expect(mocks.quizUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PUBLISHED' }) })
    );
  });

  it('tells nobody while the Opens date is still ahead, and tells the class once it has passed', async () => {
    mocks.assignmentFindFirst.mockResolvedValue({ is_published: false });
    mocks.assignmentUpdate.mockResolvedValue(quizRow({ release_at: new Date(Date.now() + DAY) }));
    expect(await setQuizAssignmentPublished('asg-1', true)).toMatchObject({ notified: false });
    expect(mocks.createNotifications).not.toHaveBeenCalled();

    mocks.assignmentUpdate.mockResolvedValue(quizRow({ release_at: new Date(Date.now() - DAY) }));
    expect(await setQuizAssignmentPublished('asg-1', true)).toMatchObject({ notified: true });
    expect(mocks.createNotifications).toHaveBeenCalledOnce();
  });

  it('a failed notice does not undo the publish: notified is false', async () => {
    mocks.assignmentFindFirst.mockResolvedValue({ is_published: false });
    mocks.assignmentUpdate.mockResolvedValue(quizRow());
    mocks.createNotifications.mockRejectedValue(new Error('mail queue down'));

    await expect(setQuizAssignmentPublished('asg-1', true)).resolves.toMatchObject({
      wasPublished: false,
      notified: false,
    });
    expect(mocks.quizUpdate).toHaveBeenCalledOnce();
  });

  it('refuses a row that is not a quiz assignment in the classroom, writing nothing', async () => {
    mocks.assignmentFindFirst.mockResolvedValue(null);

    const error = await setQuizAssignmentPublished('asg-1', true, {
      classroomId: 'class-1',
    }).catch(e => e);

    expect(error).toBeInstanceOf(QuizAssignmentError);
    expect(error).toMatchObject({ code: 'not_found', status: 404 });
    expect(mocks.assignmentFindFirst).toHaveBeenCalledWith({
      where: { id: 'asg-1', type: 'QUIZ', module: { classroom_id: 'class-1' } },
      select: { is_published: true },
    });
    expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
    expect(mocks.quizUpdate).not.toHaveBeenCalled();
    expect(mocks.createNotifications).not.toHaveBeenCalled();
  });
});

describe('setQuizAssignmentPublished — the quiz mirror', () => {
  it("writes the quiz's name, due date, rounded weight and PUBLISHED", async () => {
    mocks.assignmentFindFirst.mockResolvedValue({ is_published: false });
    mocks.assignmentUpdate.mockResolvedValue(quizRow({ weight: 2.6 }));

    await setQuizAssignmentPublished('asg-1', true);

    expect(mocks.quizUpdate).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'quiz-1' },
      data: { name: 'Week 3 Quiz', due_date: DUE, weight: 3, status: 'PUBLISHED' },
    });
  });

  it('writes CLOSED for a quiz published past its close date', async () => {
    mocks.assignmentFindFirst.mockResolvedValue({ is_published: false });
    mocks.assignmentUpdate.mockResolvedValue(quizRow({ closes_at: new Date(Date.now() - 60_000) }));

    await setQuizAssignmentPublished('asg-1', true);

    expect(mocks.quizUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CLOSED' }) })
    );
  });

  it('unpublishing writes DRAFT and tells nobody', async () => {
    mocks.assignmentFindFirst.mockResolvedValue({ is_published: true });
    mocks.assignmentUpdate.mockResolvedValue(quizRow({ is_published: false }));

    const result = await setQuizAssignmentPublished('asg-1', false);

    expect(result).toMatchObject({
      wasPublished: true,
      notified: false,
      sourceMaterialAllDraft: false,
    });
    expect(mocks.assignmentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { is_published: false } })
    );
    expect(mocks.quizUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'DRAFT' }) })
    );
    expect(mocks.createNotifications).not.toHaveBeenCalled();
    expect(mocks.quizzesVisible).not.toHaveBeenCalled();
    // The material is only looked at for a quiz that is published.
    expect(mocks.quizFindUnique).not.toHaveBeenCalled();
  });

  it('unpublishing a quiz that was never published tells nobody either', async () => {
    mocks.assignmentFindFirst.mockResolvedValue({ is_published: false });
    mocks.assignmentUpdate.mockResolvedValue(quizRow({ is_published: false }));

    await expect(setQuizAssignmentPublished('asg-1', false)).resolves.toMatchObject({
      notified: false,
    });
    expect(mocks.createNotifications).not.toHaveBeenCalled();
  });
});

describe('sourceMaterialAllDraft', () => {
  const publishWith = async (linked: ReturnType<typeof material>) => {
    mocks.assignmentFindFirst.mockResolvedValue({ is_published: false });
    mocks.assignmentUpdate.mockResolvedValue(quizRow());
    mocks.quizFindUnique.mockResolvedValue(linked);
    return (await setQuizAssignmentPublished('asg-1', true)).sourceMaterialAllDraft;
  };

  it('is true when every linked page and deck is a draft', async () => {
    expect(await publishWith(material([true, true], [true]))).toBe(true);
    expect(await publishWith(material([true], []))).toBe(true);
    expect(await publishWith(material([], [true]))).toBe(true);
  });

  it('is false when any linked page or deck is published', async () => {
    expect(await publishWith(material([true, false], [true]))).toBe(false);
    expect(await publishWith(material([true], [false]))).toBe(false);
  });

  it('is false for a quiz that links no material', async () => {
    expect(await publishWith(material([], []))).toBe(false);
  });

  it('reads the links of the published quiz', async () => {
    await publishWith(material([true], []));

    expect(mocks.quizFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'quiz-1' } })
    );
  });

  it('is false for a quiz that is gone', async () => {
    mocks.quizFindUnique.mockResolvedValue(null);
    expect(await quizSourceMaterialAllDraft('quiz-1')).toBe(false);
  });
});

describe('notifyQuizPublished', () => {
  it('returns false and never throws when the student lookup fails', async () => {
    mocks.getStudentsInClassroom.mockRejectedValue(new Error('db down'));

    await expect(notifyQuizPublished(quizRow())).resolves.toBe(false);
    expect(mocks.createNotifications).not.toHaveBeenCalled();
  });

  it('returns false when the visibility lookup fails', async () => {
    mocks.quizzesVisible.mockRejectedValue(new Error('db down'));

    await expect(notifyQuizPublished(quizRow())).resolves.toBe(false);
    expect(mocks.createNotifications).not.toHaveBeenCalled();
  });
});

describe('assignment.publish', () => {
  it('publishes a QUIZ row through the quiz publish: one notice, the quiz mirrored', async () => {
    mocks.assignmentFindUnique.mockResolvedValue({ type: 'QUIZ' });
    mocks.assignmentFindFirst.mockResolvedValue({ is_published: false });
    mocks.assignmentUpdate.mockResolvedValue(quizRow());
    mocks.assignmentFindUniqueOrThrow.mockResolvedValue({ id: 'asg-1', is_published: true });

    const row = await assignmentService.publish('asg-1');

    expect(row).toMatchObject({ id: 'asg-1', is_published: true });
    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    expect(quizPublishedNotices()).toHaveLength(1);
    expect(mocks.quizUpdate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        where: { id: 'quiz-1' },
        data: expect.objectContaining({ status: 'PUBLISHED' }),
      })
    );
  });

  it('publishes a REPO row directly, with no quiz notice and no quiz write', async () => {
    mocks.assignmentFindUnique.mockResolvedValue({ type: 'REPO' });
    mocks.assignmentUpdate.mockResolvedValue({ id: 'asg-1', is_published: true });

    await assignmentService.publish('asg-1');

    expect(mocks.assignmentUpdate).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'asg-1' },
      data: { is_published: true },
    });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
    expect(mocks.createNotifications).not.toHaveBeenCalled();
    expect(mocks.quizUpdate).not.toHaveBeenCalled();
  });
});

describe('assignment.update — publishing a row', () => {
  const previous = (is_published: boolean) => ({
    student_deadline: DUE,
    grades_released: false,
    is_published,
  });

  it('a QUIZ row going from unpublished to published tells the class once', async () => {
    mocks.assignmentFindUnique.mockResolvedValue(previous(false));
    mocks.assignmentUpdate.mockResolvedValue(updatedRow('QUIZ'));

    await assignmentService.update('asg-1', { is_published: true });

    expect(quizPublishedNotices()).toHaveLength(1);
    expect(quizPublishedNotices()[0][0]).toMatchObject({
      classroomId: 'class-1',
      resourceType: 'quiz',
      resourceId: 'quiz-1',
    });
    expect(mocks.quizUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PUBLISHED' }) })
    );
  });

  it('a QUIZ row that was already published tells nobody', async () => {
    mocks.assignmentFindUnique.mockResolvedValue(previous(true));
    mocks.assignmentUpdate.mockResolvedValue(updatedRow('QUIZ'));

    await assignmentService.update('asg-1', { is_published: true });

    expect(mocks.createNotifications).not.toHaveBeenCalled();
  });

  it('a QUIZ row published where quizzes are hidden tells nobody', async () => {
    mocks.assignmentFindUnique.mockResolvedValue(previous(false));
    mocks.assignmentUpdate.mockResolvedValue(updatedRow('QUIZ'));
    mocks.quizzesVisible.mockResolvedValue(false);

    await assignmentService.update('asg-1', { is_published: true });

    expect(mocks.createNotifications).not.toHaveBeenCalled();
  });

  it('a REPO row going from unpublished to published sends no QUIZ_PUBLISHED', async () => {
    mocks.assignmentFindUnique.mockResolvedValue(previous(false));
    mocks.assignmentUpdate.mockResolvedValue(updatedRow('REPO'));

    await assignmentService.update('asg-1', { is_published: true });

    expect(quizPublishedNotices()).toHaveLength(0);
    expect(mocks.quizUpdate).not.toHaveBeenCalled();
  });
});

describe('assignment.updateInClassroom — publishing a QUIZ row', () => {
  it('tells the class once on unpublished → published', async () => {
    mocks.assignmentFindFirst.mockResolvedValue({
      id: 'asg-1',
      type: 'QUIZ',
      submission_mode: 'ISSUE',
      student_deadline: DUE,
      grades_released: false,
      is_published: false,
      _count: { git_repo_assignments: 0 },
    });
    mocks.assignmentUpdate.mockResolvedValue(updatedRow('QUIZ'));

    await assignmentService.updateInClassroom('asg-1', 'class-1', { is_published: true });

    expect(quizPublishedNotices()).toHaveLength(1);
  });
});
