/**
 * General settings: every save goes through the settings service with the
 * actor of its intent (the gate's owner, the tool naming the intent, and the
 * admin viewing as the owner), and the route writes no audit row of its own:
 * the service records the save. What each intent answers is unchanged,
 * whether the service wrote its row or missed it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  updateSettings: vi.fn(),
  updateClassroomSettings: vi.fn(),
  requestImpersonator: vi.fn(),
  addClassroomAuditLog: vi.fn(),
}));

vi.mock('@classmoji/auth/request-impersonator', () => ({
  requestImpersonator: (...a: unknown[]) => mocks.requestImpersonator(...a),
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertClassroomMutationAllowed: vi.fn(),
  addClassroomAuditLog: (...a: unknown[]) => mocks.addClassroomAuditLog(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassroomSettingsValidationError: class extends Error {},
  ClassmojiService: {
    classroom: {
      updateSettings: (...a: unknown[]) => mocks.updateSettings(...a),
      updateClassroomSettings: (...a: unknown[]) => mocks.updateClassroomSettings(...a),
    },
  },
}));

vi.mock('~/components', () => ({ SettingSection: () => null }));
vi.mock('~/hooks', () => ({ useGlobalFetcher: () => ({ fetcher: null }) }));

const { action } = await import('../route');

const save = (name: string, body: unknown) =>
  action({
    params: { class: 'cs52' },
    request: new Request(`http://x/admin/cs52/settings/general?/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as never) as Promise<Record<string, unknown>>;

const actor = (tool: string, impersonatedBy: string | null = null) => ({
  userId: 'owner-1',
  role: 'OWNER',
  tool,
  impersonatedBy,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertClassroomAccess.mockResolvedValue({
    userId: 'owner-1',
    classroom: { id: 'c1', status: 'ACTIVE' },
    membership: { role: 'OWNER' },
  });
  mocks.requestImpersonator.mockResolvedValue(null);
  mocks.updateSettings.mockResolvedValue({ settings: {}, audit: { written: 1, missed: 0 } });
  mocks.updateClassroomSettings.mockResolvedValue({
    settings: null,
    classroom: {},
    audit: { written: 1, missed: 0 },
  });
});

describe('general settings: the service records each save', () => {
  it('saveProfile passes the name alone, with its actor', async () => {
    const result = await save('saveProfile', { name: 'CS 52', slug: 'other', git_org_id: 'x' });
    expect(mocks.updateClassroomSettings).toHaveBeenCalledExactlyOnceWith(
      'c1',
      { classroom: { name: 'CS 52' } },
      actor('web:settings.general.profile')
    );
    expect(result).toEqual({ success: 'Classroom profile updated', action: 'save-profile' });
  });

  it('saveDefaultPage passes the page, with its actor', async () => {
    const result = await save('saveDefaultPage', { default_student_page: 'dashboard' });
    expect(mocks.updateSettings).toHaveBeenCalledExactlyOnceWith(
      'c1',
      { default_student_page: 'dashboard' },
      actor('web:settings.general.default_page')
    );
    expect(result).toEqual({ success: 'Default page updated', action: 'save-default-page' });
  });

  it('passes the admin viewing as the owner', async () => {
    mocks.requestImpersonator.mockResolvedValue('admin-7');
    await save('saveTimeZone', { timezone: 'UTC' });
    expect(mocks.updateSettings).toHaveBeenCalledWith(
      'c1',
      { timezone: 'UTC' },
      actor('web:settings.general.time_zone', 'admin-7')
    );
  });

  it('answers the same when the service could not write its row, and writes none itself', async () => {
    mocks.updateSettings.mockResolvedValue({ settings: {}, audit: { written: 0, missed: 1 } });
    mocks.updateClassroomSettings.mockResolvedValue({
      settings: null,
      classroom: {},
      audit: { written: 0, missed: 1 },
    });
    expect(await save('saveRecentViewers', { recent_viewers_enabled: false })).toEqual({
      success: 'Recent viewers updated',
      action: 'save-recent-viewers',
    });
    expect(await save('saveProfile', { name: 'CS 52' })).toEqual({
      success: 'Classroom profile updated',
      action: 'save-profile',
    });
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('an empty profile save reaches no service', async () => {
    expect(await save('saveProfile', { slug: 'x' })).toEqual({ error: 'Nothing to update' });
    expect(mocks.updateClassroomSettings).not.toHaveBeenCalled();
  });
});
