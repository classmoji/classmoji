/**
 * The "Recent Viewers" switch on General settings: OWNER-gated, and the save
 * writes only `recent_viewers_enabled`, never anything else in the body.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertClassroomMutationAllowed: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassroomSettingsValidationError: class extends Error {},
  ClassmojiService: {
    classroom: { updateSettings: (...a: unknown[]) => mocks.updateSettings(...a) },
  },
}));

vi.mock('~/components', () => ({ SettingSection: () => null }));
vi.mock('~/hooks', () => ({ useGlobalFetcher: () => ({ fetcher: null }) }));

const { action } = await import('../route');

const save = (body: unknown, name = 'saveRecentViewers') =>
  action({
    params: { class: 'cs52' },
    request: new Request(`http://x/admin/cs52/settings/general?/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as never) as Promise<{ success?: string; error?: string; action?: string }>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertClassroomAccess.mockResolvedValue({
    classroom: { id: 'c1', status: 'ACTIVE' },
    membership: { role: 'OWNER' },
  });
  mocks.updateSettings.mockResolvedValue({});
});

describe('saveRecentViewers', () => {
  it('is gated to OWNER', async () => {
    await save({ recent_viewers_enabled: false });
    expect(mocks.assertClassroomAccess).toHaveBeenCalledWith(
      expect.objectContaining({ allowedRoles: ['OWNER'], classroomSlug: 'cs52' })
    );
  });

  it('writes the switch, on and off', async () => {
    const result = await save({ recent_viewers_enabled: false });
    expect(mocks.updateSettings).toHaveBeenCalledWith('c1', { recent_viewers_enabled: false });
    expect(result).toMatchObject({
      success: 'Recent viewers updated',
      action: 'save-recent-viewers',
    });

    await save({ recent_viewers_enabled: true });
    expect(mocks.updateSettings).toHaveBeenLastCalledWith('c1', { recent_viewers_enabled: true });
  });

  it('ignores every other settings field in the body', async () => {
    await save({
      recent_viewers_enabled: true,
      final_grades_released: true,
      show_grades_to_students: true,
      anthropic_api_key: 'sk-x',
    });
    expect(mocks.updateSettings).toHaveBeenCalledWith('c1', { recent_viewers_enabled: true });
  });

  it('no longer answers to the old saveExtensionSettings name', async () => {
    await expect(save({ recent_viewers_enabled: true }, 'saveExtensionSettings')).rejects.toThrow();
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });
});
