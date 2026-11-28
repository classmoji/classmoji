/**
 * AI settings: the owner's Ask Moji instructions, who every save is recorded
 * for, and the Ask Moji switch's availability.
 *
 *   - Instructions are owner-only to read and write (the page's gate), saved
 *     by their own action that writes that one field through updateSettings,
 *     and a refusal is a fixed line by validation code.
 *   - Every save hands updateSettings the actor (`web:settings.ai`, the owner,
 *     the admin viewing as them); the service writes the one UPDATE row (its
 *     shape, with the instructions' length and never their text or a key's
 *     value, is pinned in packages/services settingsAudit.integration.test.ts).
 *     The route writes no row of its own, and a refused save reaches no write.
 *   - The switch follows askMojiAvailable.
 *   - Without Trigger neither AI feature runs: one banner, no section line.
 *   - Every save is its own row.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INSTRUCTIONS_MAX_CHARS } from '@classmoji/utils/ask-moji/limits';
import { ASK_MOJI_AVAILABILITY_COPY } from '@classmoji/utils/ask-moji/copy';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  addClassroomAuditLog: vi.fn(),
  updateSettings: vi.fn(),
  getClassroomSettingsForServer: vi.fn(),
  canUseSyllabusBot: vi.fn(),
  canUseQuizzes: vi.fn(),
  getAllModels: vi.fn(),
  askMojiAvailable: vi.fn(),
  isQuizRuntimeConfigured: vi.fn(),
  requestImpersonator: vi.fn(),
  EntitlementError: class ClassroomSettingsEntitlementError extends Error {},
  ValidationError: class ClassroomSettingsValidationError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

vi.mock('@classmoji/auth/request-impersonator', () => ({
  requestImpersonator: (...a: unknown[]) => mocks.requestImpersonator(...a),
}));
vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
  addClassroomAuditLog: (...a: unknown[]) => mocks.addClassroomAuditLog(...a),
}));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroom: {
      updateSettings: (...a: unknown[]) => mocks.updateSettings(...a),
      getClassroomSettingsForServer: (...a: unknown[]) => mocks.getClassroomSettingsForServer(...a),
    },
    entitlement: {
      isQuizRuntimeConfigured: () => mocks.isQuizRuntimeConfigured(),
      canUseSyllabusBot: (...a: unknown[]) => mocks.canUseSyllabusBot(...a),
      canUseQuizzes: (...a: unknown[]) => mocks.canUseQuizzes(...a),
    },
    askMojiSession: {
      askMojiAvailable: (...a: unknown[]) => mocks.askMojiAvailable(...a),
    },
  },
  ClassroomSettingsEntitlementError: mocks.EntitlementError,
  ClassroomSettingsValidationError: mocks.ValidationError,
  getAllModels: (...a: unknown[]) => mocks.getAllModels(...a),
  getModelLabel: (id: string) => `label:${id}`,
}));
vi.mock('~/components', () => ({ SettingSection: () => null }));
vi.mock('~/hooks', () => ({ useGlobalFetcher: () => ({ fetcher: null }) }));

const { action, loader } = await import('../route');
const { AI_SETTINGS_AUDIT_TOOL, INSTRUCTIONS_ERROR_COPY } = await import('../aiSettingsCopy');

const post = (body: unknown) =>
  action({
    params: { class: 'cs52' },
    request: new Request('http://x/admin/cs52/settings/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as never) as Promise<{ success?: string; error?: string }>;

const load = () =>
  loader({
    params: { class: 'cs52' },
    request: new Request('http://x/admin/cs52/settings/ai'),
  } as never);

const saveInstructions = (value: unknown) =>
  post({ _action: 'saveAskMojiInstructions', syllabus_bot_instructions: value });

/** The actor every AI settings save hands the settings service. */
const ACTOR = {
  userId: 'owner-1',
  role: 'OWNER',
  tool: 'web:settings.ai',
  impersonatedBy: null as string | null,
};

/** The one save the last action made: its fields and its actor. */
const savedWith = () => {
  expect(mocks.updateSettings).toHaveBeenCalledTimes(1);
  const [classroomId, fields, actor] = mocks.updateSettings.mock.calls[0];
  return { classroomId, fields: fields as Record<string, unknown>, actor };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertClassroomAccess.mockResolvedValue({
    userId: 'owner-1',
    classroom: { id: 'c1', status: 'ACTIVE' },
    membership: { role: 'OWNER' },
  });
  mocks.updateSettings.mockResolvedValue({ settings: {}, audit: { written: 1, missed: 0 } });
  mocks.requestImpersonator.mockResolvedValue(null);
  mocks.getClassroomSettingsForServer.mockResolvedValue({ anthropic_api_key: 'sk-ant-classroom' });
  mocks.canUseSyllabusBot.mockResolvedValue({ allowed: true });
  mocks.canUseQuizzes.mockResolvedValue({ allowed: true });
  mocks.getAllModels.mockResolvedValue({ anthropic: [] });
  mocks.askMojiAvailable.mockResolvedValue({ available: true });
  mocks.isQuizRuntimeConfigured.mockReturnValue(true);
});

