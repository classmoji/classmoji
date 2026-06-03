import { describe, it, expect, vi, beforeEach } from 'vitest';

// calculateClassLeaderboard resolves the classroom by slug first and now throws a
// 404 Response (instead of a non-null assertion) when the slug does not exist.
// We mock the classroom service so we can drive the not-found branch directly.
const findBySlugMock = vi.fn();
const getSettingsMock = vi.fn();
const findEmojiMappingsMock = vi.fn();
const findReposPerStudentMock = vi.fn();
const calcGradeMock = vi.fn();

vi.mock('../classroom.service.ts', () => ({
  findBySlug: (...args: unknown[]) => findBySlugMock(...args),
  getClassroomSettingsForServer: (...args: unknown[]) => getSettingsMock(...args),
}));

vi.mock('../emojiMapping.service.ts', () => ({
  findByClassroomId: (...args: unknown[]) => findEmojiMappingsMock(...args),
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
    findReposPerStudentMock.mockResolvedValue([
      { id: 's-bob', name: 'Bob', avatar_url: 'bob.png', login: 'bob', git_repos: [{ score: 80 }] },
      { id: 's-alice', name: 'Alice', avatar_url: null, login: 'alice', git_repos: [{ score: 20 }] },
      { id: 's-nemo', name: null, avatar_url: 'nemo.png', login: null, git_repos: [{ score: 50 }] },
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
    expect(calcGradeMock).toHaveBeenCalledWith([{ score: 80 }], emojiMappings, settings);
  });
});
