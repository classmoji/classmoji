/**
 * The course time zone on General settings: the save action and the picker's
 * options. The zone is validated in classroom.updateSettings (tested in
 * packages/services); what is pinned here is that the action is OWNER-gated,
 * reads ONLY `timezone` from the body, and turns a refused zone into a
 * user-facing error rather than a 500.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { matchOfferedZone, timeZoneOptions } from '../timeZoneOptions';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  updateSettings: vi.fn(),
}));

class ClassroomSettingsValidationError extends Error {
  code = 'TIMEZONE_INVALID';
}

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertClassroomMutationAllowed: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassroomSettingsValidationError,
  ClassmojiService: {
    classroom: { updateSettings: (...a: unknown[]) => mocks.updateSettings(...a) },
  },
}));

vi.mock('~/components', () => ({ SettingSection: () => null }));
vi.mock('~/hooks', () => ({ useGlobalFetcher: () => ({ fetcher: null }) }));

const { action } = await import('../route');

const save = (body: unknown) =>
  action({
    params: { class: 'cs52' },
    request: new Request('http://x/admin/cs52/settings/general?/saveTimeZone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as never) as Promise<{ success?: string; error?: string }>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertClassroomAccess.mockResolvedValue({
    classroom: { id: 'c1', status: 'ACTIVE' },
    membership: { role: 'OWNER' },
  });
  mocks.updateSettings.mockResolvedValue({});
});

describe('saveTimeZone', () => {
  it('is gated to OWNER, like every other general setting', async () => {
    await save({ timezone: 'America/New_York' });
    expect(mocks.assertClassroomAccess).toHaveBeenCalledWith(
      expect.objectContaining({ allowedRoles: ['OWNER'], classroomSlug: 'cs52' })
    );
  });

  it('writes only the timezone through the validating service', async () => {
    const result = await save({ timezone: 'America/New_York', anthropic_api_key: 'sk-x' });
    expect(mocks.updateSettings).toHaveBeenCalledWith('c1', { timezone: 'America/New_York' });
    expect(result.success).toBe('Time zone updated');
  });

  it('clears the zone with null', async () => {
    await save({ timezone: null });
    expect(mocks.updateSettings).toHaveBeenCalledWith('c1', { timezone: null });
  });

  it('returns the refusal as an error, not a 500', async () => {
    mocks.updateSettings.mockRejectedValue(
      new ClassroomSettingsValidationError("'Mars/Olympus' is not a time zone we recognize.")
    );
    const result = await save({ timezone: 'Mars/Olympus' });
    expect(result.error).toMatch(/not a time zone/);
  });

  it('refuses a body with no timezone key rather than clearing the zone', async () => {
    const result = await save({ theme: 'stone' });
    expect(result.error).toBe('Nothing to update');
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it('never runs when the caller is not an owner', async () => {
    mocks.assertClassroomAccess.mockRejectedValue(new Response(null, { status: 403 }));
    await expect(save({ timezone: 'UTC' })).rejects.toBeInstanceOf(Response);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });
});

describe('timeZoneOptions', () => {
  it('labels zones readably and keeps the stored IANA value', () => {
    expect(timeZoneOptions(['UTC', 'America/New_York'], null)).toEqual([
      { value: 'UTC', label: 'UTC' },
      { value: 'America/New_York', label: 'America/New York' },
    ]);
  });

  it('carries a stored zone that is not in the list, so the select can show it', () => {
    const values = timeZoneOptions(['UTC'], 'Antarctica/Troll').map(o => o.value);
    expect(values).toEqual(['UTC', 'Antarctica/Troll']);
    expect(timeZoneOptions(['UTC'], 'UTC')).toHaveLength(1);
  });
});

describe('matchOfferedZone', () => {
  it('offers the exact option when the browser zone is listed', () => {
    expect(matchOfferedZone(['UTC', 'America/New_York'], 'America/New_York')).toBe(
      'America/New_York'
    );
  });

  it('matches a browser on the current name to an option listed under the old alias', () => {
    // Browsers report Asia/Kolkata and Europe/Kyiv; this server lists the aliases.
    expect(matchOfferedZone(['UTC', 'Asia/Calcutta', 'Europe/Kiev'], 'Asia/Kolkata')).toBe(
      'Asia/Calcutta'
    );
    expect(matchOfferedZone(['UTC', 'Asia/Calcutta', 'Europe/Kiev'], 'Europe/Kyiv')).toBe(
      'Europe/Kiev'
    );
  });

  it('offers nothing for a missing, unknown or unlisted zone', () => {
    expect(matchOfferedZone(['UTC'], null)).toBeNull();
    expect(matchOfferedZone(['UTC'], 'Mars/Olympus')).toBeNull();
    expect(matchOfferedZone(['UTC'], 'America/New_York')).toBeNull();
  });
});
