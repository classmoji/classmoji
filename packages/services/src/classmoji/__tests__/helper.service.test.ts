import { describe, it, expect, vi, beforeEach } from 'vitest';

// calculateClassLeaderboard resolves the classroom by slug first and now throws a
// 404 Response (instead of a non-null assertion) when the slug does not exist.
// We mock the classroom service so we can drive the not-found branch directly.
const findBySlugMock = vi.fn();
const getSettingsMock = vi.fn();
const findEmojiMappingsMock = vi.fn();
const findReposPerStudentMock = vi.fn();
const calcGradeMock = vi.fn();
const quizzesVisibleMock = vi.fn();
const loadQuizGradeItemsMock = vi.fn();

vi.mock('../classroom.service.ts', () => ({
  findBySlug: (...args: unknown[]) => findBySlugMock(...args),
  getClassroomSettingsForServer: (...args: unknown[]) => getSettingsMock(...args),
}));

vi.mock('../emojiMapping.service.ts', () => ({
  findByClassroomId: (...args: unknown[]) => findEmojiMappingsMock(...args),
}));

// Quiz visibility and the quiz grade items are resolved inside the service, so
// every leaderboard caller counts quizzes the same way without passing anything.
vi.mock('../entitlement.service.ts', () => ({
  quizzesVisibleOrThrow: (...args: unknown[]) => quizzesVisibleMock(...args),
}));

vi.mock('../quizGradeItems.service.ts', () => ({
  loadQuizGradeItems: (...args: unknown[]) => loadQuizGradeItemsMock(...args),
}));

vi.mock('../user.service.ts', () => ({
  findRepositoriesPerStudent: (...args: unknown[]) => findReposPerStudentMock(...args),
}));

// Preserve real utils exports (RoomStateStore, types, etc.) but drive the grade
// calculation so we can assert the leaderboard's mapping and ordering directly.
vi.mock('@classmoji/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@classmoji/utils')>();
  return { ...actual, calculateStudentFinalGrade: (...args: unknown[]) => calcGradeMock(...args) };
});

// helper.service imports getPrisma transitively; a bare stub is enough because
// the not-found branch returns before any DB access.
vi.mock('@classmoji/database', () => ({ default: () => ({}) }));

const { calculateClassLeaderboard } = await import('../helper.service.ts');

