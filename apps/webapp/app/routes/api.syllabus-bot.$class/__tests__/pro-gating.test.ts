import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Pro gating for the syllabus bot.
 *
 * The bot is Pro-only, matching quizzes. Bring-your-own-key is deliberately NOT
 * an access path — see entitlement.service.ts. These tests pin the three
 * properties that matter:
 *
 *   1. The loader reports the bot as disabled for an unentitled classroom, and
 *      only staff are told why.
 *   2. Mutations 403 rather than reaching the agent.
 *   3. Entitlement is checked AFTER the access check, so a non-member can never
 *      probe a classroom's plan.
 *
 * Mirrors api.quiz/__tests__/ai-gating.test.ts in shape.
 */

const isAIAgentConfiguredMock = vi.fn();
const assertClassroomAccessMock = vi.fn();
const assertClassroomMutationAllowedMock = vi.fn();
const canUseSyllabusBotMock = vi.fn();
const getClassroomSettingsForServerMock = vi.fn();
const sendRequestMock = vi.fn();

vi.mock('~/utils/aiFeatures.server', () => ({
  isAIAgentConfigured: () => isAIAgentConfiguredMock(),
}));

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

vi.mock('~/utils/agentStreamManager', () => ({ default: { publish: vi.fn() } }));
vi.mock('@classmoji/utils', () => ({ getContentRepoName: () => 'content-x' }));
vi.mock('~/routes/student.$class.quizzes/helpers.server', () => ({
  getInstallationToken: vi.fn(),
}));

const CLASS = 'some-class';
const CLASSROOM_ID = 'c1';

const classroomAccess = (role = 'STUDENT') => ({
  userId: 'user-1',
  classroom: { id: 'c1', name: 'Some Class', status: 'ACTIVE', git_organization: { login: 'org' } },
  membership: { role },
});

beforeEach(() => {
  vi.clearAllMocks();
  isAIAgentConfiguredMock.mockReturnValue(true);
  assertClassroomAccessMock.mockResolvedValue(classroomAccess());
  assertClassroomMutationAllowedMock.mockReturnValue(undefined);
  getClassroomSettingsForServerMock.mockResolvedValue({ syllabus_bot_enabled: true });
});

describe('syllabus bot Pro gating — loader', () => {
  it('reports disabled for an unentitled classroom even when the flag is on', async () => {
    canUseSyllabusBotMock.mockResolvedValue({ allowed: false, reason: 'pro_required' });
    const { loader } = await import('../route');

    const res = await loader({
      params: { class: CLASS },
      request: new Request('http://x/api/syllabus-bot/some-class'),
    } as never);
    const body = await (res as Response).json();

    expect(body.enabled).toBe(false);
  });

  it('tells staff why but never students, so only the UI that can upsell learns it', async () => {
    canUseSyllabusBotMock.mockResolvedValue({ allowed: false, reason: 'pro_required' });
    const { loader } = await import('../route');

    const read = async (role: string) => {
      assertClassroomAccessMock.mockResolvedValue(classroomAccess(role));
      const res = await loader({
        params: { class: CLASS },
        request: new Request('http://x/api/syllabus-bot/some-class'),
      } as never);
      return (res as Response).json();
    };

    expect((await read('OWNER')).reason).toBe('pro_required');
    expect((await read('TEACHER')).reason).toBe('pro_required');
    expect((await read('STUDENT')).reason).toBeUndefined();
    expect((await read('ASSISTANT')).reason).toBeUndefined();
  });

  it('serves the bot for an entitled classroom', async () => {
    canUseSyllabusBotMock.mockResolvedValue({ allowed: true });
    const { loader } = await import('../route');

    const res = await loader({
      params: { class: CLASS },
      request: new Request('http://x/api/syllabus-bot/some-class'),
    } as never);
    const body = await (res as Response).json();

    expect(body.enabled).toBe(true);
    // Without this, a refactor that stops passing the classroom id sails through.
    expect(canUseSyllabusBotMock).toHaveBeenCalledWith(CLASSROOM_ID);
  });
});

describe('syllabus bot Pro gating — action', () => {
  const post = async (fields: Record<string, string>) => {
    const { action } = await import('../route');
    const formData = new FormData();
    Object.entries(fields).forEach(([k, v]) => formData.append(k, v));
    return action({
      params: { class: CLASS },
      request: new Request('http://x/api/syllabus-bot/some-class', {
        method: 'POST',
        body: formData,
      }),
    } as never);
  };

  it('403s initConversation for an unentitled classroom', async () => {
    canUseSyllabusBotMock.mockResolvedValue({ allowed: false, reason: 'pro_required' });

    const res = (await post({ _action: 'initConversation' })) as Response;

    expect(res.status).toBe(403);
    expect(sendRequestMock).not.toHaveBeenCalled();
  });

  it('403s sendMessage for an unentitled classroom, buying no inference', async () => {
    canUseSyllabusBotMock.mockResolvedValue({ allowed: false, reason: 'pro_required' });

    const res = (await post({
      _action: 'sendMessage',
      conversationId: 'conv-1',
      content: 'hello',
    })) as Response;

    expect(res.status).toBe(403);
    expect(sendRequestMock).not.toHaveBeenCalled();
  });

  it('checks access before entitlement, so plan status cannot be probed', async () => {
    const denied = new Response('Forbidden', { status: 403 });
    assertClassroomAccessMock.mockRejectedValue(denied);
    canUseSyllabusBotMock.mockResolvedValue({ allowed: true });

    await expect(post({ _action: 'initConversation' })).rejects.toBe(denied);
    expect(canUseSyllabusBotMock).not.toHaveBeenCalled();
  });
});
