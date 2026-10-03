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
  hostForOrganization: vi.fn(),
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
    gitlabInstance: { hostForOrganization: fakes.hostForOrganization },
  },
}));

const { clearAttemptContextCache, loadAttemptContext } = await import('../context.ts');

const admission = { fence: 'fence-1', inputMessageId: 'msg-1', runId: 'run_1' };
const env = { ANTHROPIC_API_KEY: 'platform-key' };

function attempt(
  over: { include_code_context?: boolean; subject?: string | null; excluded_paths?: unknown } = {}
) {
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
      name: 'Layout quiz',
      subject: over.subject === undefined ? 'CSS layout' : over.subject,
      difficulty_level: null,
      excluded_paths: over.excluded_paths ?? [],
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

describe("loadAttemptContext: admission's count of the messages left", () => {
  it('carries it into the turn, and none for a turn without it', async () => {
    fakes.findByStudent.mockResolvedValue({ name: 'landing-page' });
    const ctx = await loadAttemptContext(
      'attempt-1',
      { ...admission, messagesLeft: 7 },
      { log: vi.fn(), env }
    );
    expect(ctx.messagesLeft).toBe(7);
    const begin = await loadAttemptContext(
      'attempt-1',
      { ...admission, inputMessageId: null },
      { log: vi.fn(), env }
    );
    expect(begin).not.toHaveProperty('messagesLeft');
  });
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

  it("carries the quiz's excluded paths into the exploration", async () => {
    fakes.findByStudent.mockResolvedValue({ name: 'landing-page' });
    fakes.findById.mockResolvedValue(
      attempt({ excluded_paths: ['tests/**', '**/*.spec.js', 'playwright.config.*'] })
    );
    const ctx = await loadAttemptContext('attempt-1', admission, { log: vi.fn(), env });
    expect(ctx.exploration?.excludedPaths).toEqual([
      'tests/**',
      '**/*.spec.js',
      'playwright.config.*',
    ]);
  });

  it('reads the excluded paths every turn, so an edit applies from the next turn', async () => {
    fakes.findByStudent.mockResolvedValue({ name: 'landing-page' });
    fakes.findById.mockResolvedValue(attempt({ excluded_paths: ['tests/**'] }));
    const first = await loadAttemptContext('attempt-1', admission, { log: vi.fn(), env });
    expect(first.exploration?.excludedPaths).toEqual(['tests/**']);

    fakes.findById.mockResolvedValue(attempt({ excluded_paths: ['tests/**', 'docs/**'] }));
    const second = await loadAttemptContext('attempt-1', admission, { log: vi.fn(), env });
    expect(second.exploration?.excludedPaths).toEqual(['tests/**', 'docs/**']);

    fakes.findById.mockResolvedValue(attempt({ excluded_paths: [] }));
    const third = await loadAttemptContext('attempt-1', admission, { log: vi.fn(), env });
    expect(third.exploration?.excludedPaths).toEqual([]);

    // The rest of the attempt's parts stay cached: the repository is looked up once.
    expect(fakes.findByStudent).toHaveBeenCalledTimes(1);
    expect(third.exploration).toMatchObject({ owner: 'sample-org', repo: 'landing-page' });
  });

  it('has no excluded paths for a quiz without any, or with a malformed value', async () => {
    fakes.findByStudent.mockResolvedValue({ name: 'landing-page' });
    const ctx = await loadAttemptContext('attempt-1', admission, { log: vi.fn(), env });
    expect(ctx.exploration?.excludedPaths).toEqual([]);

    clearAttemptContextCache();
    fakes.findById.mockResolvedValue(attempt({ excluded_paths: null }));
    const again = await loadAttemptContext('attempt-1', admission, { log: vi.fn(), env });
    expect(again.exploration?.excludedPaths).toEqual([]);
  });

  it('never flags missing code on a standard quiz', async () => {
    fakes.findById.mockResolvedValue(attempt({ include_code_context: false }));
    const ctx = await loadAttemptContext('attempt-1', admission, { log: vi.fn(), env });
    expect(ctx.codeUnavailable).toBe(false);
    expect(fakes.findByStudent).not.toHaveBeenCalled();
  });
});

describe('loadAttemptContext: the welcome', () => {
  it('fills the code-aware welcome from the subject and the question count', async () => {
    fakes.findByStudent.mockResolvedValue({ name: 'landing-page' });
    const ctx = await loadAttemptContext('attempt-1', admission, { log: vi.fn(), env });
    expect(ctx.welcome).toBe(
      "Welcome to your code review quiz on CSS layout! I'll look at your repository first, then ask you 8 questions about your implementation."
    );
  });

  it('uses the quiz name without a subject', async () => {
    fakes.findById.mockResolvedValue(attempt({ subject: null }));
    fakes.findByStudent.mockResolvedValue({ name: 'landing-page' });
    const ctx = await loadAttemptContext('attempt-1', admission, { log: vi.fn(), env });
    expect(ctx.welcome).toBe(
      "Welcome to your code review quiz on Layout quiz! I'll look at your repository first, then ask you 8 questions about your implementation."
    );
  });

  it('tells a student with no repository that the quiz is on the concepts', async () => {
    fakes.findByStudent.mockResolvedValue(null);
    const ctx = await loadAttemptContext('attempt-1', admission, { log: vi.fn(), env });
    expect(ctx.codeUnavailable).toBe(true);
    expect(ctx.welcome).toBe(
      "Welcome to your quiz! This assignment doesn't have a linked repository. Let's discuss the concepts."
    );
  });

  it('keeps the standard welcome on a standard quiz', async () => {
    fakes.findById.mockResolvedValue(attempt({ include_code_context: false }));
    const ctx = await loadAttemptContext('attempt-1', admission, { log: vi.fn(), env });
    expect(ctx.welcome).toBe(
      "Welcome to your quiz on **CSS layout**! I'll be asking you 8 questions to assess your understanding. Let's get started!"
    );
  });
});

describe('loadAttemptContext: the content tools', () => {
  const material = {
    docs: [{ kind: 'page', id: 'p1', title: 'Flexbox basics', text: 'Flex containers.' }],
    configured: 1,
    totalChars: 16,
  };

  it('gives an attempt with linked material its lookups when the MCP server is configured', async () => {
    fakes.findById.mockResolvedValue(attempt({ include_code_context: false }));
    fakes.loadMaterial.mockResolvedValue(material);
    const ctx = await loadAttemptContext('attempt-1', admission, {
      log: vi.fn(),
      env: { ...env, MCP_PUBLIC_URL: 'https://mcp.example.test' },
    });
    expect(ctx.content).toEqual({
      mcpUrl: 'https://mcp.example.test/mcp',
      classroomRef: 'sample-org/cs-1',
      courseSearchEnabled: false,
      docs: [{ kind: 'page', id: 'p1', title: 'Flexbox basics' }],
    });
    expect(ctx.prompt.staticPrompt).toContain('content_get(kind, id)');
  });

  it('has none, and names none, without the MCP server', async () => {
    fakes.findById.mockResolvedValue(attempt({ include_code_context: false }));
    fakes.loadMaterial.mockResolvedValue(material);
    const ctx = await loadAttemptContext('attempt-1', admission, { log: vi.fn(), env });
    expect(ctx.content).toBeNull();
    expect(ctx.prompt.staticPrompt).not.toMatch(/content_(get|search)/);
  });
});

describe('loadAttemptContext: where a code-aware attempt explores', () => {
  const GITLAB_ORG = {
    login: 'dept/cs10',
    provider: 'GITLAB',
    gitlab_connection_id: 'conn-1',
    base_url: null,
    gitlab_instance_id: 'instance-1',
  };

  function gitlabAttempt(agentConfig: Record<string, unknown> | null = null) {
    const base = attempt();
    return {
      ...base,
      agent_config: agentConfig,
      quiz: {
        ...base.quiz,
        classroom: {
          ...base.quiz.classroom,
          git_namespace: 'dept/cs10/fall',
          git_organization: GITLAB_ORG,
        },
      },
    };
  }

  beforeEach(() => {
    fakes.hostForOrganization.mockResolvedValue('https://gitlab.example.edu');
  });

  it("reads a Github student's repository from the org, with no host", async () => {
    fakes.findByStudent.mockResolvedValue({ name: 'landing-page' });
    const ctx = await loadAttemptContext('attempt-1', admission, { log: vi.fn(), env });
    expect(ctx.exploration).toMatchObject({
      owner: 'sample-org',
      repo: 'landing-page',
      gitOrganization: { login: 'sample-org', provider: 'GITHUB', github_installation_id: '1' },
    });
    expect(ctx.exploration).not.toHaveProperty('gitHost');
    expect(fakes.hostForOrganization).not.toHaveBeenCalled();
  });

  it("reads a Gitlab student's project from the class's projects subgroup on its instance", async () => {
    fakes.findById.mockResolvedValue(gitlabAttempt());
    fakes.findByStudent.mockResolvedValue({ name: 'landing-page-ada' });
    const ctx = await loadAttemptContext('attempt-1', admission, { log: vi.fn(), env });
    expect(ctx.isCodeAware).toBe(true);
    expect(ctx.exploration).toMatchObject({
      owner: 'dept/cs10/fall/projects',
      repo: 'landing-page-ada',
      gitHost: 'https://gitlab.example.edu',
      // The token is minted for this one project, in its namespace.
      gitOrganization: { ...GITLAB_ORG, login: 'dept/cs10/fall/projects' },
    });
    expect(fakes.hostForOrganization).toHaveBeenCalledWith(GITLAB_ORG);
  });

  it("reads a staff preview's project by its full path inside the class's group", async () => {
    fakes.findById.mockResolvedValue(
      gitlabAttempt({ instructorRepoName: 'dept/cs10/fall/templates/landing-page-solution' })
    );
    fakes.findFirst.mockResolvedValue({ id: 'membership-1' });
    const ctx = await loadAttemptContext('attempt-1', admission, { log: vi.fn(), env });
    expect(ctx.exploration).toMatchObject({
      owner: 'dept/cs10/fall/templates',
      repo: 'landing-page-solution',
      gitHost: 'https://gitlab.example.edu',
    });
    expect(fakes.findByStudent).not.toHaveBeenCalled();
  });

  it("never reads a staff preview's project outside the class's group", async () => {
    fakes.findById.mockResolvedValue(
      gitlabAttempt({ instructorRepoName: 'someone-else/landing-page' })
    );
    fakes.findFirst.mockResolvedValue({ id: 'membership-1' });
    const ctx = await loadAttemptContext('attempt-1', admission, { log: vi.fn(), env });
    expect(ctx.exploration).toBeNull();
    expect(ctx.codeUnavailable).toBe(true);
  });
});
