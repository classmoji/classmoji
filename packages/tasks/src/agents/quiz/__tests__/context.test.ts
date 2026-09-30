/**
 * The per-attempt context for a code-aware quiz whose repository lookup finds
 * nothing: the turn runs without exploration, says so to the loop, and the
 * result is not cached, so a later turn looks again. Services are faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({
  findById: vi.fn(),
  getProgress: vi.fn(),
  findByStudent: vi.fn(),
  loadMaterial: vi.fn(),
  findFirst: vi.fn(),
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({ classroomMembership: { findFirst: fakes.findFirst } }),
}));

vi.mock('@classmoji/services', () => ({
  getGitProvider: vi.fn(),
  ClassmojiService: {
    quizAttempt: { findById: fakes.findById },
    quizGrading: { getProgress: fakes.getProgress },
    gitRepo: { findByStudent: fakes.findByStudent },
    quizSourceMaterial: { load: fakes.loadMaterial },
  },
}));

const { clearAttemptContextCache, loadAttemptContext } = await import('../context.ts');

const admission = { fence: 'fence-1', inputMessageId: 'msg-1', runId: 'run_1' };
const env = { ANTHROPIC_API_KEY: 'platform-key' };

function attempt(over: { include_code_context?: boolean } = {}) {
  return {
    id: 'attempt-1',
    user_id: 'user-1',
    quiz_id: 'quiz-1',
    agent_config: null,
    quiz: {
      id: 'quiz-1',
      classroom_id: 'class-1',
      repository_id: 'assignment-repo-1',
      include_code_context: over.include_code_context ?? true,
      system_prompt: null,
      rubric_prompt: null,
      subject: 'CSS layout',
      difficulty_level: null,
      classroom: {
        slug: 'cs-1',
        settings: null,
        git_organization: { login: 'sample-org', provider: 'GITHUB', github_installation_id: '1' },
      },
    },
  };
}

beforeEach(() => {
  clearAttemptContextCache();
  for (const fn of Object.values(fakes)) fn.mockReset();
  fakes.getProgress.mockResolvedValue({
    questionCount: 8,
    presented: 0,
    finalized: [],
    completed: false,
    hasEvaluation: false,
  });
  fakes.loadMaterial.mockResolvedValue({ docs: [], configured: 0, totalChars: 0 });
  fakes.findById.mockResolvedValue(attempt());
});

describe('loadAttemptContext for a code-aware quiz', () => {
  it('runs without exploration and flags the missing code when no repository is found', async () => {
    fakes.findByStudent.mockResolvedValue(null);
    const log = vi.fn();
    const ctx = await loadAttemptContext('attempt-1', admission, { log, env });
    expect(ctx.isCodeAware).toBe(false);
    expect(ctx.exploration).toBeNull();
    expect(ctx.codeUnavailable).toBe(true);
    expect(ctx.prompt.staticPrompt).not.toContain('explore_codebase');
    expect(log).toHaveBeenCalledWith(
      '[quiz-agent] code-aware attempt has no repository to explore',
      { attemptId: 'attempt-1', hasOrg: true }
    );
  });

  it('does not cache that result: the next turn finds the repository and explores', async () => {
    fakes.findByStudent.mockResolvedValueOnce(null).mockResolvedValue({ name: 'landing-page' });
    const first = await loadAttemptContext('attempt-1', admission, { log: vi.fn(), env });
    expect(first.codeUnavailable).toBe(true);

    const second = await loadAttemptContext('attempt-1', admission, { log: vi.fn(), env });
    expect(fakes.findByStudent).toHaveBeenCalledTimes(2);
    expect(second.isCodeAware).toBe(true);
    expect(second.codeUnavailable).toBe(false);
    expect(second.exploration).toMatchObject({ owner: 'sample-org', repo: 'landing-page' });
    expect(second.prompt.staticPrompt).toContain('explore_codebase');
  });

  it('caches a found repository for the next turn', async () => {
    fakes.findByStudent.mockResolvedValue({ name: 'landing-page' });
    await loadAttemptContext('attempt-1', admission, { log: vi.fn(), env });
    const again = await loadAttemptContext('attempt-1', admission, { log: vi.fn(), env });
    expect(fakes.findByStudent).toHaveBeenCalledTimes(1);
    expect(again.codeUnavailable).toBe(false);
  });

  it('never flags missing code on a standard quiz', async () => {
    fakes.findById.mockResolvedValue(attempt({ include_code_context: false }));
    const ctx = await loadAttemptContext('attempt-1', admission, { log: vi.fn(), env });
    expect(ctx.codeUnavailable).toBe(false);
    expect(fakes.findByStudent).not.toHaveBeenCalled();
  });
});
