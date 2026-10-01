import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * api.quiz restartQuiz: the repository a staff preview tests with.
 *
 * A teaching-team member previewing a code-aware quiz names a repository in
 * the classroom's GitHub organization. The chat runtime reads it with the
 * GitHub App's installation token, so the name is stored only when the
 * member's own GitHub account can open it (asked of GitHub with their own
 * token), which is what a preview could read when it used that token itself.
 * GitHub is mocked here.
 */

const quizFindByIdMock = vi.fn();
const attemptFindByIdMock = vi.fn();
const createNewMock = vi.fn();
const updateAgentConfigMock = vi.fn();
const assertAccessMock = vi.fn();
const getAuthSessionMock = vi.fn();
const endQuizSessionMock = vi.fn();
const reposGetMock = vi.fn();
const octokitAuths: unknown[] = [];

vi.mock('@octokit/rest', () => ({
  Octokit: class {
    rest = { repos: { get: (...a: unknown[]) => reposGetMock(...a) } };
    constructor(options: { auth?: unknown }) {
      octokitAuths.push(options?.auth);
    }
  },
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    quiz: { findById: (...a: unknown[]) => quizFindByIdMock(...a) },
    quizAttempt: {
      findById: (...a: unknown[]) => attemptFindByIdMock(...a),
      createNew: (...a: unknown[]) => createNewMock(...a),
      updateAgentConfig: (...a: unknown[]) => updateAgentConfigMock(...a),
      findWithMessages: vi.fn(),
    },
    aiConversation: { addMessage: vi.fn() },
    audit: { create: vi.fn() },
  },
  QuizAttemptNotFoundError: class QuizAttemptNotFoundError extends Error {},
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => assertAccessMock(...a),
}));
vi.mock('~/utils/classroomProFlag.server', () => ({ quizzesVisibleOrThrow: async () => true }));
vi.mock('~/utils/routeAuth.server', () => ({ assertClassroomMutationAllowed: () => undefined }));
vi.mock('~/utils/aiFeatures.server', () => ({ isAIAgentConfigured: () => true }));
vi.mock('~/utils/backgroundTask.server', () => ({ runBackgroundTask: vi.fn() }));
vi.mock('../../student.$class.quizzes/helpers.server', () => ({
  getInstallationToken: vi.fn(async () => 'install-token'),
}));
vi.mock('../../student.$class.quizzes/aiAgent.server', () => ({
  initializeQuizViaAgent: vi.fn(),
  sendMessageToAgent: vi.fn(),
  endQuizSession: (...a: unknown[]) => endQuizSessionMock(...a),
}));
vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: (...a: unknown[]) => getAuthSessionMock(...a),
}));
vi.mock('@classmoji/auth/mcp-token', () => ({
  mintMcpAccessToken: vi.fn(async () => ({
    accessToken: 'mcp-token',
    expiresAt: new Date('2030-01-01T00:00:00.000Z'),
  })),
}));

const { action } = await import('../route.ts');

const QUIZ_ID = 'quiz-1';
const OWN_PREVIEW = 'attempt-own-preview';
const NEW_ATTEMPT = 'attempt-new';

const restart = (body: Record<string, unknown>) =>
  action({
    request: new Request('http://localhost/api/quiz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _action: 'restartQuiz', quizId: QUIZ_ID, ...body }),
    }),
  } as unknown as Parameters<typeof action>[0]) as Promise<Response>;

const asStaff = (role: 'OWNER' | 'TEACHER' | 'ASSISTANT' | 'STUDENT') =>
  assertAccessMock.mockResolvedValue({
    userId: 'staff-1',
    classroom: { status: 'ACTIVE', slug: 'cs-1', git_organization: { login: 'course-org' } },
    membership: { role },
  });

const githubError = (status: number, headers: Record<string, string> = {}) =>
  Object.assign(new Error(`HTTP ${status}`), { status, response: { headers } });

