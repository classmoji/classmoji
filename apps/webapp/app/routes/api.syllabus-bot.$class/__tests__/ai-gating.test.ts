import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * AI gating (RW-13) for the syllabus-bot endpoint. The dev/test server always
 * has the agent configured, so the unconfigured branch can only be exercised
 * deterministically by mocking isAIAgentConfigured(). The loader reports
 * `enabled: false` (after auth) and the action returns 503.
 */

const isAIAgentConfiguredMock = vi.fn();
const assertClassroomAccessMock = vi.fn();

vi.mock('~/utils/aiFeatures.server', () => ({
  isAIAgentConfigured: () => isAIAgentConfiguredMock(),
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => assertClassroomAccessMock(...a),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  assertClassroomMutationAllowed: vi.fn(),
}));

vi.mock('~/services/aiAgentConnection.server', () => ({ sendRequest: vi.fn() }));
vi.mock('~/utils/agentStreamManager', () => ({ default: {} }));
vi.mock('~/routes/student.$class.quizzes/helpers.server', () => ({
  getInstallationToken: vi.fn(),
}));
vi.mock('@classmoji/utils', () => ({ getContentRepoName: () => '' }));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroom: { getClassroomSettingsForServer: vi.fn() },
  },
}));

const { loader, action } = await import('../route.ts');

const loaderArgs = () =>
  ({
    params: { class: 'test-class' },
    request: new Request('http://localhost/api/syllabus-bot/test-class'),
  }) as unknown as Parameters<typeof loader>[0];

const actionArgs = (form: Record<string, string>) => {
  const body = new URLSearchParams(form);
  return {
    params: { class: 'test-class' },
    request: new Request('http://localhost/api/syllabus-bot/test-class', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }),
  } as unknown as Parameters<typeof action>[0];
};

describe('api.syllabus-bot AI gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertClassroomAccessMock.mockResolvedValue({
      userId: 'u-1',
      classroom: { id: 'c-1', name: 'Test Class', status: 'ACTIVE', git_organization: null },
      membership: { role: 'STUDENT' },
    });
  });

  it('loader reports the bot as disabled when the AI agent is not configured', async () => {
    isAIAgentConfiguredMock.mockReturnValue(false);
    const res = await loader(loaderArgs());
    const body = await res.json();
    expect(body.enabled).toBe(false);
    // Auth still ran before the config check.
    expect(assertClassroomAccessMock).toHaveBeenCalledTimes(1);
  });

  it('action returns 503 when the AI agent is not configured', async () => {
    isAIAgentConfiguredMock.mockReturnValue(false);
    const res = await action(actionArgs({ _action: 'initConversation' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/not configured/i) });
  });
});
