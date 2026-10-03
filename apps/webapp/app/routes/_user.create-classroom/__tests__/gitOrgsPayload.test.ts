/**
 * The git organizations the create-classroom page returns. The org picker
 * reads each org's id, login, avatar and classrooms; the loader selects those
 * (plus the provider id the avatar is looked up by) and returns the picker's
 * shape.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock('~/utils/aiFeatures.server', () => ({ isAIAgentConfigured: () => false }));

vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: vi.fn().mockResolvedValue({ userId: 'user-1', token: 'gh-token' }),
  clearRevokedToken: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    user: { findById: vi.fn().mockResolvedValue({ id: 'user-1', login: 'instructor' }) },
    gitOrganization: {
      syncUserInstallations: vi.fn().mockResolvedValue([
        {
          provider_id: '4242',
          avatar_url: 'https://avatars.githubusercontent.com/u/4242?v=4',
          github_installation_id: '999',
        },
      ]),
    },
    subscription: {
      getCurrent: vi.fn().mockResolvedValue({ id: null, tier: 'FREE' }),
      isSubscriptionActive: vi.fn(() => false),
    },
  },
  GitHubProvider: {
    getUserOctokit: () => ({
      rest: {
        users: { getAuthenticated: vi.fn().mockResolvedValue({ data: { login: 'instructor' } }) },
      },
    }),
  },
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    // A Github-connected creator: the Github side of the form.
    account: { findMany: vi.fn().mockResolvedValue([{ provider_id: 'github' }]) },
    gitOrganization: { findMany: (...a: unknown[]) => mocks.findMany(...a) },
    classroom: { findMany: vi.fn().mockResolvedValue([]) },
  }),
}));

// The Gitlab side of the form is not under test: Gitlab is not configured.
vi.mock('../gitlabOptions.server', () => ({
  loadGitLabOptions: async () => ({
    enabled: false,
    connection: null,
    host: null,
    groups: [],
    error: null,
  }),
}));

// Only the loader is under test; the wizard only needs to import.
vi.mock('~/hooks', () => ({
  useGlobalFetcher: () => ({}),
  useGitHubAppInstallPopup: () => ({}),
}));
vi.mock('~/constants', () => ({ ActionTypes: {} }));
vi.mock('../StepBasicInfo', () => ({ default: () => null }));
vi.mock('../action', () => ({ action: vi.fn() }));

const { loader } = await import('../route.tsx');

const FULL_ROW = {
  id: 'org-1',
  provider: 'GITHUB',
  provider_id: '4242',
  login: 'test-org',
  base_url: null,
  github_installation_id: '999',
  access_token: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
  classrooms: [{ id: 'class-1', slug: 'cs-1', name: 'CS 1' }],
};

beforeEach(() => {
  mocks.findMany.mockReset().mockResolvedValue([FULL_ROW]);
});

describe('create-classroom git organizations payload', () => {
  it('selects only what the picker and the avatar lookup need', async () => {
    await loader({
      request: new Request('http://localhost/create-classroom'),
      params: {},
    } as never);

    const { select, include } = mocks.findMany.mock.calls[0][0];
    expect(include).toBeUndefined();
    expect(Object.keys(select).sort()).toEqual(['classrooms', 'id', 'login', 'provider_id']);
  });

  it('sends each org as id, login, avatar and classrooms', async () => {
    const data = (await loader({
      request: new Request('http://localhost/create-classroom'),
      params: {},
    } as never)) as { gitOrgs: unknown[] };

    expect(data.gitOrgs).toEqual([
      {
        id: 'org-1',
        login: 'test-org',
        avatar_url: 'https://avatars.githubusercontent.com/u/4242?v=4',
        classrooms: [{ id: 'class-1', slug: 'cs-1', name: 'CS 1' }],
      },
    ]);
  });
});
