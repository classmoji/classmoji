/**
 * AI settings: the owner's Ask Moji instructions, the audit row every save
 * writes, and the Ask Moji switch's availability on the Trigger runtime.
 *
 *   - Instructions are owner-only to read and write (the page's gate), saved
 *     by their own action that writes that one field through updateSettings,
 *     and a refusal is a fixed line by validation code.
 *   - Every save writes one UPDATE row (`web:settings.ai`, `data.fields`),
 *     with the instructions' length and never their text, never a key's
 *     value, and `impersonated_by` while an admin views as the owner. A
 *     refused save writes none.
 *   - With ASK_MOJI_RUNTIME=trigger the switch follows askMojiAvailable.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INSTRUCTIONS_MAX_CHARS } from '@classmoji/utils/ask-moji/limits';
import { ASK_MOJI_AVAILABILITY_COPY } from '@classmoji/utils/ask-moji/copy';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  addClassroomAuditLog: vi.fn(),
  impersonationAuditFields: vi.fn(),
  updateSettings: vi.fn(),
  getClassroomSettingsForServer: vi.fn(),
  canUseSyllabusBot: vi.fn(),
  canUseQuizzes: vi.fn(),
  getAllModels: vi.fn(),
  askMojiRuntimeIsTrigger: vi.fn(),
  askMojiAvailable: vi.fn(),
  isAIAgentConfigured: vi.fn(),
  EntitlementError: class ClassroomSettingsEntitlementError extends Error {},
  ValidationError: class ClassroomSettingsValidationError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
  addClassroomAuditLog: (...a: unknown[]) => mocks.addClassroomAuditLog(...a),
}));
vi.mock('~/routes/admin.$class.ask-moji/impersonation.server', () => ({
  impersonationAuditFields: (...a: unknown[]) => mocks.impersonationAuditFields(...a),
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
    askMojiSession: {
      askMojiRuntimeIsTrigger: () => mocks.askMojiRuntimeIsTrigger(),
      askMojiAvailable: (...a: unknown[]) => mocks.askMojiAvailable(...a),
    },
  },
  ClassroomSettingsEntitlementError: mocks.EntitlementError,
  ClassroomSettingsValidationError: mocks.ValidationError,
  getAllModels: (...a: unknown[]) => mocks.getAllModels(...a),
  getModelLabel: (id: string) => `label:${id}`,
}));
vi.mock('~/utils/aiFeatures.server', () => ({
  isAIAgentConfigured: () => mocks.isAIAgentConfigured(),
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

/** The one audit row the last save wrote. */
const auditRow = () => {
  expect(mocks.addClassroomAuditLog).toHaveBeenCalledTimes(1);
  return mocks.addClassroomAuditLog.mock.calls[0][0] as {
    classroomId: string;
    userId: string;
    role: string;
    action: string;
    resourceType: string;
    resourceId: string;
    metadata: Record<string, unknown>;
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertClassroomAccess.mockResolvedValue({
    userId: 'owner-1',
    classroom: { id: 'c1', status: 'ACTIVE' },
    membership: { role: 'OWNER' },
  });
  mocks.impersonationAuditFields.mockResolvedValue({});
  mocks.updateSettings.mockResolvedValue({});
  mocks.getClassroomSettingsForServer.mockResolvedValue({ anthropic_api_key: 'sk-ant-classroom' });
  mocks.canUseSyllabusBot.mockResolvedValue({ allowed: true });
  mocks.canUseQuizzes.mockResolvedValue({ allowed: true });
  mocks.getAllModels.mockResolvedValue({ anthropic: [] });
  mocks.askMojiRuntimeIsTrigger.mockReturnValue(false);
  mocks.askMojiAvailable.mockResolvedValue({ available: true });
  mocks.isAIAgentConfigured.mockReturnValue(true);
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
    expect(mocks.updateSettings).toHaveBeenCalledWith('c1', {
      syllabus_bot_instructions: 'Answer in Spanish.',
    });
  });

  it('passes a clear (null or blank) to the service, which stores null', async () => {
    await saveInstructions(null);
    expect(mocks.updateSettings).toHaveBeenLastCalledWith('c1', {
      syllabus_bot_instructions: null,
    });
    await saveInstructions('   ');
    expect(mocks.updateSettings).toHaveBeenLastCalledWith('c1', {
      syllabus_bot_instructions: '   ',
    });
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

  it('audits the field and the trimmed length, never the text', async () => {
    await saveInstructions('  Answer in Spanish.  ');
    const row = auditRow();
    expect(row).toMatchObject({
      classroomId: 'c1',
      userId: 'owner-1',
      role: 'OWNER',
      action: 'UPDATE',
      resourceType: 'SETTINGS',
      resourceId: 'c1',
    });
    expect(row.metadata).toEqual({
      tool: AI_SETTINGS_AUDIT_TOOL,
      fields: ['syllabus_bot_instructions'],
      instructions_length: 'Answer in Spanish.'.length,
    });
    expect(JSON.stringify(row)).not.toContain('Spanish');
  });

  it('audits a clear as length 0', async () => {
    await saveInstructions(null);
    expect(auditRow().metadata.instructions_length).toBe(0);
  });

  it('records the admin behind a View As session', async () => {
    mocks.impersonationAuditFields.mockResolvedValue({ impersonated_by: 'admin-9' });
    await saveInstructions('Be brief.');
    expect(auditRow().metadata).toMatchObject({ impersonated_by: 'admin-9' });
  });
});

