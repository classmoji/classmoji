import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The feedback screen names voters and their classes and changes statuses,
 * so its loader and its action check the platform-admin gate before reading
 * or writing anything.
 */

const mocks = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  listFeatureRanking: vi.fn(),
  listFeatureVoters: vi.fn(),
  getPost: vi.fn(),
  setStatus: vi.fn(),
  markDuplicate: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
}));

vi.mock('~/utils/db.server', () => ({
  requirePlatformAdmin: (...a: unknown[]) => mocks.requirePlatformAdmin(...a),
  prisma: {
    feedbackPost: {
      findMany: (...a: unknown[]) => mocks.findMany(...a),
      count: (...a: unknown[]) => mocks.count(...a),
    },
  },
}));

class FeedbackValidationError extends Error {}
class FeedbackNotFoundError extends Error {}

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    feedback: {
      listFeatureRanking: (...a: unknown[]) => mocks.listFeatureRanking(...a),
      listFeatureVoters: (...a: unknown[]) => mocks.listFeatureVoters(...a),
      getPost: (...a: unknown[]) => mocks.getPost(...a),
      setStatus: (...a: unknown[]) => mocks.setStatus(...a),
      markDuplicate: (...a: unknown[]) => mocks.markDuplicate(...a),
      isFeedbackStatus: (s: string) => ['PLANNED', 'FIXED'].includes(s),
      FEEDBACK_STATUSES_BY_CATEGORY: { FEATURE: ['PLANNED'], BUG: ['FIXED'], QUESTION: [] },
      FEEDBACK_STATUS_LABELS: { PLANNED: 'Planned', FIXED: 'Fixed' },
      FeedbackValidationError,
      FeedbackNotFoundError,
    },
  },
}));

const { loadFeedback, feedbackAction } = await import('../route.server');

const args = (url: string, init?: RequestInit) =>
  ({ request: new Request(url, init), params: {}, context: {} }) as never;

const post = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return args('http://admin/feedback', { method: 'POST', body });
};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.listFeatureRanking.mockResolvedValue([]);
  mocks.listFeatureVoters.mockResolvedValue([]);
  mocks.findMany.mockResolvedValue([]);
  mocks.count.mockResolvedValue(0);
  mocks.getPost.mockResolvedValue(null);
});

describe('feedback loader', () => {
  it('reads nothing for someone who is not a platform admin', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(new Response('Forbidden', { status: 403 }));
    await expect(loadFeedback(args('http://admin/feedback?post=p1'))).rejects.toBeInstanceOf(
      Response
    );
    expect(mocks.listFeatureRanking).not.toHaveBeenCalled();
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.getPost).not.toHaveBeenCalled();
  });

  it('loads the ranking for features, and the post asked for', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ user: { id: 'admin' } });
    await loadFeedback(args('http://admin/feedback?post=p1'));
    expect(mocks.listFeatureRanking).toHaveBeenCalled();
    expect(mocks.getPost).toHaveBeenCalledWith('p1', 'admin');
  });

  it('does not rank bugs by votes', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ user: { id: 'admin' } });
    await loadFeedback(args('http://admin/feedback?category=BUG'));
    expect(mocks.listFeatureRanking).not.toHaveBeenCalled();
  });
});

describe('feedback action', () => {
  it('writes nothing for someone who is not a platform admin', async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(new Response('Forbidden', { status: 403 }));
    await expect(
      feedbackAction(post({ intent: 'status', postId: 'p1', status: 'PLANNED' }))
    ).rejects.toBeInstanceOf(Response);
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });

  it('sets a status as the admin, and turns service validation errors into messages', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ user: { id: 'admin' } });
    await feedbackAction(post({ intent: 'status', postId: 'p1', status: 'PLANNED', note: 'soon' }));
    expect(mocks.setStatus).toHaveBeenCalledWith({
      postId: 'p1',
      status: 'PLANNED',
      actorId: 'admin',
      note: 'soon',
    });
    mocks.setStatus.mockRejectedValue(new FeedbackValidationError("A bug post can't be Planned."));
    expect(
      await feedbackAction(post({ intent: 'status', postId: 'p1', status: 'PLANNED' }))
    ).toEqual({ error: "A bug post can't be Planned." });
  });

  it('refuses an unknown status before calling the service', async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({ user: { id: 'admin' } });
    expect(await feedbackAction(post({ intent: 'status', postId: 'p1', status: 'NOPE' }))).toEqual({
      error: 'Unknown status.',
    });
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });
});