describe("api.quiz restartQuiz: a preview's repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    octokitAuths.length = 0;
    quizFindByIdMock.mockResolvedValue({ id: QUIZ_ID, classroom_id: 'class-1' });
    attemptFindByIdMock.mockResolvedValue({
      id: OWN_PREVIEW,
      quiz_id: QUIZ_ID,
      user_id: 'staff-1',
    });
    createNewMock.mockResolvedValue({ success: true, attemptId: NEW_ATTEMPT });
    updateAgentConfigMock.mockResolvedValue(undefined);
    // A sign-in with a GitHub account linked: its login and its user token.
    getAuthSessionMock.mockResolvedValue({
      token: 'ghu_staff',
      userLogin: 'staff-gh',
      session: {},
    });
    reposGetMock.mockResolvedValue({ status: 200, data: { name: 'copied-test-repo' } });
    asStaff('OWNER');
  });

  it('stores a repository the caller can open on GitHub, asked with their own token', async () => {
    const response = await restart({ attemptId: OWN_PREVIEW, repoName: 'copied-test-repo' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, attemptId: NEW_ATTEMPT });
    expect(octokitAuths).toEqual(['ghu_staff']);
    expect(reposGetMock).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'course-org', repo: 'copied-test-repo' })
    );
    expect(updateAgentConfigMock).toHaveBeenCalledWith(NEW_ATTEMPT, {
      instructorRepoName: 'copied-test-repo',
    });
  });

  it.each(['TEACHER', 'ASSISTANT'] as const)(
    'asks GitHub the same way for a %s preview',
    async role => {
      asStaff(role);
      const response = await restart({ repoName: 'copied-test-repo' });

      expect(response.status).toBe(200);
      expect(reposGetMock).toHaveBeenCalledTimes(1);
      expect(updateAgentConfigMock).toHaveBeenCalledTimes(1);
    }
  );

  it("refuses a repository the caller's account can't open, and changes nothing", async () => {
    reposGetMock.mockRejectedValue(githubError(404));

    const response = await restart({ attemptId: OWN_PREVIEW, repoName: 'another-class-repo' });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      code: 'PREVIEW_REPO_REFUSED',
      message: "Your GitHub account can't open that repository. Pick one you have access to.",
    });
    // The previous preview keeps running and no attempt is created.
    expect(endQuizSessionMock).not.toHaveBeenCalled();
    expect(createNewMock).not.toHaveBeenCalled();
    expect(updateAgentConfigMock).not.toHaveBeenCalled();
  });

  it('refuses when GitHub answers 403 for the repository', async () => {
    reposGetMock.mockRejectedValue(githubError(403));

    const response = await restart({ repoName: 'private-solutions' });

    expect(response.status).toBe(403);
    expect(createNewMock).not.toHaveBeenCalled();
  });

  it('asks the caller to connect GitHub when their sign-in has no GitHub account', async () => {
    // Signed in with email and password, GitHub never linked.
    getAuthSessionMock.mockResolvedValue({ token: null, userLogin: '', session: {} });

    const response = await restart({ repoName: 'copied-test-repo' });

    expect(response.status).toBe(403);
    expect((await response.json()).message).toBe(
      'Connect your GitHub account to preview this quiz with a repository.'
    );
    expect(reposGetMock).not.toHaveBeenCalled();
    expect(createNewMock).not.toHaveBeenCalled();
    expect(updateAgentConfigMock).not.toHaveBeenCalled();
  });

  it('asks the caller to sign in with GitHub again when their linked account has no usable token', async () => {
    getAuthSessionMock.mockResolvedValue({ token: null, userLogin: 'staff-gh', session: {} });

    const response = await restart({ repoName: 'copied-test-repo' });

    expect(response.status).toBe(403);
    expect((await response.json()).message).toBe(
      'Sign in with GitHub again to preview this quiz with a repository.'
    );
    expect(reposGetMock).not.toHaveBeenCalled();
    expect(createNewMock).not.toHaveBeenCalled();
  });

  it('asks the caller to sign in with GitHub again when GitHub refuses their token', async () => {
    reposGetMock.mockRejectedValue(githubError(401));

    const response = await restart({ repoName: 'copied-test-repo' });

    expect(response.status).toBe(403);
    expect((await response.json()).message).toBe(
      'Sign in with GitHub again to preview this quiz with a repository.'
    );
    expect(createNewMock).not.toHaveBeenCalled();
  });

  it('names no mechanics in any of its refusals', async () => {
    const linked = { token: 'ghu_staff', userLogin: 'staff-gh', session: {} };
    const lines: string[] = [];
    for (const [auth, failure] of [
      [{ token: null, userLogin: '', session: {} }, null],
      [{ token: null, userLogin: 'staff-gh', session: {} }, null],
      [linked, githubError(404)],
      [linked, githubError(403, { 'x-ratelimit-remaining': '0' })],
    ] as const) {
      getAuthSessionMock.mockResolvedValue(auth);
      if (failure) reposGetMock.mockRejectedValue(failure);
      lines.push((await (await restart({ repoName: 'copied-test-repo' })).json()).message);
    }
    expect(new Set(lines).size).toBe(4);
    for (const line of lines) {
      expect(line).not.toMatch(/token|installation|rate limit|OAuth|\bapp\b/i);
    }
  });

  it('refuses, without storing anything, when GitHub cannot be asked', async () => {
    reposGetMock.mockRejectedValue(githubError(403, { 'x-ratelimit-remaining': '0' }));

    const limited = await restart({ repoName: 'copied-test-repo' });
    expect(limited.status).toBe(503);
    expect((await limited.json()).message).toBe(
      "Couldn't check that repository on GitHub. Please try again."
    );

    reposGetMock.mockRejectedValue(new Error('network down'));
    const failed = await restart({ repoName: 'copied-test-repo' });
    expect(failed.status).toBe(503);

    expect(createNewMock).not.toHaveBeenCalled();
    expect(updateAgentConfigMock).not.toHaveBeenCalled();
  });

  it('refuses a name that is not a repository name without asking GitHub', async () => {
    for (const repoName of ['repo/contents', '..', 'two words', 'x'.repeat(101)]) {
      const response = await restart({ repoName });
      expect(response.status).toBe(403);
    }
    expect(reposGetMock).not.toHaveBeenCalled();
    expect(createNewMock).not.toHaveBeenCalled();
  });

  it('refuses when the classroom has no GitHub organization', async () => {
    assertAccessMock.mockResolvedValue({
      userId: 'staff-1',
      classroom: { status: 'ACTIVE', slug: 'cs-1', git_organization: null },
      membership: { role: 'OWNER' },
    });

    const response = await restart({ repoName: 'copied-test-repo' });

    expect(response.status).toBe(403);
    expect(reposGetMock).not.toHaveBeenCalled();
    expect(createNewMock).not.toHaveBeenCalled();
  });

  it('asks GitHub nothing for a preview with no repository', async () => {
    const response = await restart({ attemptId: OWN_PREVIEW });

    expect(response.status).toBe(200);
    expect(reposGetMock).not.toHaveBeenCalled();
    expect(updateAgentConfigMock).not.toHaveBeenCalled();
  });

  it("ignores a student's repoName, as before, and asks GitHub nothing", async () => {
    asStaff('STUDENT');

    const response = await restart({ repoName: 'copied-test-repo' });

    expect(response.status).toBe(200);
    expect(reposGetMock).not.toHaveBeenCalled();
    expect(updateAgentConfigMock).not.toHaveBeenCalled();
  });
});
