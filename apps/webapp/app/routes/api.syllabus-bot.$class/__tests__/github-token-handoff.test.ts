import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * P3-3 — the webapp stops handing ai-agent a GitHub credential.
 *
 * WHAT THIS USED TO DO. When a classroom had a content repo, init minted the
 * classroom's whole GitHub App INSTALLATION TOKEN and put it in the payload as
 * `accessToken`, alongside `contentRepoName`, so ai-agent could clone the repo
 * and read course content off disk. One handoff, four problems:
 *
 *   - a live GitHub credential sitting on another service's filesystem,
 *     scoped to the entire installation rather than to one repo;
 *   - a clone that grew without bound and was never evicted;
 *   - the draft leak — a git checkout answers every role identically, so a
 *     student's question could reach unpublished content;
 *   - a second content-query layer that drifted from the webapp's own rules at
 *     every migration.
 *
 * Content now resolves through the Classmoji MCP server using `mcpToken`: the
 * CALLER's own bearer, re-authorized against their real ClassroomMembership on
 * every tool call. Nothing about GitHub belongs in this payload any more.
 *
 * The important test is the LAST one: a deletion is only proven by a case that
 * would have taken the deleted branch. A classroom with no content repo never
 * minted a token even before this change.
 */

const assertClassroomAccessMock = vi.fn();
const assertClassroomMutationAllowedMock = vi.fn();
const canUseSyllabusBotMock = vi.fn();
const getClassroomSettingsForServerMock = vi.fn();
const sendRequestMock = vi.fn();
const mintMcpAccessTokenMock = vi.fn();
const getInstallationTokenMock = vi.fn();
const getContentRepoNameMock = vi.fn();

vi.mock('~/utils/aiFeatures.server', () => ({ isAIAgentConfigured: () => true }));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => assertClassroomAccessMock(...a),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  assertClassroomMutationAllowed: (...a: unknown[]) => assertClassroomMutationAllowedMock(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    entitlement: { canUseSyllabusBot: (...a: unknown[]) => canUseSyllabusBotMock(...a) },
    classroom: {
      getClassroomSettingsForServer: (...a: unknown[]) => getClassroomSettingsForServerMock(...a),
    },
  },
}));

vi.mock('~/services/aiAgentConnection.server', () => ({
  sendRequest: (...a: unknown[]) => sendRequestMock(...a),
}));

vi.mock('~/utils/agentStreamManager', () => ({
  default: {
    registerSession: vi.fn(),
    publishStep: vi.fn(),
    publishError: vi.fn(),
    publishAssistantResponse: vi.fn(),
    publishDone: vi.fn(),
  },
}));

vi.mock('@classmoji/utils', () => ({
  getContentRepoName: (...a: unknown[]) => getContentRepoNameMock(...a),
}));

/**
 * Still mocked even though the route no longer imports it: if someone
 * reintroduces the import, this spy is what shows the token was minted.
 */
vi.mock('~/routes/student.$class.quizzes/helpers.server', () => ({
  getInstallationToken: (...a: unknown[]) => getInstallationTokenMock(...a),
}));

vi.mock('@classmoji/auth/mcp-token', () => ({
  mintMcpAccessToken: (...a: unknown[]) => mintMcpAccessTokenMock(...a),
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    aIConversation: { findFirst: vi.fn(async () => ({ id: 'conv-mine' })) },
  }),
}));

const CLASS = 'cs52-winter-2026';

/** A classroom that WOULD have taken the old clone branch. */
const CLASSROOM_WITH_CONTENT_REPO = {
  id: 'c1',
  name: 'CS52',
  status: 'ACTIVE',
  content_repo: 'cs52-content',
  git_organization: { login: 'dartmouth-cs52', github_installation_id: 12345 },
};

const post = async (fields: Record<string, string>) => {
  const { action } = await import('../route');
  const formData = new FormData();
  Object.entries(fields).forEach(([k, v]) => formData.append(k, v));
  return (await action({
    params: { class: CLASS },
    request: new Request(`http://x/api/syllabus-bot/${CLASS}`, { method: 'POST', body: formData }),
  } as never)) as Response;
};

const payloadFor = (type: string) =>
  sendRequestMock.mock.calls.find(call => call[0] === type)?.[1] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  assertClassroomAccessMock.mockResolvedValue({
    userId: 'user-1',
    classroom: CLASSROOM_WITH_CONTENT_REPO,
    membership: { role: 'STUDENT' },
  });
  assertClassroomMutationAllowedMock.mockReturnValue(undefined);
  canUseSyllabusBotMock.mockResolvedValue({ allowed: true });
  getClassroomSettingsForServerMock.mockResolvedValue({
    syllabus_bot_enabled: true,
    // The legacy override that used to win the precedence chain.
    content_repo_name: 'cs52-content-legacy',
  });
  getContentRepoNameMock.mockReturnValue('dartmouth-cs52-content');
  getInstallationTokenMock.mockResolvedValue('ghs_installation_token_for_whole_org');
  mintMcpAccessTokenMock.mockResolvedValue({
    accessToken: 'askmoji_deadbeef',
    expiresAt: new Date('2030-01-01T00:00:00.000Z'),
  });
  sendRequestMock.mockImplementation(async (type: string) =>
    type === 'SYLLABUS_BOT_INIT'
      ? { payload: { conversationId: 'conv-mine', welcomeMessage: 'hi' } }
      : { payload: { content: 'hi', references: [] } }
  );
});

