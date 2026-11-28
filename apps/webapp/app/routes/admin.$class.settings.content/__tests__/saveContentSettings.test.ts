/**
 * The Content tab's switches (Slides, Show Modules, Show Pages) save through
 * `saveContentSettings`. Pinned here: it writes only those three fields, never
 * anything else in the body, and a plan refusal from updateSettings comes back
 * as a readable error rather than a 500. The content repository and the cache
 * reset are pinned too. Each save hands its service the actor that records it;
 * the route writes no row of its own (live editing keeps its own: see
 * liveEditing.test.ts).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requestImpersonator: vi.fn(),
  assertClassroomAccess: vi.fn(),
  updateSettings: vi.fn(),
  bumpContentKeyVersion: vi.fn(),
  addClassroomAuditLog: vi.fn(),
}));

vi.mock('@classmoji/auth/request-impersonator', () => ({
  requestImpersonator: (...a: unknown[]) => mocks.requestImpersonator(...a),
}));

class ClassroomSettingsEntitlementError extends Error {}

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertClassroomMutationAllowed: vi.fn(),
  addClassroomAuditLog: (...a: unknown[]) => mocks.addClassroomAuditLog(...a),
}));

vi.mock('~/utils/collab.server', () => ({
  collabServerEnv: () => null,
  notifyCollabFlag: vi.fn(),
}));

vi.mock('@classmoji/database', () => ({ default: () => ({}) }));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroom: { updateSettings: (...a: unknown[]) => mocks.updateSettings(...a) },
    contentDelivery: {
      bumpContentKeyVersion: (...a: unknown[]) => mocks.bumpContentKeyVersion(...a),
    },
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
  App: Object.assign(() => null, { useApp: () => ({ modal: { confirm: vi.fn() } }) }),
  Button: () => null,
  Form: Object.assign(() => null, { Item: () => null }),
  Switch: () => null,
}));
vi.mock('@tabler/icons-react', () => ({ IconExternalLink: () => null }));
vi.mock('react-router', () => ({ useParams: () => ({ class: 'cs52' }) }));

const { action } = await import('../route.tsx');

const save = (body: Record<string, unknown>, intent = 'saveContentSettings') =>
  action({
    params: { class: 'cs52' },
    request: new Request('http://localhost/admin/cs52/settings/content', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ _action: intent, ...body }),
    }),
  } as never) as Promise<Record<string, unknown>>;

/** The actor the route hands the settings service. */
const ACTOR = {
  userId: 'owner-1',
  role: 'OWNER',
  tool: 'web:settings.content.features',
  impersonatedBy: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requestImpersonator.mockResolvedValue(null);
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
    expect(mocks.updateSettings).toHaveBeenCalledWith('c1', body, ACTOR);
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
    expect(mocks.updateSettings).toHaveBeenCalledWith('c1', { show_pages: false }, ACTOR);
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

describe('saveContentRepo and resetContentCache', () => {
  it('saves the repository name (blank clears it) with its actor', async () => {
    expect(await save({ content_repo_name: 'course-content' }, 'saveContentRepo')).toEqual({
      success: 'Content repository updated',
      action: 'save-content-settings',
    });
    expect(mocks.updateSettings).toHaveBeenLastCalledWith(
      'c1',
      { content_repo_name: 'course-content' },
      { ...ACTOR, tool: 'web:settings.content.repo' }
    );
    await save({ content_repo_name: '' }, 'saveContentRepo');
    expect(mocks.updateSettings).toHaveBeenLastCalledWith(
      'c1',
      { content_repo_name: null },
      { ...ACTOR, tool: 'web:settings.content.repo' }
    );
  });

  it('bumps the content key version with its actor, under View as too', async () => {
    mocks.requestImpersonator.mockResolvedValue('admin-4');
    mocks.bumpContentKeyVersion.mockResolvedValue({
      content_key_version: 5,
      audit: { written: 0, missed: 1 },
    });
    expect(await save({}, 'resetContentCache')).toEqual({
      success: 'Content cache reset',
      content_key_version: 5,
      action: 'reset-content-cache',
    });
    expect(mocks.bumpContentKeyVersion).toHaveBeenCalledExactlyOnceWith('c1', {
      ...ACTOR,
      tool: 'web:settings.content.reset_cache',
      impersonatedBy: 'admin-4',
    });
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });
});
