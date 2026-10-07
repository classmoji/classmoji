/**
 * The Content tab's switches (Slides, Show Modules, Show Pages) save through
 * `saveContentSettings`. Pinned here: it writes only those three fields, never
 * anything else in the body, and a plan refusal from updateSettings comes back
 * as a readable error rather than a 500.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  updateSettings: vi.fn(),
}));

class ClassroomSettingsEntitlementError extends Error {}

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertClassroomMutationAllowed: vi.fn(),
  addClassroomAuditLog: vi.fn(),
}));

vi.mock('~/utils/collab.server', () => ({
  collabServerEnv: () => null,
  notifyCollabFlag: vi.fn(),
}));

vi.mock('@classmoji/database', () => ({ default: () => ({}) }));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroom: { updateSettings: (...a: unknown[]) => mocks.updateSettings(...a) },
    contentDelivery: { bumpContentKeyVersion: vi.fn() },
  },
  ClassroomSettingsEntitlementError,
}));

vi.mock('@classmoji/utils', () => ({ getContentRepoName: () => 'content-repo' }));

// The action is what is under test; the view layer only needs to import.
vi.mock('~/constants', async () => ({
  ActionTypes: (
    await vi.importActual<typeof import('~/constants/actionTypes')>('~/constants/actionTypes')
  ).ActionTypes,
}));
vi.mock('~/components', () => ({ SettingSection: () => null }));
vi.mock('~/hooks', () => ({ useGlobalFetcher: () => ({ fetcher: { submit: vi.fn() } }) }));
vi.mock('~/hooks/useGitWeb', () => ({ useGitWeb: () => ({}) }));
vi.mock('antd', () => ({
  Button: () => null,
  Form: Object.assign(() => null, { Item: () => null }),
  Modal: { confirm: vi.fn() },
  Switch: () => null,
}));
vi.mock('@tabler/icons-react', () => ({ IconExternalLink: () => null }));
vi.mock('react-router', () => ({ useParams: () => ({ class: 'cs52' }) }));

const { action } = await import('../route.tsx');

const save = (body: Record<string, unknown>) =>
  action({
    params: { class: 'cs52' },
    request: new Request('http://localhost/admin/cs52/settings/content', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ _action: 'saveContentSettings', ...body }),
    }),
  } as never) as Promise<{ success?: string; error?: string; action?: string }>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertClassroomAccess.mockResolvedValue({
    userId: 'owner-1',
    classroom: { id: 'c1', status: 'ACTIVE' },
    membership: { role: 'OWNER' },
  });
  mocks.updateSettings.mockResolvedValue({});
});

describe('saveContentSettings', () => {
  it('is gated to OWNER', async () => {
    await save({ slides_enabled: true });
    expect(mocks.assertClassroomAccess).toHaveBeenCalledWith(
      expect.objectContaining({ allowedRoles: ['OWNER'], classroomSlug: 'cs52' })
    );
  });

  it.each([
    [{ slides_enabled: true }],
    [{ slides_enabled: false }],
    [{ show_modules: false }],
    [{ show_pages: true }],
  ])('writes what the switch sends: %o', async body => {
    const result = await save(body);
    expect(mocks.updateSettings).toHaveBeenCalledWith('c1', body);
    expect(result).toMatchObject({
      success: 'Content settings updated',
      action: 'save-content-settings',
    });
  });

  it('ignores every other settings field in the body, including _action', async () => {
    await save({
      show_pages: false,
      syllabus_bot_effort: 'high',
      syllabus_bot_enabled: true,
      anthropic_api_key: 'sk-x',
      final_grades_released: true,
    });
    expect(mocks.updateSettings).toHaveBeenCalledWith('c1', { show_pages: false });
  });

  it('returns a plan refusal as an error, not a 500', async () => {
    mocks.updateSettings.mockRejectedValue(
      new ClassroomSettingsEntitlementError('Ask Moji requires a Pro subscription.')
    );
    const result = await save({ slides_enabled: true });
    expect(result).toEqual({
      error: 'Ask Moji requires a Pro subscription.',
      action: 'save-content-settings',
    });
  });
});
