import { describe, it, expect, vi, beforeEach } from 'vitest';

// calculateClassLeaderboard resolves the classroom by slug first and now throws a
// 404 Response (instead of a non-null assertion) when the slug does not exist.
// We mock the classroom service so we can drive the not-found branch directly.
const findBySlugMock = vi.fn();
const getSettingsMock = vi.fn();

vi.mock('../classroom.service.ts', () => ({
  findBySlug: (...args: unknown[]) => findBySlugMock(...args),
  getClassroomSettingsForServer: (...args: unknown[]) => getSettingsMock(...args),
}));

// helper.service imports getPrisma transitively; a bare stub is enough because
// the not-found branch returns before any DB access.
vi.mock('@classmoji/database', () => ({ default: () => ({}) }));

const { calculateClassLeaderboard } = await import('../helper.service.ts');

describe('calculateClassLeaderboard', () => {
  beforeEach(() => {
    findBySlugMock.mockReset();
    getSettingsMock.mockReset();
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
});