describe('P3-3 — no GitHub credential in the ai-agent payload', () => {
  it('sends no contentRepoName and no accessToken on init', async () => {
    const res = await post({ _action: 'initConversation' });
    expect(res.status).toBe(200);

    const payload = payloadFor('SYLLABUS_BOT_INIT');
    expect(payload).not.toHaveProperty('accessToken');
    expect(payload).not.toHaveProperty('contentRepoName');
    // The whole payload, so a future addition has to be deliberate.
    expect(Object.keys(payload).sort()).toEqual(['llmConfig', 'mcpToken', 'orgConfig', 'userId']);
  });

  it('still sends the per-user MCP bearer — that is what replaced it', async () => {
    await post({ _action: 'initConversation' });

    expect(payloadFor('SYLLABUS_BOT_INIT')).toMatchObject({
      mcpToken: {
        accessToken: 'askmoji_deadbeef',
        expiresAt: '2030-01-01T00:00:00.000Z',
      },
    });
  });

  it('NEVER mints a GitHub installation token, even for a classroom that has a content repo', async () => {
    // CLASSROOM_WITH_CONTENT_REPO satisfies every condition of the old branch:
    // a settings override, a stored content_repo, a git org with an
    // installation id. The old code would have called getInstallationToken here.
    await post({ _action: 'initConversation' });

    expect(getInstallationTokenMock).not.toHaveBeenCalled();

    const serialized = JSON.stringify(payloadFor('SYLLABUS_BOT_INIT'));
    expect(serialized).not.toContain('ghs_installation_token_for_whole_org');
    expect(serialized).not.toContain('cs52-content');
  });

  it('sends no GitHub credential on a message turn either', async () => {
    await post({ _action: 'sendMessage', conversationId: 'conv-mine', content: 'hello' });

    const payload = payloadFor('SYLLABUS_BOT_MESSAGE');
    expect(payload).not.toHaveProperty('accessToken');
    expect(payload).not.toHaveProperty('contentRepoName');
    expect(payload).toHaveProperty('mcpToken');
    expect(getInstallationTokenMock).not.toHaveBeenCalled();
  });
});

describe('P3-3 — hasContentRepo is now the webapp’s answer, not ai-agent’s', () => {
  it('reports it from the classroom record, without ai-agent saying anything', async () => {
    const res = await post({ _action: 'initConversation' });
    const body = (await res.json()) as { hasContentRepo: boolean };

    // ai-agent's SYLLABUS_BOT_READY carries no hasContentRepo any more; it
    // clones nothing, so it has no idea. The webapp always knew.
    expect(body.hasContentRepo).toBe(true);
  });

  it('reports false when the classroom has no content repo, no git org and no legacy override', async () => {
    assertClassroomAccessMock.mockResolvedValue({
      userId: 'user-1',
      classroom: { id: 'c1', name: 'CS52', status: 'ACTIVE', git_organization: null },
      membership: { role: 'STUDENT' },
    });
    // The shared fixture carries `content_repo_name`; a classroom with NOTHING
    // configured has to have it cleared, or this asserts the wrong scenario.
    getClassroomSettingsForServerMock.mockResolvedValue({ syllabus_bot_enabled: true });

    const res = await post({ _action: 'initConversation' });
    const body = (await res.json()) as { hasContentRepo: boolean };

    expect(body.hasContentRepo).toBe(false);
    expect(getContentRepoNameMock).not.toHaveBeenCalled();
  });

  /**
   * THE PRECEDENCE REGRESSION (review finding 5a).
   *
   * Before the GitHub handoff was removed, the init path decided whether a
   * classroom had content with `settings.content_repo_name || classroom.content_repo
   * || <org fallback>`. Consolidating the two call sites into `hasContentRepoFor`
   * silently dropped the first term. A classroom configured ONLY through the
   * legacy override — null `content_repo`, and an org whose conventional repo
   * does not exist — was then told it has no content, and the widget stopped
   * offering content questions that the MCP would have answered.
   *
   * MUTATION: drop `settings?.content_repo_name ||` from hasContentRepoFor → both
   * assertions below fail.
   */
  it('reports TRUE for a classroom configured only through the legacy settings override', async () => {
    assertClassroomAccessMock.mockResolvedValue({
      userId: 'user-1',
      classroom: {
        id: 'c1',
        name: 'CS52',
        status: 'ACTIVE',
        content_repo: null, // nothing stored on the classroom
        git_organization: null, // and no org to fall back to
      },
      membership: { role: 'STUDENT' },
    });
    getClassroomSettingsForServerMock.mockResolvedValue({
      syllabus_bot_enabled: true,
      content_repo_name: 'cs52-content-legacy',
    });

    const res = await post({ _action: 'initConversation' });
    expect((await res.json()).hasContentRepo).toBe(true);
  });

  // The loader answers the same question and must answer it the same way — the
  // widget reads it from here on mount and from init on open.
  it('reports it the same way from the loader', async () => {
    assertClassroomAccessMock.mockResolvedValue({
      userId: 'user-1',
      classroom: {
        id: 'c1',
        name: 'CS52',
        status: 'ACTIVE',
        content_repo: null,
        git_organization: null,
      },
      membership: { role: 'STUDENT' },
    });
    getClassroomSettingsForServerMock.mockResolvedValue({
      syllabus_bot_enabled: true,
      content_repo_name: 'cs52-content-legacy',
    });

    const { loader } = await import('../route');
    const res = (await loader({
      params: { class: CLASS },
      request: new Request(`http://x/api/syllabus-bot/${CLASS}`),
    } as never)) as Response;

    expect((await res.json()).hasContentRepo).toBe(true);
  });
});
