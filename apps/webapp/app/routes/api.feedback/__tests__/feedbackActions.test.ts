import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * /api/feedback — who may do what. Status changes (always with a note) and
 * merging duplicates are platform-admin only; a bug from the form arrives as
 * the Github template's fields; "answered" is left to the service's own
 * per-user check with the session user, never a user id
 * from the request; the "similar posts" read is public and narrows by type.
 */

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  admins: [] as string[],
  createPost: vi.fn(),
  setStatus: vi.fn(),
  markDuplicate: vi.fn(),
  markQuestionAnswered: vi.fn(),
  findSimilarPosts: vi.fn(),
}));

vi.mock('@classmoji/auth/server', () => ({
  requireAuth: (...a: unknown[]) => mocks.requireAuth(...a),
  get PLATFORM_ADMIN_USER_IDS() {
    return mocks.admins;
  },
}));

vi.mock('@classmoji/services', () => {
  class FeedbackValidationError extends Error {}
  class FeedbackNotFoundError extends Error {}
  return {
    FeedbackValidationError,
    FeedbackNotFoundError,
    isFeedbackCategory: (v: unknown) => v === 'FEATURE' || v === 'BUG' || v === 'QUESTION',
    isFeedbackStatus: (v: unknown) => typeof v === 'string' && v.length > 0,
    ClassmojiService: {
      feedback: {
        createPost: (...a: unknown[]) => mocks.createPost(...a),
        setStatus: (...a: unknown[]) => mocks.setStatus(...a),
        markDuplicate: (...a: unknown[]) => mocks.markDuplicate(...a),
        markQuestionAnswered: (...a: unknown[]) => mocks.markQuestionAnswered(...a),
        findSimilarPosts: (...a: unknown[]) => mocks.findSimilarPosts(...a),
      },
    },
  };
});

vi.mock('~/utils/feedbackRate.server', () => ({ allowFeedbackAction: () => true }));

const { action, loader } = await import('../route');

const post = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return action({
    request: new Request('http://localhost/api/feedback', { method: 'POST', body }),
  } as never);
};
const status = (result: unknown) =>
  result instanceof Response ? result.status : (result as { status?: number }).status;

beforeEach(() => {
  for (const m of Object.values(mocks)) if (typeof m === 'function') m.mockReset();
  mocks.admins = [];
  mocks.requireAuth.mockResolvedValue({ userId: 'user-a' });
  mocks.createPost.mockResolvedValue({ id: 'post-1' });
  mocks.markDuplicate.mockResolvedValue({ originalId: 'orig-1' });
  mocks.markQuestionAnswered.mockResolvedValue({ status: 'ANSWERED' });
});

describe('admin-only actions', () => {
  it('refuses a status change or a merge from a non-admin', async () => {
    expect(
      status(await post({ intent: 'set-status', postId: 'p', status: 'PLANNED', note: 'x' }))
    ).toBe(403);
    expect(status(await post({ intent: 'mark-duplicate', postId: 'p', originalId: 'o' }))).toBe(
      403
    );
    expect(mocks.setStatus).not.toHaveBeenCalled();
    expect(mocks.markDuplicate).not.toHaveBeenCalled();
  });

  it('always asks the service for a note on an admin status change', async () => {
    mocks.admins = ['user-a'];
    await post({ intent: 'set-status', postId: 'p', status: 'PLANNED', note: 'Soon' });
    expect(mocks.setStatus).toHaveBeenCalledWith({
      postId: 'p',
      status: 'PLANNED',
      actorId: 'user-a',
      note: 'Soon',
      requireNote: true,
    });
  });

  it('takes the original as a link or an id, and goes there', async () => {
    mocks.admins = ['user-a'];
    const result = await post({
      intent: 'mark-duplicate',
      postId: 'dup',
      originalId: 'https://app.classmoji.io/feedback/p/orig-1?x=1',
    });
    expect(mocks.markDuplicate).toHaveBeenCalledWith({
      postId: 'dup',
      originalId: 'orig-1',
      actorId: 'user-a',
    });
    expect((result as Response).headers.get('Location')).toBe('/feedback/p/orig-1');
  });
});

describe('everyone else', () => {
  it('sends a bug as the Github template fields', async () => {
    await post({
      intent: 'create-post',
      category: 'BUG',
      title: 'Export',
      bug_what_happened: 'Nothing',
      bug_expected: 'A file',
      bug_steps: '',
      bug_additional_info: 'Browser: Chrome 132 on macOS',
    });
    expect(mocks.createPost).toHaveBeenCalledWith(
      expect.objectContaining({
        authorId: 'user-a',
        category: 'BUG',
        bug: {
          whatHappened: 'Nothing',
          expected: 'A file',
          steps: '',
          additionalInfo: 'Browser: Chrome 132 on macOS',
        },
      })
    );
  });

  it('refuses a post with no type', async () => {
    expect(status(await post({ intent: 'create-post', title: 'x', body: 'y' }))).toBe(400);
    expect(mocks.createPost).not.toHaveBeenCalled();
  });

  it('marks answered as the session user only', async () => {
    await post({ intent: 'mark-answered', postId: 'q', answered: 'true', userId: 'user-b' });
    expect(mocks.markQuestionAnswered).toHaveBeenCalledWith({
      postId: 'q',
      userId: 'user-a',
      answered: true,
    });
  });
});

describe('similar posts (public read)', () => {
  it('passes the title and type, and nothing else', async () => {
    mocks.findSimilarPosts.mockResolvedValue([{ id: 'p1' }]);
    const response = (await loader({
      request: new Request('http://localhost/api/feedback?similar=grade%20export&type=bug'),
    } as never)) as Response;
    expect(mocks.findSimilarPosts).toHaveBeenCalledWith({ title: 'grade export', category: 'BUG' });
    expect(await response.json()).toEqual({ posts: [{ id: 'p1' }] });
    expect(mocks.requireAuth).not.toHaveBeenCalled();
  });
});