describe('every AI settings save is audited', () => {
  it.each([
    [{ _action: 'saveQuizSettings', quizzes_enabled: true }, ['quizzes_enabled']],
    [{ _action: 'saveAskMojiSettings', syllabus_bot_enabled: false }, ['syllabus_bot_enabled']],
    [
      {
        _action: 'saveLLMSettings',
        anthropic_api_key: 'sk-ant-new-secret',
        llm_model: 'claude-opus-5-5',
        syllabus_bot_effort: null,
      },
      ['llm_model', 'syllabus_bot_effort', 'anthropic_api_key'],
    ],
  ])('%o writes one row naming its fields', async (body, fields) => {
    await post(body);
    const row = auditRow();
    expect(row.metadata).toEqual({ tool: AI_SETTINGS_AUDIT_TOOL, fields });
    expect(row.action).toBe('UPDATE');
    expect(JSON.stringify(row)).not.toContain('sk-ant-new-secret');
  });

  it('audits Clear all AI settings with every field it cleared', async () => {
    await post({ _action: 'clearLLMSettings' });
    const fields = auditRow().metadata.fields as string[];
    expect(fields).toEqual(
      expect.arrayContaining(['anthropic_api_key', 'llm_model', 'syllabus_bot_model'])
    );
    expect(fields).not.toContain('syllabus_bot_instructions');
  });

  it('writes no row for a refused save', async () => {
    const result = await post({ _action: 'saveLLMSettings', llm_model: 'claude-haiku-4-5' });
    expect(result.error).toBeDefined();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('writes no row when the Pro gate refuses turning Ask Moji on', async () => {
    mocks.updateSettings.mockRejectedValue(new mocks.EntitlementError('Pro'));
    await post({ _action: 'saveAskMojiSettings', syllabus_bot_enabled: true });
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });
});

describe('loader: Ask Moji switch availability', () => {
  it('follows the AI agent on the AI agent runtime, without asking askMojiAvailable', async () => {
    mocks.isAIAgentConfigured.mockReturnValue(false);
    const data = await load();
    expect(data.askMojiToggleAvailable).toBe(false);
    expect(data.askMojiUnavailableLine).toBeNull();
    expect(mocks.askMojiAvailable).not.toHaveBeenCalled();
  });

  describe('on the Trigger runtime', () => {
    beforeEach(() => mocks.askMojiRuntimeIsTrigger.mockReturnValue(true));

    it('asks askMojiAvailable for the gated classroom, whatever the AI agent says', async () => {
      mocks.isAIAgentConfigured.mockReturnValue(false);
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

    it.each(['RUNTIME_OFF', 'TRIGGER_NOT_CONFIGURED', 'NO_API_KEY'] as const)(
      'disables the switch for %s, with its staff line',
      async reason => {
        mocks.askMojiAvailable.mockResolvedValue({ available: false, reason });
        const data = await load();
        expect(data.askMojiToggleAvailable).toBe(false);
        expect(data.askMojiUnavailableLine).toBe(ASK_MOJI_AVAILABILITY_COPY[reason]);
      }
    );

    it('disables the switch without Pro and leaves the line to the upsell', async () => {
      mocks.askMojiAvailable.mockResolvedValue({ available: false, reason: 'PRO_REQUIRED' });
      const data = await load();
      expect(data.askMojiToggleAvailable).toBe(false);
      expect(data.askMojiUnavailableLine).toBeNull();
    });
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
