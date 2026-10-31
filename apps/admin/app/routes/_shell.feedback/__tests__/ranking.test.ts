import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The feature ranking names voters and their classes, so its loader checks
 * the platform-admin gate before reading anything.
 */

const mocks = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  listFeatureRanking: vi.fn(),
  listFeatureVoters: vi.fn(),
}));

vi.mock('~/utils/db.server', () => ({
  requirePlatformAdmin: (...a: unknown[]) => mocks.requirePlatformAdmin(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    feedback: {
      listFeatureRanking: (...a: unknown[]) => mocks.listFeatureRanking(...a),
      listFeatureVoters: (...a: unknown[]) => mocks.listFeatureVoters(...a),
    },
  },
}));

const { loadFeedbackRanking } = await import('../route.server');

const args = (url: string) => ({ request: new Request(url), params: {}, context: {} }) as never;

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.listFeatureRanking.mockResolvedValue([]);
  mocks.listFeatureVoters.mockResolvedValue([]);
});

describe('feedback ranking loader', () => {
  it('reads nothing for someone who is not a platform admin', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(new Response('Forbidden', { status: 403 }));
    await expect(loadFeedbackRanking(args('http://admin/feedback?post=p1'))).rejects.toBeInstanceOf(
      Response
    );
    expect(mocks.listFeatureRanking).not.toHaveBeenCalled();
    expect(mocks.listFeatureVoters).not.toHaveBeenCalled();
  });

  it('loads the ranking, and the voters of the post asked for', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ user: { id: 'admin' } });
    await loadFeedbackRanking(args('http://admin/feedback?post=p1'));
    expect(mocks.listFeatureRanking).toHaveBeenCalled();
    expect(mocks.listFeatureVoters).toHaveBeenCalledWith('p1');
  });
});