describe('saveAskMojiInstructions', () => {
  it('is gated to the OWNER of the classroom, and to the mutation rule', async () => {
    await saveInstructions('Be brief.');
    expect(mocks.assertClassroomAccess).toHaveBeenCalledWith(
      expect.objectContaining({ classroomSlug: 'cs52', allowedRoles: ['OWNER'] })
    );
    expect(mocks.assertClassroomMutationAllowed).toHaveBeenCalledWith({
      status: 'ACTIVE',
      role: 'OWNER',
    });
  });

  it('refuses a teacher (the gate throws) and writes and audits nothing', async () => {
    mocks.assertClassroomAccess.mockRejectedValue(new Response('Forbidden', { status: 403 }));
    await expect(saveInstructions('Be brief.')).rejects.toBeInstanceOf(Response);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('writes only the instructions, into the gated classroom', async () => {
    const result = await saveInstructions('Answer in Spanish.');
    expect(result.success).toBe('Ask Moji instructions saved');
    expect(mocks.updateSettings).toHaveBeenCalledWith(
      'c1',
      { syllabus_bot_instructions: 'Answer in Spanish.' },
      ACTOR
    );
  });

  it('passes a clear (null or blank) to the service, which stores null', async () => {
    await saveInstructions(null);
    expect(mocks.updateSettings).toHaveBeenLastCalledWith(
      'c1',
      { syllabus_bot_instructions: null },
      ACTOR
    );
    await saveInstructions('   ');
    expect(mocks.updateSettings).toHaveBeenLastCalledWith(
      'c1',
      { syllabus_bot_instructions: '   ' },
      ACTOR
    );
  });

  it('refuses a value that is not text without writing', async () => {
    const result = await saveInstructions(42);
    expect(result.error).toBe(INSTRUCTIONS_ERROR_COPY.INSTRUCTIONS_INVALID);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it.each([
    ['INSTRUCTIONS_TOO_LONG', `Ask Moji instructions can be at most 4,000 characters.`],
    ['INSTRUCTIONS_INVALID', 'Ask Moji instructions must be text.'],
  ])(
    'shows the fixed line for %s, not the service message, and audits nothing',
    async (code, line) => {
      mocks.updateSettings.mockRejectedValue(new mocks.ValidationError(code, 'service wording'));
      const result = await saveInstructions('x'.repeat(INSTRUCTIONS_MAX_CHARS + 1));
      expect(result.error).toBe(line);
      expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
    }
  );

  it('rethrows any other failure', async () => {
    mocks.updateSettings.mockRejectedValue(new Error('db down'));
    await expect(saveInstructions('Be brief.')).rejects.toThrow('db down');
  });

  it('leaves the row to the service: the actor goes in, no row comes from the route', async () => {
    await saveInstructions('  Answer in Spanish.  ');
    expect(savedWith().actor).toEqual(ACTOR);
    expect(ACTOR.tool).toBe(AI_SETTINGS_AUDIT_TOOL);
    expect(JSON.stringify(savedWith().actor)).not.toContain('Spanish');
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('names the admin viewing as the owner, from the request session', async () => {
    mocks.requestImpersonator.mockResolvedValue('admin-5');
    await saveInstructions('Be brief.');
    expect(mocks.requestImpersonator.mock.calls[0][0]).toBeInstanceOf(Request);
    expect(savedWith().actor).toEqual({ ...ACTOR, impersonatedBy: 'admin-5' });
  });

  it('answers the same when the service could not write its row', async () => {
    mocks.updateSettings.mockResolvedValue({ settings: {}, audit: { written: 0, missed: 1 } });
    expect(await saveInstructions('Be brief.')).toEqual({
      success: 'Ask Moji instructions saved',
      action: 'save-quiz-settings',
    });
  });
});

describe('every AI settings save is recorded for its actor', () => {
  it.each([
    [
      'saveQuizSettings',
      { _action: 'saveQuizSettings', quizzes_enabled: true },
      ['quizzes_enabled'],
    ],
    [
      'saveAskMojiSettings',
      { _action: 'saveAskMojiSettings', syllabus_bot_enabled: false },
      ['syllabus_bot_enabled'],
    ],
    [
      'saveLLMSettings (key, model, effort)',
      {
        _action: 'saveLLMSettings',
        anthropic_api_key: 'sk-ant-new-secret',
        llm_model: 'claude-opus-5-5',
        syllabus_bot_effort: null,
      },
      ['llm_model', 'syllabus_bot_effort', 'anthropic_api_key'],
    ],
  ])('%s is one save of its fields, with the actor', async (_label, body, fields) => {
    await post(body);
    const saved = savedWith();
    expect(saved.classroomId).toBe('c1');
    expect(Object.keys(saved.fields)).toEqual(fields);
    expect(saved.actor).toEqual(ACTOR);
    expect(JSON.stringify(saved.actor)).not.toContain('sk-ant-new-secret');
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('Clear all AI settings is one save of every field it clears, with the actor', async () => {
    await post({ _action: 'clearLLMSettings' });
    const saved = savedWith();
    expect(Object.keys(saved.fields)).toEqual(
      expect.arrayContaining(['anthropic_api_key', 'llm_model', 'syllabus_bot_model'])
    );
    expect(saved.fields).not.toHaveProperty('syllabus_bot_instructions');
    expect(saved.actor).toEqual(ACTOR);
  });

  it('a refused save reaches no write and no row', async () => {
    const result = await post({ _action: 'saveLLMSettings', llm_model: 'claude-haiku-4-5' });
    expect(result.error).toBeDefined();
    expect(mocks.updateSettings).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it.each([
    ['saveLLMSettings with no fields', { _action: 'saveLLMSettings' }],
    ['saveLLMSettings with a blank key', { _action: 'saveLLMSettings', anthropic_api_key: '   ' }],
    [
      'saveLLMSettings with an empty key and fields it ignores',
      {
        _action: 'saveLLMSettings',
        anthropic_api_key: '',
        llm_temperature: 0.2,
        llm_max_tokens: 9,
      },
    ],
  ])('%s changes nothing, so it neither writes nor audits', async (_label, body) => {
    const result = await post(body);
    expect(result.success).toBe('AI settings saved');
    expect(mocks.updateSettings).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('writes no row when the Pro gate refuses turning Ask Moji on', async () => {
    mocks.updateSettings.mockRejectedValue(new mocks.EntitlementError('Pro'));
    await post({ _action: 'saveAskMojiSettings', syllabus_bot_enabled: true });
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });
});

describe('loader: Ask Moji switch availability', () => {
  it('asks askMojiAvailable for the gated classroom', async () => {
    const data = await load();
    expect(mocks.askMojiAvailable).toHaveBeenCalledWith({ classroomId: 'c1' });
    expect(data.askMojiToggleAvailable).toBe(true);
    expect(data.askMojiUnavailableLine).toBeNull();
  });

  it('keeps the switch usable when Ask Moji is only switched off', async () => {
    mocks.askMojiAvailable.mockResolvedValue({ available: false, reason: 'NOT_ENABLED' });
    const data = await load();
    expect(data.askMojiToggleAvailable).toBe(true);
    expect(data.askMojiUnavailableLine).toBeNull();
  });

  it('disables the switch without an Anthropic key, with its staff line', async () => {
    mocks.askMojiAvailable.mockResolvedValue({ available: false, reason: 'NO_API_KEY' });
    const data = await load();
    expect(data.askMojiToggleAvailable).toBe(false);
    expect(data.askMojiUnavailableLine).toBe(ASK_MOJI_AVAILABILITY_COPY.NO_API_KEY);
  });

  it('disables the switch without Pro and leaves the line to the upsell', async () => {
    mocks.askMojiAvailable.mockResolvedValue({ available: false, reason: 'PRO_REQUIRED' });
    const data = await load();
    expect(data.askMojiToggleAvailable).toBe(false);
    expect(data.askMojiUnavailableLine).toBeNull();
  });
});

describe('loader: what this server can run', () => {
  it('shows no banner when Trigger is configured', async () => {
    const data = await load();
    expect(data.aiUnavailable).toBe(false);
  });

  it('shows the one banner, and no Ask Moji line, without Trigger', async () => {
    mocks.isQuizRuntimeConfigured.mockReturnValue(false);
    mocks.askMojiAvailable.mockResolvedValue({
      available: false,
      reason: 'TRIGGER_NOT_CONFIGURED',
    });
    const data = await load();
    expect(data.aiUnavailable).toBe(true);
    expect(data.askMojiToggleAvailable).toBe(false);
    expect(data.askMojiUnavailableLine).toBeNull();
  });
});

describe('loader: the instructions', () => {
  it('reaches the owner page only through the OWNER gate', async () => {
    mocks.getClassroomSettingsForServer.mockResolvedValue({
      anthropic_api_key: null,
      syllabus_bot_instructions: 'Owner text',
    });
    const data = await load();
    expect(mocks.assertClassroomAccess).toHaveBeenCalledWith(
      expect.objectContaining({ allowedRoles: ['OWNER'] })
    );
    expect(data.settings.syllabus_bot_instructions).toBe('Owner text');
  });

  it('is never read by a refused caller', async () => {
    mocks.assertClassroomAccess.mockRejectedValue(new Response('Forbidden', { status: 403 }));
    await expect(load()).rejects.toBeInstanceOf(Response);
    expect(mocks.getClassroomSettingsForServer).not.toHaveBeenCalled();
  });
});
