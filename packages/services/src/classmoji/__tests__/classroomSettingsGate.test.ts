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

const findUniqueMock = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    classroomSettings: {
      upsert: (...a: unknown[]) => upsertMock(...a),
      findUnique: (...a: unknown[]) => findUniqueMock(...a),
    },
  }),
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

// ── The course time zone ────────────────────────────────────────────────────
//
// classroom_settings.timezone is THE zone for every server-side date: the
// public schedule, Ask Moji and the MCP `_local` fields. Validated here, in the
// shared write path, against the runtime's own Intl data (not a list), and
// stored in Intl's canonical spelling so the Settings select can show it.
describe('updateSettings — time zone', () => {
  const written = () => (upsertMock.mock.calls[0][0] as { update: Record<string, unknown> }).update;

  it('stores a valid IANA zone', async () => {
    const { updateSettings } = await import('../classroom.service.ts');
    await updateSettings(CLASSROOM_ID, { timezone: 'America/New_York' });
    expect(written()).toEqual({ timezone: 'America/New_York' });
  });

  it("stores the canonical spelling, not the caller's", async () => {
    const { updateSettings } = await import('../classroom.service.ts');
    await updateSettings(CLASSROOM_ID, { timezone: 'america/new_york' });
    expect(written()).toEqual({ timezone: 'America/New_York' });
  });

  it('accepts UTC, which Intl.supportedValuesOf omits', async () => {
    const { updateSettings } = await import('../classroom.service.ts');
    await updateSettings(CLASSROOM_ID, { timezone: 'UTC' });
    expect(written()).toEqual({ timezone: 'UTC' });
  });

  it.each([
    ['a zone that does not exist', 'Not/AZone'],
    ['a display name rather than a zone', 'Eastern Time'],
    ['a near-miss the DB CHECK would also refuse', 'America/New York'],
  ])('refuses %s before writing', async (_case, zone) => {
    const { updateSettings, ClassroomSettingsValidationError } =
      await import('../classroom.service.ts');
    const error = await updateSettings(CLASSROOM_ID, { timezone: zone }).catch(e => e);
    expect(error).toBeInstanceOf(ClassroomSettingsValidationError);
    expect(error.code).toBe('TIMEZONE_INVALID');
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('clears the zone on null or a blank string', async () => {
    const { updateSettings } = await import('../classroom.service.ts');
    await updateSettings(CLASSROOM_ID, { timezone: null });
    await updateSettings(CLASSROOM_ID, { timezone: '   ' });
    expect((upsertMock.mock.calls[0][0] as { update: unknown }).update).toEqual({ timezone: null });
    expect((upsertMock.mock.calls[1][0] as { update: unknown }).update).toEqual({ timezone: null });
  });

  it('leaves the zone alone when the patch omits it', async () => {
    const { updateSettings } = await import('../classroom.service.ts');
    await updateSettings(CLASSROOM_ID, { theme: 'stone' });
    expect(written()).toEqual({ theme: 'stone' });
  });
});

describe('getTimeZone', () => {
  it("reads the classroom's own setting, and null when there is none", async () => {
    const { getTimeZone } = await import('../classroom.service.ts');
    findUniqueMock.mockResolvedValueOnce({ timezone: 'America/New_York' });
    expect(await getTimeZone(CLASSROOM_ID)).toBe('America/New_York');
    findUniqueMock.mockResolvedValueOnce(null);
    expect(await getTimeZone(CLASSROOM_ID)).toBeNull();
  });
});