describe('calculateClassLeaderboard', () => {
  beforeEach(() => {
    findBySlugMock.mockReset();
    getSettingsMock.mockReset();
    findEmojiMappingsMock.mockReset();
    findReposPerStudentMock.mockReset();
    calcGradeMock.mockReset();
    quizzesVisibleMock.mockReset();
    loadQuizGradeItemsMock.mockReset();
    quizzesVisibleMock.mockResolvedValue(true);
    loadQuizGradeItemsMock.mockResolvedValue(new Map());
  });

  it('throws a 404 Response when the classroom slug is not found', async () => {
    findBySlugMock.mockResolvedValue(null);

    await expect(calculateClassLeaderboard('does-not-exist')).rejects.toBeInstanceOf(Response);

    // Assert the status explicitly so a regression to a 500/plain Error is caught.
    const error = await calculateClassLeaderboard('does-not-exist').catch(e => e);
    expect(error).toBeInstanceOf(Response);
    expect((error as Response).status).toBe(404);
    expect(await (error as Response).text()).toBe('Classroom not found');

    // It must reject BEFORE touching settings/leaderboard computation.
    expect(getSettingsMock).not.toHaveBeenCalled();
    expect(quizzesVisibleMock).not.toHaveBeenCalled();
    expect(loadQuizGradeItemsMock).not.toHaveBeenCalled();
  });

  it('computes a per-student leaderboard sorted ascending by grade', async () => {
    const classroom = { id: 'class-1', slug: 'cs101' };
    findBySlugMock.mockResolvedValue(classroom);

    const emojiMappings = { '✅': 1, '❌': 0 };
    findEmojiMappingsMock.mockResolvedValue(emojiMappings);

    const settings = { passing_grade: 60 };
    getSettingsMock.mockResolvedValue(settings);

    // Each student carries a sentinel score on its first repo; the mocked grade
    // calculator returns it, letting us assert mapping + sort order deterministically.
    //
    // The source rows carry `image`, which is the User column findRepositories-
    // PerStudent actually selects; `avatar_url` is the name the view layer uses
    // and appears on the OUTPUT alone. This fixture used to supply `avatar_url`
    // on the input, which made a leaderboard that read the wrong column look
    // correct — every real entry came back without an avatar.
    findReposPerStudentMock.mockResolvedValue([
      { id: 's-bob', name: 'Bob', image: 'bob.png', login: 'bob', git_repos: [{ score: 80 }] },
      { id: 's-alice', name: 'Alice', image: null, login: 'alice', git_repos: [{ score: 20 }] },
      { id: 's-nemo', name: null, image: 'nemo.png', login: null, git_repos: [{ score: 50 }] },
    ]);
    calcGradeMock.mockImplementation((gitRepos: Array<{ score: number }>) => gitRepos[0].score);

    const leaderboard = await calculateClassLeaderboard('cs101');

    // Sorted ascending by grade: Alice(20) < Nemo(50) < Bob(80).
    expect(leaderboard).toEqual([
      { id: 's-alice', name: 'Alice', grade: 20, avatar_url: null, login: 'alice' },
      { id: 's-nemo', name: null, grade: 50, avatar_url: 'nemo.png', login: null },
      { id: 's-bob', name: 'Bob', grade: 80, avatar_url: 'bob.png', login: 'bob' },
    ]);

    // Downstream services are keyed off the resolved classroom id, not the slug.
    expect(findEmojiMappingsMock).toHaveBeenCalledWith('class-1');
    expect(getSettingsMock).toHaveBeenCalledWith('class-1');
    expect(findReposPerStudentMock).toHaveBeenCalledWith(classroom);
    // The grade calculator receives each student's repos plus the shared mappings/settings.
    expect(calcGradeMock).toHaveBeenCalledTimes(3);
    expect(calcGradeMock).toHaveBeenCalledWith(
      [{ score: 80 }],
      emojiMappings,
      settings,
      true,
      true,
      []
    );
  });

  describe('quiz grade items', () => {
    const classroom = { id: 'class-1', slug: 'cs101' };
    const settings = { late_penalty_points_per_hour: 2 };
    const emojiMappings = { '✅': 100 };
    const item = (assignmentId: string, grade: number, extra: Record<string, unknown> = {}) => ({
      assignment_id: assignmentId,
      module_id: 'mod-1',
      weight: 10,
      is_extra_credit: false,
      grade,
      raw_grade: grade,
      counts_as_zero: false,
      late_hours: 0,
      ...extra,
    });

    beforeEach(() => {
      findBySlugMock.mockResolvedValue(classroom);
      findEmojiMappingsMock.mockResolvedValue(emojiMappings);
      getSettingsMock.mockResolvedValue(settings);
      findReposPerStudentMock.mockResolvedValue([
        { id: 's-1', name: 'One', image: null, login: 'one', git_repos: [] },
        { id: 's-2', name: 'Two', image: null, login: 'two', git_repos: [] },
      ]);
    });

    it('loads the items once for the classroom with its quiz visibility and passes each student theirs', async () => {
      const s1Items = [item('a-quiz', 80)];
      loadQuizGradeItemsMock.mockResolvedValue(new Map([['s-1', s1Items]]));
      calcGradeMock.mockReturnValue(50);

      await calculateClassLeaderboard('cs101');

      expect(quizzesVisibleMock).toHaveBeenCalledExactlyOnceWith('class-1');
      expect(loadQuizGradeItemsMock).toHaveBeenCalledExactlyOnceWith({
        classroomId: 'class-1',
        quizzesVisible: true,
      });
      expect(calcGradeMock).toHaveBeenCalledWith([], emojiMappings, settings, true, true, s1Items);
      // A student with no item gets an empty list, not another student's.
      expect(calcGradeMock).toHaveBeenCalledWith([], emojiMappings, settings, true, true, []);
    });

    it('passes the hidden answer to the loader when quizzes are hidden', async () => {
      quizzesVisibleMock.mockResolvedValue(false);
      calcGradeMock.mockReturnValue(-1);

      await calculateClassLeaderboard('cs101');

      expect(loadQuizGradeItemsMock).toHaveBeenCalledWith({
        classroomId: 'class-1',
        quizzesVisible: false,
      });
    });

    it('fails instead of dropping quizzes when the visibility lookup fails', async () => {
      quizzesVisibleMock.mockRejectedValue(new Error('db down'));

      await expect(calculateClassLeaderboard('cs101')).rejects.toThrow('db down');
      expect(calcGradeMock).not.toHaveBeenCalled();
    });

    it('counts a quiz item in the real grade engine', async () => {
      const { calculateStudentFinalGrade: realGrade } =
        await vi.importActual<typeof import('@classmoji/utils')>('@classmoji/utils');
      calcGradeMock.mockImplementation((...args: unknown[]) =>
        (realGrade as (...a: unknown[]) => number)(...args)
      );
      loadQuizGradeItemsMock.mockResolvedValue(
        new Map([
          ['s-1', [item('a-quiz', 70)]],
          ['s-2', [item('a-quiz', 0, { counts_as_zero: true })]],
        ])
      );

      const leaderboard = await calculateClassLeaderboard('cs101');

      expect(leaderboard).toEqual([
        { id: 's-2', name: 'Two', grade: 0, avatar_url: null, login: 'two' },
        { id: 's-1', name: 'One', grade: 70, avatar_url: null, login: 'one' },
      ]);
    });
  });
});
