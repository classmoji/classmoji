/**
 * Reasoning effort on AI settings (question_effort, grading_effort,
 * exploration_effort, syllabus_bot_effort). The ai-agent passes the stored
 * value to the model, so the action is the gate: it stores only a level the
 * field offers (exploration stops at high) or null, refuses anything else,
 * requires the classroom's own key to set one (the disabled Selects are not the
 * gate), and Clear all AI settings resets them.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  updateSettings: vi.fn(),
  getClassroomSettingsForServer: vi.fn(),
  canUseSyllabusBot: vi.fn(),
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
    entitlement: { canUseSyllabusBot: (...a: unknown[]) => mocks.canUseSyllabusBot(...a) },
  },
  ClassroomSettingsEntitlementError: mocks.EntitlementError,
  getAllModels: (...a: unknown[]) => mocks.getAllModels(...a),
  getModelLabel: (id: string) => `label:${id}`,
}));

vi.mock('~/utils/aiFeatures.server', () => ({ isAIAgentConfigured: () => true }));
vi.mock('~/components', () => ({ SettingSection: () => null }));
vi.mock('~/hooks', () => ({ useGlobalFetcher: () => ({ fetcher: null }) }));

const { action, loader } = await import('../route');

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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertClassroomAccess.mockResolvedValue({
    classroom: { id: 'c1', status: 'ACTIVE' },
    membership: { role: 'OWNER' },
  });
  mocks.updateSettings.mockResolvedValue({});
  mocks.getClassroomSettingsForServer.mockResolvedValue({ anthropic_api_key: 'sk-ant-classroom' });
  mocks.canUseSyllabusBot.mockResolvedValue({ allowed: true });
  mocks.getAllModels.mockResolvedValue({ anthropic: [] });
});

describe('saveLLMSettings: effort', () => {
  it.each([['question_effort'], ['grading_effort'], ['syllabus_bot_effort']])(
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
    expect(result.error).toBe('Choosing a model or effort requires a classroom API key.');
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

describe('saveLLMSettings: Ask Moji', () => {
  it('stores its model and effort alongside the quiz fields', async () => {
    const result = await save({
      syllabus_bot_model: 'claude-sonnet-5',
      syllabus_bot_effort: 'max',
    });
    expect(result.error).toBeUndefined();
    expect(mocks.updateSettings).toHaveBeenCalledWith('c1', {
      syllabus_bot_model: 'claude-sonnet-5',
      syllabus_bot_effort: 'max',
    });
  });

  it('puts a cleared model or effort back to the default', async () => {
    await save({ syllabus_bot_model: '', syllabus_bot_effort: null });
    expect(mocks.updateSettings).toHaveBeenCalledWith('c1', {
      syllabus_bot_model: null,
      syllabus_bot_effort: null,
    });
  });

  it('refuses an effort that is not a level and writes nothing', async () => {
    const result = await save({ syllabus_bot_effort: 'extreme' });
    expect(result.error).toBe(
      'Ask Moji effort must be one of low, medium, high, xhigh, max, or empty for the default.'
    );
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it.each([[{ syllabus_bot_model: 'claude-sonnet-5' }], [{ syllabus_bot_effort: 'low' }]])(
    'requires a key to set %j',
    async fields => {
      mocks.getClassroomSettingsForServer.mockResolvedValue({ anthropic_api_key: null });
      const result = await save(fields);
      expect(result.error).toBe('Choosing a model or effort requires a classroom API key.');
      expect(mocks.updateSettings).not.toHaveBeenCalled();
    }
  );

  // What the keyless form sends (buildLLMSettingsPayload): the key alone. The
  // stored choices are not in the request, so they are not touched.
  it('leaves stored choices alone when only a key is sent', async () => {
    mocks.getClassroomSettingsForServer.mockResolvedValue({
      anthropic_api_key: null,
      llm_model: 'claude-opus-5-5',
      syllabus_bot_effort: 'high',
    });
    const result = await post({ _action: 'saveLLMSettings', anthropic_api_key: 'sk-ant-new' });
    expect(result.error).toBeUndefined();
    expect(mocks.updateSettings).toHaveBeenCalledWith('c1', { anthropic_api_key: 'sk-ant-new' });
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
        syllabus_bot_model: null,
        syllabus_bot_effort: null,
      })
    );
  });

  it('leaves the Enable switches as they are', async () => {
    await post({ _action: 'clearLLMSettings' });
    const [, update] = mocks.updateSettings.mock.calls[0];
    expect(update).not.toHaveProperty('syllabus_bot_enabled');
    expect(update).not.toHaveProperty('quizzes_enabled');
  });
});

describe('saveAskMojiSettings', () => {
  it('writes only syllabus_bot_enabled', async () => {
    const result = await post({
      _action: 'saveAskMojiSettings',
      syllabus_bot_enabled: true,
      llm_model: 'claude-opus-5-5',
    });
    expect(result.success).toBeDefined();
    expect(mocks.updateSettings).toHaveBeenCalledWith('c1', { syllabus_bot_enabled: true });
  });

  it("turns updateSettings' Pro refusal into a readable error", async () => {
    mocks.updateSettings.mockRejectedValue(
      new mocks.EntitlementError('Ask Moji requires a Pro subscription.')
    );
    const result = await post({ _action: 'saveAskMojiSettings', syllabus_bot_enabled: true });
    expect(result.error).toBe('Ask Moji requires a Pro subscription.');
  });

  it('rethrows anything else', async () => {
    mocks.updateSettings.mockRejectedValue(new Error('db down'));
    await expect(
      post({ _action: 'saveAskMojiSettings', syllabus_bot_enabled: false })
    ).rejects.toThrow('db down');
  });
});

describe('loader', () => {
  const load = () =>
    loader({
      params: { class: 'cs52' },
      request: new Request('http://x/admin/cs52/settings/ai'),
    } as never);

  const STORED = {
    llm_model: 'claude-opus-5-5',
    code_aware_model: 'claude-opus-5-5',
    exploration_model: 'claude-haiku-4-5-20251001',
    syllabus_bot_model: 'claude-sonnet-5',
    question_effort: 'high',
    grading_effort: 'max',
    exploration_effort: 'medium',
    syllabus_bot_effort: 'xhigh',
  };

  // Without a key every AI call runs on the platform defaults, so the selects
  // show those, not a stored value that is not used.
  it('shows no stored model or effort for a keyless classroom', async () => {
    mocks.getClassroomSettingsForServer.mockResolvedValue({ ...STORED, anthropic_api_key: null });
    const data = await load();
    expect(Object.values(data.selectValues).every(value => value === null)).toBe(true);
    expect(Object.keys(data.selectValues).sort()).toEqual(Object.keys(STORED).sort());
  });

  it('shows the stored values once the classroom has a key', async () => {
    mocks.getClassroomSettingsForServer.mockResolvedValue({
      ...STORED,
      anthropic_api_key: 'sk-ant-classroom',
    });
    const data = await load();
    expect(data.selectValues).toEqual(STORED);
  });

  // The page reads selectValues, but organization.settings goes to the client
  // too; a keyless classroom's stored choices must not ride along in it.
  it('sends no stored model or effort in the settings of a keyless classroom', async () => {
    mocks.getClassroomSettingsForServer.mockResolvedValue({
      ...STORED,
      anthropic_api_key: null,
      quizzes_enabled: true,
    });
    const data = await load();
    const settings = data.organization.settings as Record<string, unknown>;
    for (const field of Object.keys(STORED)) {
      expect(settings[field], field).toBeNull();
    }
    expect(settings.quizzes_enabled).toBe(true);
    expect(settings.has_anthropic_key).toBe(false);
  });

  it('sends the stored model and effort in the settings once the classroom has a key', async () => {
    mocks.getClassroomSettingsForServer.mockResolvedValue({
      ...STORED,
      anthropic_api_key: 'sk-ant-classroom',
    });
    const data = await load();
    expect(data.organization.settings).toMatchObject(STORED);
  });

  it('never sends the key to the client', async () => {
    mocks.getClassroomSettingsForServer.mockResolvedValue({
      anthropic_api_key: 'sk-ant-classroom',
    });
    const data = await load();
    expect(JSON.stringify(data)).not.toContain('sk-ant-classroom');
    expect(data.organization.settings?.has_anthropic_key).toBe(true);
  });

  it('labels each select with the platform default', async () => {
    vi.stubEnv('LLM_MODEL', 'claude-opus-5-5');
    vi.stubEnv('EXPLORATION_MODEL', '');
    vi.stubEnv('SYLLABUS_BOT_MODEL', '');
    vi.stubEnv('QUIZ_QUESTION_EFFORT', '');
    vi.stubEnv('QUIZ_GRADING_EFFORT', 'max');
    vi.stubEnv('EXPLORATION_EFFORT', '');
    vi.stubEnv('SYLLABUS_BOT_EFFORT', '');
    try {
      const data = await load();
      expect(data.defaultLabels).toEqual({
        llm_model: 'label:claude-opus-5-5',
        code_aware_model: 'label:claude-opus-5-5',
        exploration_model: 'label:claude-sonnet-5',
        syllabus_bot_model: 'label:claude-opus-5-5',
        question_effort: 'Medium',
        grading_effort: 'Max',
        exploration_effort: 'Low',
        syllabus_bot_effort: 'Low',
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reports whether Ask Moji needs Pro', async () => {
    mocks.canUseSyllabusBot.mockResolvedValue({ allowed: false, reason: 'pro_required' });
    expect((await load()).askMojiProRequired).toBe(true);
  });
});
