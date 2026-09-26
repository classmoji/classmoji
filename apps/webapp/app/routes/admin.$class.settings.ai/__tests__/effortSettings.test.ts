/**
 * Reasoning effort on Quiz settings (question_effort, grading_effort,
 * exploration_effort). The ai-agent passes the stored value to the model, so
 * the action is the gate: it stores only a level the field offers (exploration
 * stops at high) or null, refuses anything else, requires the classroom's own key to set one (the disabled
 * Selects are not the gate), and Clear All Settings resets them.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  updateSettings: vi.fn(),
  getClassroomSettingsForServer: vi.fn(),
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
  },
}));

vi.mock('~/utils/aiFeatures.server', () => ({ isAIAgentConfigured: () => true }));
vi.mock('~/components', () => ({ SettingSection: () => null }));
vi.mock('~/hooks', () => ({ useGlobalFetcher: () => ({ fetcher: null }) }));

const { action } = await import('../route');

const post = (body: unknown) =>
  action({
    params: { class: 'cs52' },
    request: new Request('http://x/admin/cs52/settings/quizzes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as never) as Promise<{ success?: string; error?: string }>;

const save = (fields: Record<string, unknown>) =>
  post({ _action: 'saveLLMSettings', anthropic_api_key: '', ...fields });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertClassroomAccess.mockResolvedValue({
    classroom: { id: 'c1', status: 'ACTIVE' },
    membership: { role: 'OWNER' },
  });
  mocks.updateSettings.mockResolvedValue({});
  mocks.getClassroomSettingsForServer.mockResolvedValue({ anthropic_api_key: 'sk-ant-classroom' });
});

describe('saveLLMSettings: effort', () => {
  it.each([['question_effort'], ['grading_effort']])(
    'stores each of the five levels for %s',
    async field => {
      for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
        mocks.updateSettings.mockClear();
        const result = await save({ [field]: level });
        expect(result.error).toBeUndefined();
        expect(mocks.updateSettings).toHaveBeenCalledWith('c1', { [field]: level });
      }
    }
  );

  // At xhigh/max the excerpt call's thinking can use up its max_tokens and
  // fall back to whole files, so exploration offers low, medium and high only.
  it('stores low, medium and high for exploration_effort', async () => {
    for (const level of ['low', 'medium', 'high']) {
      mocks.updateSettings.mockClear();
      const result = await save({ exploration_effort: level });
      expect(result.error).toBeUndefined();
      expect(mocks.updateSettings).toHaveBeenCalledWith('c1', { exploration_effort: level });
    }
  });

  it.each([['xhigh'], ['max']])(
    'refuses %s for exploration_effort and writes nothing',
    async level => {
      const result = await save({ question_effort: level, exploration_effort: level });
      expect(result.error).toBe(
        'Exploration effort must be one of low, medium, high, or empty for the default.'
      );
      expect(mocks.updateSettings).not.toHaveBeenCalled();
    }
  );

  it('stores the three fields together, alongside the model fields', async () => {
    await save({
      llm_model: 'claude-sonnet-5',
      question_effort: 'high',
      grading_effort: 'max',
      exploration_effort: 'low',
    });
    expect(mocks.updateSettings).toHaveBeenCalledWith('c1', {
      llm_model: 'claude-sonnet-5',
      question_effort: 'high',
      grading_effort: 'max',
      exploration_effort: 'low',
    });
  });

  it('puts a cleared select (null) or an empty string back to the default', async () => {
    await save({ question_effort: null, grading_effort: '' });
    expect(mocks.updateSettings).toHaveBeenCalledWith('c1', {
      question_effort: null,
      grading_effort: null,
    });
  });

  it.each([['extreme'], ['HIGH'], [' low'], [3], [true], [{ effort: 'low' }]])(
    'refuses %j and writes nothing',
    async value => {
      const result = await save({ question_effort: 'high', grading_effort: value });
      expect(result.error).toBe(
        'Grading effort must be one of low, medium, high, xhigh, max, or empty for the default.'
      );
      expect(mocks.updateSettings).not.toHaveBeenCalled();

      const exploration = await save({ question_effort: 'high', exploration_effort: value });
      expect(exploration.error).toBe(
        'Exploration effort must be one of low, medium, high, or empty for the default.'
      );
      expect(mocks.updateSettings).not.toHaveBeenCalled();
    }
  );

  it('requires a key to set an effort', async () => {
    mocks.getClassroomSettingsForServer.mockResolvedValue({ anthropic_api_key: null });
    const result = await save({ grading_effort: 'high' });
    expect(result.error).toMatch(/requires an API key/);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it('accepts an effort saved together with a new key', async () => {
    mocks.getClassroomSettingsForServer.mockResolvedValue({ anthropic_api_key: null });
    const result = await save({ anthropic_api_key: 'sk-ant-new', grading_effort: 'high' });
    expect(result.error).toBeUndefined();
    expect(mocks.updateSettings).toHaveBeenCalledWith('c1', {
      anthropic_api_key: 'sk-ant-new',
      grading_effort: 'high',
    });
  });

  it('lets a keyless classroom clear an effort', async () => {
    mocks.getClassroomSettingsForServer.mockResolvedValue({ anthropic_api_key: null });
    const result = await save({ question_effort: null });
    expect(result.error).toBeUndefined();
    expect(mocks.updateSettings).toHaveBeenCalledWith('c1', { question_effort: null });
  });
});

describe('clearLLMSettings', () => {
  it('resets the efforts with the models and the key', async () => {
    await post({ _action: 'clearLLMSettings' });
    expect(mocks.updateSettings).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({
        anthropic_api_key: null,
        exploration_model: null,
        question_effort: null,
        grading_effort: null,
        exploration_effort: null,
      })
    );
  });
});
