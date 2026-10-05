/**
 * The "Live editing" switch (Classroom.collab_enabled) on the Content tab.
 *
 * Pinned here:
 *   - the route gate: OWNER only, and the classroom must be open to writes —
 *     a refusal from either writes nothing and calls nothing;
 *   - the order: the column is written BEFORE the collab server is told;
 *   - an unreachable collab server never blocks the write. Turning off still
 *     succeeds and tells the owner editors will be asked to reload; turning
 *     on succeeds quietly;
 *   - turning on is refused only when no collab server is configured at all;
 *   - an unchanged value is a no-op: no write, no collab call (the flag
 *     endpoint closes every open room), no audit row;
 *   - each change writes one audit row.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  addClassroomAuditLog: vi.fn(),
  classroomUpdate: vi.fn(),
  collabServerEnv: vi.fn(),
  notifyCollabFlag: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
  addClassroomAuditLog: (...a: unknown[]) => mocks.addClassroomAuditLog(...a),
}));

vi.mock('~/utils/collab.server', () => ({
  collabServerEnv: () => mocks.collabServerEnv(),
  notifyCollabFlag: (...a: unknown[]) => mocks.notifyCollabFlag(...a),
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({ classroom: { update: (...a: unknown[]) => mocks.classroomUpdate(...a) } }),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroom: { updateSettings: (...a: unknown[]) => mocks.updateSettings(...a) },
    contentDelivery: { bumpContentKeyVersion: vi.fn() },
  },
  ClassroomSettingsEntitlementError: class extends Error {},
}));

vi.mock('@classmoji/utils', () => ({ getContentRepoName: () => 'content-repo' }));

// The action is what is under test; the view layer only needs to import.
// `~/constants` pulls in the whole nav table (and every icon); only the action
// types are needed.
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
vi.mock('react-router', () => ({ useParams: () => ({ class: 'cs1-26f' }) }));

const route = await import('../route.tsx');
const { setLiveEditing, LIVE_EDITING_COPY, LIVE_EDITING_TOOL } =
  await import('../liveEditing.server.ts');

const CLASS_SLUG = 'cs1-26f';
const ENV = { httpUrl: 'http://collab.test', wsUrl: 'ws://collab.test', secret: 's' };

const gate = (classroom: Record<string, unknown>) =>
  mocks.assertClassroomAccess.mockResolvedValue({
    userId: 'owner-1',
    classroom: { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE', ...classroom },
    membership: { id: 'm-1', role: 'OWNER' },
  });

const actionArgs = (body: Record<string, unknown>) =>
  ({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/admin/${CLASS_SLUG}/settings/content`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  }) as unknown as Parameters<typeof route.action>[0];

const toggle = (enabled: unknown) =>
  route.action(actionArgs({ _action: 'saveLiveEditing', enabled }));

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  gate({ collab_enabled: false });
  mocks.collabServerEnv.mockReturnValue(ENV);
  mocks.notifyCollabFlag.mockResolvedValue({ ok: true });
  mocks.classroomUpdate.mockResolvedValue({ id: 'class-1' });
});

describe('live editing switch — the route gate', () => {
  it('admits OWNER only and checks the classroom is open to writes', async () => {
    await toggle(true);

    expect(mocks.assertClassroomAccess).toHaveBeenCalledWith(
      expect.objectContaining({ classroomSlug: CLASS_SLUG, allowedRoles: ['OWNER'] })
    );
    expect(mocks.assertClassroomMutationAllowed).toHaveBeenCalledWith({
      status: 'ACTIVE',
      role: 'OWNER',
    });
  });

  it('writes nothing and calls nothing when the role gate refuses', async () => {
    mocks.assertClassroomAccess.mockRejectedValue(new Response('Forbidden', { status: 403 }));

    await expect(toggle(true)).rejects.toBeInstanceOf(Response);
    expect(mocks.classroomUpdate).not.toHaveBeenCalled();
    expect(mocks.notifyCollabFlag).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('writes nothing and calls nothing when the classroom is locked', async () => {
    gate({ collab_enabled: true, status: 'LOCKED' });
    mocks.assertClassroomMutationAllowed.mockImplementation(() => {
      throw new Response('Locked', { status: 403 });
    });

    await expect(toggle(false)).rejects.toBeInstanceOf(Response);
    expect(mocks.classroomUpdate).not.toHaveBeenCalled();
    expect(mocks.notifyCollabFlag).not.toHaveBeenCalled();
  });
});

describe('live editing switch — turning it on and off', () => {
  it('writes the column, then tells the collab server, then audits', async () => {
    const result = await toggle(true);

    expect(result).toEqual({ success: LIVE_EDITING_COPY.on, action: 'save-live-editing' });
    expect(mocks.classroomUpdate).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'class-1' },
      data: { collab_enabled: true },
      select: { id: true },
    });
    expect(mocks.notifyCollabFlag).toHaveBeenCalledExactlyOnceWith('class-1', true);
    expect(mocks.classroomUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.notifyCollabFlag.mock.invocationCallOrder[0]
    );
    expect(mocks.addClassroomAuditLog).toHaveBeenCalledExactlyOnceWith({
      classroomId: 'class-1',
      userId: 'owner-1',
      role: 'OWNER',
      action: 'UPDATE',
      resourceType: 'CONTENT_SETTINGS',
      resourceId: 'class-1',
      metadata: {
        tool: LIVE_EDITING_TOOL,
        field: 'collab_enabled',
        from: false,
        value: true,
        collab_notified: true,
      },
    });
  });

  it('turns off and says nothing more when the collab server took the change', async () => {
    gate({ collab_enabled: true });

    const result = await toggle(false);

    expect(result).toEqual({ success: LIVE_EDITING_COPY.off, action: 'save-live-editing' });
    expect(mocks.classroomUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { collab_enabled: false } })
    );
    expect(mocks.notifyCollabFlag).toHaveBeenCalledExactlyOnceWith('class-1', false);
  });

  it('still turns off when the collab server is unreachable, and says editors will reload', async () => {
    gate({ collab_enabled: true });
    mocks.notifyCollabFlag.mockResolvedValue({ ok: false });

    const result = await toggle(false);

    expect(result).toEqual({
      success: LIVE_EDITING_COPY.off,
      info: LIVE_EDITING_COPY.offPendingReload,
      action: 'save-live-editing',
    });
    expect(mocks.classroomUpdate).toHaveBeenCalledOnce();
    expect(mocks.addClassroomAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ value: false, collab_notified: false }),
      })
    );
  });

  it('still turns on when the collab server is unreachable', async () => {
    mocks.notifyCollabFlag.mockResolvedValue({ ok: false });

    const result = await toggle(true);

    expect(result).toEqual({ success: LIVE_EDITING_COPY.on, action: 'save-live-editing' });
    expect(mocks.classroomUpdate).toHaveBeenCalledOnce();
  });

  it('refuses to turn on when no collab server is configured', async () => {
    mocks.collabServerEnv.mockReturnValue(null);

    const result = await toggle(true);

    expect(result).toEqual({ error: LIVE_EDITING_COPY.unavailable, action: 'save-live-editing' });
    expect(mocks.classroomUpdate).not.toHaveBeenCalled();
    expect(mocks.notifyCollabFlag).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('can always turn off, even with no collab server configured', async () => {
    gate({ collab_enabled: true });
    mocks.collabServerEnv.mockReturnValue(null);
    mocks.notifyCollabFlag.mockResolvedValue({ ok: false });

    const result = await toggle(false);

    expect(result).toMatchObject({ success: LIVE_EDITING_COPY.off });
    expect(mocks.classroomUpdate).toHaveBeenCalledOnce();
  });

  it('is a no-op when the value does not change: no write, no collab call, no audit', async () => {
    gate({ collab_enabled: true });

    const result = await toggle(true);

    expect(result).toEqual({ success: LIVE_EDITING_COPY.on, action: 'save-live-editing' });
    expect(mocks.classroomUpdate).not.toHaveBeenCalled();
    expect(mocks.notifyCollabFlag).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('rejects a value that is not a boolean', async () => {
    const result = await toggle('yes');

    expect(result).toEqual({ error: LIVE_EDITING_COPY.invalid, action: 'save-live-editing' });
    expect(mocks.classroomUpdate).not.toHaveBeenCalled();
  });

  it('never routes the flag through the ClassroomSettings writer', async () => {
    await toggle(true);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });
});

describe('setLiveEditing — deps contract', () => {
  it('does not audit or notify when the column write fails', async () => {
    const deps = {
      collabAvailable: () => true,
      writeFlag: vi.fn(async () => {
        throw new Error('db down');
      }),
      notifyCollab: vi.fn(async () => ({ ok: true })),
      audit: vi.fn(async () => undefined),
    };

    await expect(
      setLiveEditing(
        {
          classroom: { id: 'c', collab_enabled: false },
          userId: 'u',
          role: 'OWNER',
          enabled: true,
        },
        deps
      )
    ).rejects.toThrow('db down');
    expect(deps.notifyCollab).not.toHaveBeenCalled();
    expect(deps.audit).not.toHaveBeenCalled();
  });
});
