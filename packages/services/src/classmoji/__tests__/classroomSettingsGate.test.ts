import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `updateSettings` is the shared write path behind the web settings actions and
 * the MCP classroom_settings_update tool, so the Pro gate on
 * `syllabus_bot_enabled` lives there rather than in each caller.
 *
 * Three properties, all of which have bitten before:
 *   - enabling on a non-Pro classroom is refused, and nothing is written;
 *   - DISABLING is always allowed (the feature predates the gate, so Free
 *     classrooms hold stale `true`s their owners must be able to clear);
 *   - a non-boolean truthy value cannot slip past a strict `=== true`.
 */

const upsertMock = vi.fn();
const canUseSyllabusBotMock = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({ classroomSettings: { upsert: (...a: unknown[]) => upsertMock(...a) } }),
}));

vi.mock('../entitlement.service.ts', () => ({
  canUseSyllabusBot: (...a: unknown[]) => canUseSyllabusBotMock(...a),
}));

vi.mock('../../git/index.ts', () => ({ GitHubProvider: class {} }));

const CLASSROOM_ID = 'classroom-1';

beforeEach(() => {
  vi.clearAllMocks();
  upsertMock.mockResolvedValue({});
});

describe('updateSettings — syllabus bot Pro gate', () => {
  it('refuses to enable it on a classroom without Pro, and writes nothing', async () => {
    canUseSyllabusBotMock.mockResolvedValue({ allowed: false, reason: 'pro_required' });
    const { updateSettings, ClassroomSettingsEntitlementError } =
      await import('../classroom.service.ts');

    await expect(
      updateSettings(CLASSROOM_ID, { syllabus_bot_enabled: true })
    ).rejects.toBeInstanceOf(ClassroomSettingsEntitlementError);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('allows enabling it on a Pro classroom', async () => {
    canUseSyllabusBotMock.mockResolvedValue({ allowed: true });
    const { updateSettings } = await import('../classroom.service.ts');

    await updateSettings(CLASSROOM_ID, { syllabus_bot_enabled: true });

    expect(canUseSyllabusBotMock).toHaveBeenCalledWith(CLASSROOM_ID);
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });

  it('always allows turning it OFF, even with no entitlement', async () => {
    canUseSyllabusBotMock.mockResolvedValue({ allowed: false, reason: 'pro_required' });
    const { updateSettings } = await import('../classroom.service.ts');

    await updateSettings(CLASSROOM_ID, { syllabus_bot_enabled: false });

    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(canUseSyllabusBotMock).not.toHaveBeenCalled();
  });

  it('does not consult entitlement for unrelated settings writes', async () => {
    const { updateSettings } = await import('../classroom.service.ts');

    await updateSettings(CLASSROOM_ID, { theme: 'stone' });

    expect(canUseSyllabusBotMock).not.toHaveBeenCalled();
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a non-boolean truthy value rather than passing it through', async () => {
    canUseSyllabusBotMock.mockResolvedValue({ allowed: false, reason: 'pro_required' });
    const { updateSettings, ClassroomSettingsEntitlementError } =
      await import('../classroom.service.ts');

    await expect(
      // A JSON body can carry the string "true"; a strict === true check would
      // have waved this straight through to Prisma.
      updateSettings(CLASSROOM_ID, { syllabus_bot_enabled: 'true' as unknown as boolean })
    ).rejects.toBeInstanceOf(ClassroomSettingsEntitlementError);
    expect(upsertMock).not.toHaveBeenCalled();
  });
});
