/**
 * The student team page answers only for a published repository: a student
 * gets a 404 (loader) or the "not available" refusal (action) for an
 * unpublished one, and the page carries only the repository's title. Its
 * owner and teachers reach it either way.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  findRepository: vi.fn(),
  findTag: vi.fn(),
  tagUpsert: vi.fn(),
  findByTagId: vi.fn(),
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertClassroomMutationAllowed: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    repository: {
      findByClassroomSlugAndModuleSlug: (...a: unknown[]) => mocks.findRepository(...a),
    },
    organizationTag: {
      findByClassroomIdAndName: (...a: unknown[]) => mocks.findTag(...a),
      upsert: (...a: unknown[]) => mocks.tagUpsert(...a),
    },
    team: { findByTagId: (...a: unknown[]) => mocks.findByTagId(...a) },
  },
  getGitProvider: vi.fn(),
  isReservedSlug: () => false,
}));

vi.mock('@classmoji/database', () => ({ default: () => ({}), GIT_IDENTITY: {} }));
vi.mock('@trigger.dev/sdk/v3', () => ({ tasks: { trigger: vi.fn() } }));
vi.mock('@trigger.dev/sdk', () => ({ auth: { createPublicToken: vi.fn() } }));
vi.mock('@classmoji/ui-components', () => ({ useCallout: () => ({ show: vi.fn() }) }));
vi.mock('~/utils/classroomStatusModals', () => ({ useClassroomStatusModals: () => ({}) }));

const { loader, action } = await import('../route.tsx');

const REPO = {
  id: 'repo-1',
  title: 'Hidden Group',
  slug: 'hidden-group',
  template: 'template-repo',
  type: 'GROUP',
  team_formation_mode: 'SELF_FORMED',
  team_formation_deadline: null,
  max_team_size: 3,
  assignments: [{ id: 'a-1', title: 'Unreleased Assignment', is_published: false }],
};

const as = (role: string) =>
  mocks.assertClassroomAccess.mockResolvedValue({
    userId: 'user-1',
    classroom: { id: 'class-1', status: 'ACTIVE', git_organization: { provider: 'GITHUB' } },
    membership: { role },
  });

const args = (method = 'GET') =>
  ({
    params: { class: 'class-x', repo: 'hidden-group' },
    request: new Request('http://localhost/student/class-x/repos/hidden-group/team?/createTeam', {
      method,
      ...(method === 'POST'
        ? {
            body: JSON.stringify({ name: 'Blue' }),
            headers: { 'Content-Type': 'application/json' },
          }
        : {}),
    }),
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findTag.mockResolvedValue(null);
  mocks.findByTagId.mockResolvedValue([]);
});

describe('student team page', () => {
  it('is a 404 for a student while the repository is unpublished', async () => {
    as('STUDENT');
    mocks.findRepository.mockResolvedValue({ ...REPO, is_published: false });

    await expect(loader(args())).rejects.toMatchObject({ status: 404 });
  });

  it('refuses the team actions to a student while the repository is unpublished', async () => {
    as('STUDENT');
    mocks.findRepository.mockResolvedValue({ ...REPO, is_published: false });

    const result = await action(args('POST'));
    expect(result).toMatchObject({ error: expect.stringContaining('not available') });
    expect(mocks.tagUpsert).not.toHaveBeenCalled();
  });

  it('shows a published repository by its title only', async () => {
    as('STUDENT');
    mocks.findRepository.mockResolvedValue({ ...REPO, is_published: true });

    const result = (await loader(args())) as Record<string, unknown>;
    expect(result.repository).toEqual({ title: 'Hidden Group' });
    expect(JSON.stringify(result)).not.toContain('Unreleased Assignment');
    expect(JSON.stringify(result)).not.toContain('template-repo');
  });

  it("is open to the classroom's owner and teachers either way", async () => {
    for (const role of ['OWNER', 'TEACHER']) {
      as(role);
      mocks.findRepository.mockResolvedValue({ ...REPO, is_published: false });
      const result = (await loader(args())) as Record<string, unknown>;
      expect(result.repository).toEqual({ title: 'Hidden Group' });
    }
  });
});
