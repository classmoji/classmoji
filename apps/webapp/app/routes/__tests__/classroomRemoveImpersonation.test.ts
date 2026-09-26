/**
 * Unit tests for the danger-zone classroom removal (admin.$class.settings.danger-zone)
 * while a platform admin is viewing as another user.
 *
 * The session and its GitHub token then belong to the viewed user, and removal
 * cannot be undone, so the action removes nothing: neither the GitHub cleanup
 * (which runs with the session user's token) nor the classroom itself. The
 * loader reports the state so the page can say why the button is off. Outside
 * that case the removal still runs as before.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomAdmin: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  getAuthSession: vi.fn(),
  deleteGitHubArtifacts: vi.fn(),
  deleteById: vi.fn(),
  getPlan: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomAdmin: (...a: unknown[]) => mocks.requireClassroomAdmin(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
}));

vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: (...a: unknown[]) => mocks.getAuthSession(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroom: {
      deleteGitHubArtifacts: (...a: unknown[]) => mocks.deleteGitHubArtifacts(...a),
      deleteById: (...a: unknown[]) => mocks.deleteById(...a),
      getClassroomGitHubArtifactPlan: (...a: unknown[]) => mocks.getPlan(...a),
    },
  },
}));

// The action and loader are what is under test; the view only needs to import.
vi.mock('antd', () => ({ Button: () => null, Checkbox: () => null, Modal: () => null }));
vi.mock('~/hooks', () => ({
  useGlobalFetcher: () => ({ fetcher: null, notify: vi.fn() }),
  useDisclosure: () => ({ show: vi.fn(), close: vi.fn(), visible: false }),
}));
vi.mock('react-router', () => ({
  useParams: () => ({}),
  redirect: (url: string) => new Response(null, { status: 302, headers: { Location: url } }),
}));

const route = await import('../admin.$class.settings.danger-zone/route.tsx');

const CLASS_SLUG = 'cs52-26f';
const USER_TOKEN = 'ghu_session_token';
const VIEWING_AS = {
  userId: 'owner-1',
  token: USER_TOKEN,
  session: { session: { impersonatedBy: 'platform-admin-1' } },
};

const remove = (deleteGitHub: boolean) => {
  const body = new FormData();
  body.set('delete_github', deleteGitHub ? 'true' : 'false');
  return route.action({
    params: { class: CLASS_SLUG },
    request: new Request(
      `http://localhost/admin/${CLASS_SLUG}/settings/danger-zone?/removeClassroom`,
      { method: 'POST', body }
    ),
  } as unknown as Parameters<typeof route.action>[0]) as Promise<unknown>;
};

const load = () =>
  route.loader({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/admin/${CLASS_SLUG}/settings/danger-zone`),
  } as unknown as Parameters<typeof route.loader>[0]) as Promise<Record<string, unknown>>;

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.requireClassroomAdmin.mockResolvedValue({
    userId: 'owner-1',
    classroom: { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE' },
    membership: { role: 'OWNER' },
  });
  mocks.getAuthSession.mockResolvedValue({ userId: 'owner-1', token: USER_TOKEN });
  mocks.deleteGitHubArtifacts.mockResolvedValue({
    deleted_repos: 1,
    deleted_teams: 0,
    skipped: 0,
    failures: [],
  });
  mocks.deleteById.mockResolvedValue(undefined);
  mocks.getPlan.mockResolvedValue({ artifacts: [], withheld: null });
});

describe('classroom removal while viewing as another user', () => {
  beforeEach(() => {
    mocks.getAuthSession.mockResolvedValue(VIEWING_AS);
  });

  it('refuses a removal that includes GitHub cleanup, and removes nothing', async () => {
    const result = await remove(true);

    expect(result).toEqual({
      action: 'remove-classroom',
      error: "Deleting GitHub artifacts isn't available while viewing as another user.",
    });
    expect(mocks.deleteGitHubArtifacts).not.toHaveBeenCalled();
    expect(mocks.deleteById).not.toHaveBeenCalled();
  });

  it('refuses a classroom-only removal too, since it cannot be undone', async () => {
    const result = await remove(false);

    expect(result).toEqual({
      action: 'remove-classroom',
      error: "Removing a classroom isn't available while viewing as another user.",
    });
    expect(mocks.deleteById).not.toHaveBeenCalled();
  });

  it('reports the state to the page', async () => {
    expect(await load()).toMatchObject({ impersonating: true });
  });
});

describe('classroom removal as yourself', () => {
  it('runs the GitHub cleanup with your token, then removes the classroom', async () => {
    const result = (await remove(true)) as Response;

    expect(mocks.deleteGitHubArtifacts).toHaveBeenCalledWith('class-1', USER_TOKEN);
    expect(mocks.deleteById).toHaveBeenCalledWith('class-1');
    expect(result.status).toBe(302);
  });

  it('removes only the classroom when GitHub cleanup is not requested', async () => {
    await remove(false);

    expect(mocks.deleteGitHubArtifacts).not.toHaveBeenCalled();
    expect(mocks.deleteById).toHaveBeenCalledWith('class-1');
  });

  it('reports the page as usable', async () => {
    expect(await load()).toMatchObject({ impersonating: false });
  });
});
