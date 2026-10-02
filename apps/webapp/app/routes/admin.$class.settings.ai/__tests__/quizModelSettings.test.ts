/**
 * Quiz models on AI settings (llm_model, code_aware_model, exploration_model).
 * Both quiz runtimes (the ai-agent and the Trigger.dev quiz tasks) run only
 * allow-listed models (isAllowedModel, @classmoji/utils/ai-models) and fall
 * back to the platform default for any other, so:
 *   - the quiz selects offer only allow-listed models; Ask Moji's offers every
 *     model (it has no allow-list);
 *   - a stored quiz model off the list shows as the default it runs as;
 *   - the action refuses one, so the page and the API cannot store a model the
 *     runtimes ignore.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ALLOWED_MODELS } from '@classmoji/utils/ai-models';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  updateSettings: vi.fn(),
  getClassroomSettingsForServer: vi.fn(),
  canUseSyllabusBot: vi.fn(),
  canUseQuizzes: vi.fn(),
  getAllModels: vi.fn(),
  EntitlementError: class ClassroomSettingsEntitlementError extends Error {},
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertClassroomMutationAllowed: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroom: {
      updateSettings: (...a: unknown[]) => mocks.updateSettings(...a),
      getClassroomSettingsForServer: (...a: unknown[]) => mocks.getClassroomSettingsForServer(...a),
    },
    entitlement: {
      canUseSyllabusBot: (...a: unknown[]) => mocks.canUseSyllabusBot(...a),
      canUseQuizzes: (...a: unknown[]) => mocks.canUseQuizzes(...a),
    },
  },
  ClassroomSettingsEntitlementError: mocks.EntitlementError,
  getAllModels: (...a: unknown[]) => mocks.getAllModels(...a),
  getModelLabel: (id: string) => `label:${id}`,
}));

vi.mock('~/utils/aiFeatures.server', () => ({ isAIAgentConfigured: () => true }));
vi.mock('~/components', () => ({ SettingSection: () => null }));
vi.mock('~/hooks', () => ({ useGlobalFetcher: () => ({ fetcher: null }) }));

const { action, loader } = await import('../route');

const QUIZ_FIELDS = ['llm_model', 'code_aware_model', 'exploration_model'] as const;

/** What the live models call returns: allow-listed models and others. */
const LIVE_MODELS = [
  { value: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { value: 'claude-sonnet-5-5-20260901', label: 'Claude Sonnet 5.5' },
  { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { value: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
  { value: 'claude-opus-5-9', label: 'Claude Opus 5.9' },
  { value: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
];

const HAIKU = 'claude-haiku-4-5-20251001';

const post = (body: unknown) =>
  action({
    params: { class: 'cs52' },
    request: new Request('http://x/admin/cs52/settings/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as never) as Promise<{ success?: string; error?: string }>;

const save = (fields: Record<string, unknown>) =>
  post({ _action: 'saveLLMSettings', anthropic_api_key: '', ...fields });

const load = () =>
  loader({
    params: { class: 'cs52' },
    request: new Request('http://x/admin/cs52/settings/ai'),
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertClassroomAccess.mockResolvedValue({
    classroom: { id: 'c1', status: 'ACTIVE' },
    membership: { role: 'OWNER' },
  });
  mocks.updateSettings.mockResolvedValue({});
  mocks.getClassroomSettingsForServer.mockResolvedValue({ anthropic_api_key: 'sk-ant-classroom' });
  mocks.canUseSyllabusBot.mockResolvedValue({ allowed: true });
  mocks.canUseQuizzes.mockResolvedValue({ allowed: true });
  mocks.getAllModels.mockResolvedValue({ anthropic: LIVE_MODELS });
});

describe('loader: model lists', () => {
  it('offers the quiz selects only allow-listed models', async () => {
    const data = await load();
    expect(data.quizModels.map(model => model.value)).toEqual([
      'claude-opus-5-5',
      'claude-sonnet-5-5-20260901',
      'claude-sonnet-5',
      'claude-fable-5-1',
    ]);
  });

  it("leaves Ask Moji's list whole", async () => {
    const data = await load();
    expect(data.availableModels.anthropic).toEqual(LIVE_MODELS);
  });
});

describe('loader: a stored quiz model off the allow-list', () => {
  it.each(QUIZ_FIELDS)('shows the default for %s, not the stored model', async field => {
    mocks.getClassroomSettingsForServer.mockResolvedValue({
      anthropic_api_key: 'sk-ant-classroom',
      [field]: HAIKU,
    });
    const data = await load();
    expect(data.selectValues[field]).toBeNull();
  });

  it('keeps an allow-listed stored model, dated or not', async () => {
    mocks.getClassroomSettingsForServer.mockResolvedValue({
      anthropic_api_key: 'sk-ant-classroom',
      llm_model: 'claude-opus-5',
      exploration_model: 'claude-sonnet-5-5-20260901',
    });
    const data = await load();
    expect(data.selectValues.llm_model).toBe('claude-opus-5');
    expect(data.selectValues.exploration_model).toBe('claude-sonnet-5-5-20260901');
  });

  it("keeps Ask Moji's stored model, which its runtime runs", async () => {
    mocks.getClassroomSettingsForServer.mockResolvedValue({
      anthropic_api_key: 'sk-ant-classroom',
      syllabus_bot_model: HAIKU,
    });
    const data = await load();
    expect(data.selectValues.syllabus_bot_model).toBe(HAIKU);
  });
});

describe('saveLLMSettings: quiz models', () => {
  const ERRORS = {
    llm_model: 'Standard quiz model',
    code_aware_model: 'Code-aware quiz model',
    exploration_model: 'Code exploration model',
  } as const;

  it.each(QUIZ_FIELDS)('refuses Haiku for %s and writes nothing', async field => {
    const result = await save({ question_effort: 'high', [field]: HAIKU });
    expect(result.error).toBe(
      `${ERRORS[field]} must be one of ${ALLOWED_MODELS.join(', ')}, or empty for the default.`
    );
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it.each(['claude-haiku-4-5', 'claude-sonnet-4-5-20250929', 'claude-opus-5-9', 'gpt-4o'])(
    'refuses %s for llm_model',
    async model => {
      const result = await save({ llm_model: model });
      expect(result.error).toMatch(/^Standard quiz model must be one of /);
      expect(mocks.updateSettings).not.toHaveBeenCalled();
    }
  );

  it.each(QUIZ_FIELDS)('stores every allow-listed model for %s', async field => {
    for (const model of ALLOWED_MODELS) {
      mocks.updateSettings.mockClear();
      const result = await save({ [field]: model });
      expect(result.error).toBeUndefined();
      expect(mocks.updateSettings).toHaveBeenCalledWith('c1', { [field]: model });
    }
  });

  it('stores a dated allow-listed model, trimmed', async () => {
    await save({ code_aware_model: ' claude-sonnet-5-5-20260901 ' });
    expect(mocks.updateSettings).toHaveBeenCalledWith('c1', {
      code_aware_model: 'claude-sonnet-5-5-20260901',
    });
  });

  it('still puts a cleared quiz model back to the default', async () => {
    await save({ llm_model: null, exploration_model: '' });
    expect(mocks.updateSettings).toHaveBeenCalledWith('c1', {
      llm_model: null,
      exploration_model: null,
    });
  });

  it('stores any model for Ask Moji, whose runtime has no allow-list', async () => {
    const result = await save({ syllabus_bot_model: HAIKU });
    expect(result.error).toBeUndefined();
    expect(mocks.updateSettings).toHaveBeenCalledWith('c1', { syllabus_bot_model: HAIKU });
  });
});
